import { getWorld, getRun, type Run } from "#internal/workflow/runtime.js";

import { mintSubagentContinuationToken } from "#execution/session.js";
import {
  fenceSubagentControlMailbox,
  readSubagentControlLineageMailbox,
  resolveSubagentWaitState,
} from "#features/subagent-supervision/messages.js";
import { controlMessageId } from "#features/subagent-supervision/message-format.js";
import { resolveDirectSubagentLineage } from "#features/subagent-supervision/lineage.js";
import { resolveSessionTurnLineage } from "#features/subagent-supervision/turn-lineage.js";
import {
  deliverSubagentControlMessage,
  subagentDeliveryLockToken,
} from "#features/subagent-supervision/delivery-coordinator.js";
import {
  cancelAcknowledgedSubagentTurn,
  cancelSubagentWorkflowRun,
} from "#features/subagent-supervision/cancellation-runtime.js";
import {
  decodeCursor,
  encodeCursor,
  initialCursor,
  normalizeCursor,
} from "#features/subagent-supervision/cursor.js";
import { cleanupCancelledSubagentSandbox } from "#features/subagent-supervision/sandbox-cleanup.js";
import type {
  ChildCancelResult,
  ChildCancelSessionResult,
  ChildError,
  ChildEventType,
  ChildLifecycleStatus,
  ChildObservableAction,
  ChildSessionEvent,
  ChildSessionStreamEvent,
  ChildSessionHandle,
  ChildSnapshot,
  ChildWaitResult,
  SubagentController,
} from "#public/definitions/subagent-control.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

interface WorkflowRunRecord {
  readonly attributes: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly status: ChildLifecycleStatus;
}

interface ControllerOptions {
  readonly abortSignal: AbortSignal;
  readonly callerSessionId: string;
}

const TERMINAL_STATUSES = new Set<ChildLifecycleStatus>(["completed", "failed", "cancelled"]);
const EVENT_WINDOW_CHUNKS = 256;
const INSPECTION_WINDOW_CHUNKS = 2_048;

/** Builds the public descendant controller for one authored tool call. */
export function createSubagentController(options: ControllerOptions): SubagentController {
  return {
    async get(childSessionId: string): Promise<ChildSessionHandle> {
      const normalizedId = childSessionId.trim();
      if (normalizedId.length === 0) throw new Error("childSessionId is required");

      await authorizeDescendant(options.callerSessionId, normalizedId);

      return createChildSessionHandle({ ...options, childSessionId: normalizedId });
    },
  };
}

function createChildSessionHandle(
  options: ControllerOptions & { readonly childSessionId: string },
): ChildSessionHandle {
  return {
    async snapshot(snapshotOptions): Promise<ChildSnapshot> {
      await authorizeDescendant(options.callerSessionId, options.childSessionId);
      const requestedCursor = decodeCursor(snapshotOptions?.after ?? initialCursor());
      return await buildSnapshot(
        options.childSessionId,
        requestedCursor,
        snapshotOptions?.after === undefined ? undefined : requestedCursor,
      );
    },

    async wait(waitOptions): Promise<ChildWaitResult> {
      await authorizeDescendant(options.callerSessionId, options.childSessionId);
      return await waitForChild(options, waitOptions);
    },

    async send(input) {
      const child = await authorizeDescendant(options.callerSessionId, options.childSessionId);
      if (TERMINAL_STATUSES.has(child.status)) {
        throw new Error(`Cannot send to terminal child ${options.childSessionId}`);
      }

      const parentSessionId = child.attributes["$eve.parent"];
      const callId = child.attributes["$eve.parent_call"];
      if (!parentSessionId || !callId) {
        throw new Error(`Child ${options.childSessionId} has incomplete parent lineage`);
      }

      const messageId = controlMessageId(input.idempotencyKey);
      const lockToken = await subagentDeliveryLockToken(options.childSessionId, messageId);
      return await deliverSubagentControlMessage({
        childSessionId: options.childSessionId,
        continuationToken: mintSubagentContinuationToken(`${parentSessionId}:${callId}`),
        idempotencyKey: input.idempotencyKey,
        lockToken,
        message: input.message,
        messageId,
      });
    },

    async cancel(): Promise<ChildCancelResult> {
      await authorizeDescendant(options.callerSessionId, options.childSessionId);
      return await cancelDescendantTree(options.childSessionId, options.abortSignal);
    },
  };
}

async function buildSnapshot(
  childSessionId: string,
  requestedCursor: number,
  eventStartIndex?: number,
): Promise<ChildSnapshot> {
  normalizeCursor(requestedCursor);
  const record = await getWorkflowRunRecord(childSessionId);
  const run = getRun<{ readonly output?: unknown }>(childSessionId);
  let status = normalizeStatus(String(await run.status));
  let history = await readFiniteEvents(run, eventStartIndex);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latestStatus = normalizeStatus(String(await run.status));
    if (latestStatus === status) break;
    status = latestStatus;
    history = await readFiniteEvents(run, eventStartIndex);
  }
  const { events, nextCursor } = history;
  if (requestedCursor > nextCursor) {
    throw new Error(
      `Cursor ${requestedCursor} is beyond the current child stream tail ${nextCursor}`,
    );
  }
  const terminal = await terminalResult(run, status, events);
  const waitingEvent = [...events]
    .reverse()
    .find((event) => event.type === "session.waiting");
  const latestReceived = [...events]
    .reverse()
    .find((event) => event.type === "message.received");

  return {
    schemaVersion: 1,
    agent: {
      id: record.attributes["$eve.subagent"] || childSessionId,
      name: record.attributes["$eve.subagent"] || undefined,
    },
    childSessionId,
    events,
    nextCursor: encodeCursor(nextCursor),
    status,
    ...(terminal === undefined ? {} : { terminal }),
    ...(waitingEvent === undefined ||
    terminal !== undefined ||
    (latestReceived !== undefined && latestReceived.index > waitingEvent.index)
      ? {}
      : { waiting: { reason: "next-user-message" as const } }),
  };
}

async function readFiniteEvents(
  run: Run<unknown>,
  requestedStartIndex?: number,
): Promise<{ readonly events: ChildSessionStreamEvent[]; readonly nextCursor: number }> {
  const startIndex = requestedStartIndex ?? 0;
  const windowSize = requestedStartIndex === undefined ? INSPECTION_WINDOW_CHUNKS : EVENT_WINDOW_CHUNKS;
  const stream = run.getReadable<Uint8Array>({ startIndex });
  const tailIndex = await stream.getTailIndex();
  if (tailIndex < startIndex) {
    await stream.cancel();
    return { events: [], nextCursor: Math.max(0, tailIndex + 1) };
  }
  if (requestedStartIndex === undefined && tailIndex >= windowSize) {
    await stream.cancel();
    throw new Error(`Child inspection exceeds the ${windowSize}-chunk safety limit`);
  }

  const reader = stream.getReader();
  const events: ChildSessionStreamEvent[] = [];
  const endIndex = Math.min(tailIndex, startIndex + windowSize - 1);
  try {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const item = await reader.read();
      if (item.done) break;
      for (const event of parseEventChunk(item.value)) {
        const value = observableEvent(event);
        if (value !== undefined) {
          events.push({
            ...value,
            ...(event.meta?.at === undefined ? {} : { at: event.meta.at }),
            index,
          });
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  return { events, nextCursor: endIndex + 1 };
}

function parseEventChunk(value: Uint8Array): HandleMessageStreamEvent[] {
  const text = new TextDecoder().decode(value);
  const events: HandleMessageStreamEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (isHandleMessageStreamEvent(parsed)) events.push(parsed);
  }
  return events;
}

function isHandleMessageStreamEvent(value: unknown): value is HandleMessageStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { readonly type?: unknown }).type === "string"
  );
}

function observableEvent(
  event: HandleMessageStreamEvent,
): ChildSessionEvent | undefined {
  if (event.type === "reasoning.appended") {
    return undefined;
  }
  if (event.type === "message.received") {
    return { data: { message: event.data.message }, type: event.type };
  }
  if (event.type === "message.completed") {
    return {
      data: {
        finishReason: event.data.finishReason,
        message: event.data.message,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "result.completed") {
    return {
      data: {
        result: event.data.result,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "reasoning.completed") {
    return {
      data: {
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "step.started") {
    return {
      data: {
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "step.completed") {
    return {
      data: {
        finishReason: event.data.finishReason,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "step.failed") {
    return {
      data: {
        code: event.data.code,
        message: event.data.message,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "turn.completed") {
    return {
      data: { sequence: event.data.sequence, turnId: event.data.turnId },
      type: event.type,
    };
  }
  if (event.type === "turn.failed") {
    return {
      data: {
        code: event.data.code,
        message: event.data.message,
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "actions.requested") {
    const actions: ChildObservableAction[] = [];
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") {
        actions.push({
          callId: action.callId,
          input: action.input,
          kind: action.kind,
          toolName: action.toolName,
        });
      }
      if (action.kind === "subagent-call") {
        actions.push({
          callId: action.callId,
          input: action.input,
          kind: action.kind,
          subagentName: action.subagentName,
        });
      }
    }
    return { data: { actions }, type: event.type };
  }
  if (event.type === "subagent.called") {
    return {
      data: {
        callId: event.data.callId,
        childSessionId: event.data.childSessionId,
      },
      type: event.type,
    };
  }
  if (event.type === "action.result") {
    return {
      data: {
        ...(event.data.error === undefined
          ? {}
          : {
              error: {
                code: event.data.error.code,
                message: event.data.error.message,
              },
            }),
        result: {
          callId: event.data.result.callId,
          ...(event.data.result.isError === undefined
            ? {}
            : { isError: event.data.result.isError }),
          kind: event.data.result.kind,
          output: event.data.result.output,
        },
        status: event.data.status,
      },
      type: event.type,
    };
  }
  if (event.type === "input.requested") {
    return {
      data: {
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "session.waiting") {
    return { data: { wait: event.data.wait }, type: event.type };
  }
  if (event.type === "session.failed") {
    return {
      data: {
        code: event.data.code,
        message: event.data.message,
      },
      type: event.type,
    };
  }
  return { data: { originalType: event.type }, type: "unknown" };
}

async function terminalResult(
  run: Run<{ readonly output?: unknown }>,
  status: ChildLifecycleStatus,
  events: readonly ChildSessionStreamEvent[],
): Promise<ChildSnapshot["terminal"]> {
  if (status === "completed") {
    const result = await run.returnValue;
    return {
      outcome: "completed",
      output:
        typeof result === "object" && result !== null && "output" in result
          ? result.output
          : result,
    };
  }

  const failure = [...events].reverse().find((event) => event.type === "session.failed");
  const error = failure === undefined ? undefined : sessionFailure(failure);

  if (status === "failed") {
    return {
      outcome: "failed",
      error: error ?? { code: "CHILD_FAILED", message: "The child session failed." },
    };
  }
  if (status === "cancelled") {
    return { outcome: "cancelled", ...(error === undefined ? {} : { error }) };
  }
  return undefined;
}

function sessionFailure(event: ChildSessionEvent): ChildError | undefined {
  if (event.type !== "session.failed") return undefined;
  return {
    code: event.data.code,
    message: event.data.message,
  };
}

async function waitForChild(
  options: ControllerOptions & { readonly childSessionId: string },
  input: {
    readonly after: string;
    readonly eventTypes?: readonly ChildEventType[];
    readonly idempotencyKey: string;
    readonly timeoutMs: number;
  },
): Promise<ChildWaitResult> {
  decodeCursor(input.after);
  const timeoutMs = Math.max(1, Math.min(60_000, Math.floor(input.timeoutMs)));
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new Error("wait idempotencyKey is required");
  const waitState = await resolveSubagentWaitState({
    after: input.after,
    callerSessionId: options.callerSessionId,
    operationId: `${options.childSessionId}\0${idempotencyKey}`,
    timeoutMs,
  });
  const initialIndex = decodeCursor(waitState.after);
  const deadline = waitState.deadlineAt;
  const initial = await buildSnapshot(options.childSessionId, initialIndex, initialIndex);
  const initialStatus = initial.status;
  const eventTypes = input.eventTypes === undefined ? undefined : new Set(input.eventTypes);
  if (Date.now() >= deadline) {
    return { reason: "timeout", snapshot: initial, timedOut: true };
  }
  const immediateReason = snapshotWakeReason(initial, initialStatus, eventTypes, initialIndex);
  if (immediateReason !== undefined) {
    return { reason: immediateReason, snapshot: initial, timedOut: false };
  }

  let cursor = decodeCursor(initial.nextCursor);
  while (Date.now() < deadline && !options.abortSignal.aborted) {
    await delay(Math.min(250, deadline - Date.now()), options.abortSignal);
    const latest = await buildSnapshot(options.childSessionId, cursor, cursor);
    const reason = snapshotWakeReason(latest, initialStatus, eventTypes, cursor);
    if (reason !== undefined) {
      return { reason, snapshot: latest, timedOut: false };
    }
    cursor = decodeCursor(latest.nextCursor);
  }

  const finalSnapshot = await buildSnapshot(options.childSessionId, initialIndex);
  if (options.abortSignal.aborted) {
    return { reason: "cancelled", snapshot: finalSnapshot, timedOut: false };
  }

  return {
    reason: "timeout",
    snapshot: finalSnapshot,
    timedOut: true,
  };
}

function snapshotWakeReason(
  snapshot: ChildSnapshot,
  initialStatus: ChildLifecycleStatus,
  eventTypes: ReadonlySet<ChildEventType> | undefined,
  observedFromCursor: number,
): ChildWaitResult["reason"] | undefined {
  if (snapshot.terminal !== undefined) return "terminal";
  if (snapshot.status !== initialStatus) return "lifecycle";
  if (
    snapshot.events.some(
      (event) =>
        event.index >= observedFromCursor &&
        (eventTypes === undefined || eventTypes.has(event.type)),
    )
  ) {
    return "event";
  }
  return undefined;
}

async function authorizeDescendant(
  callerSessionId: string,
  childSessionId: string,
): Promise<WorkflowRunRecord> {
  let current = await getWorkflowRunRecord(childSessionId);
  const child = current;
  const visited = new Set<string>([childSessionId]);

  while (true) {
    const parentSessionId = current.attributes["$eve.parent"];
    if (!parentSessionId) break;
    if (parentSessionId === callerSessionId) return child;
    if (visited.has(parentSessionId)) break;
    visited.add(parentSessionId);
    current = await getWorkflowRunRecord(parentSessionId);
  }

  throw new Error(`Session ${childSessionId} is not a descendant of ${callerSessionId}`);
}

async function getWorkflowRunRecord(runId: string): Promise<WorkflowRunRecord> {
  const world = await getWorld();
  const raw: unknown = await world.runs.get(runId, { resolveData: "none" });
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Workflow run ${runId} was not found`);
  }
  const record = raw as {
    readonly attributes?: unknown;
    readonly runId?: unknown;
    readonly status?: unknown;
  };
  if (typeof record.runId !== "string") {
    throw new Error(`Workflow run ${runId} has no run id`);
  }
  return {
    attributes: stringRecord(record.attributes),
    runId: record.runId,
    status: normalizeStatus(String(record.status ?? "unknown")),
  };
}

async function cancelDescendantTree(
  childSessionId: string,
  abortSignal: AbortSignal,
): Promise<ChildCancelResult> {
  let ordered: readonly FencedSession[] | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const discovered = await discoverFencedDescendantTree(childSessionId);
    if (discovered.unresolved.length === 0) {
      ordered = discovered.ordered;
      break;
    }
    await delay(100, abortSignal);
    if (abortSignal.aborted) throw new Error(`Stopping ${childSessionId} was aborted`);
  }
  if (ordered === undefined) {
    throw new Error(`Descendant lineage for ${childSessionId} did not settle before cancellation`);
  }

  const sessions: ChildCancelSessionResult[] = [];
  for (const session of ordered) {
    for (const turn of session.turns) {
      await cancelAcknowledgedSubagentTurn({
        abortSignal,
        ancestorSessionId: childSessionId,
        fenceSequence: session.fenceSequence,
        sessionId: session.sessionId,
        turn,
      });
    }

    const statusBefore = (await getWorkflowRunRecord(session.sessionId)).status;
    if (!TERMINAL_STATUSES.has(statusBefore)) {
      await cancelSubagentWorkflowRun(session.sessionId, childSessionId);
    }
    const statusAfter = (await getWorkflowRunRecord(session.sessionId)).status;
    if (statusAfter === "cancelled") {
      await cleanupCancelledSubagentSandbox(session.sessionId);
    }
    sessions.push({
      childSessionId: session.sessionId,
      statusAfter,
      statusBefore,
    });
  }
  return { sessions };
}

async function delay(timeoutMs: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted || timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

interface FencedSession {
  readonly fenceSequence: number;
  readonly sessionId: string;
  readonly turns: readonly {
    readonly turnId: string;
    readonly turnRunId: string;
  }[];
}

async function discoverFencedDescendantTree(rootSessionId: string): Promise<{
  readonly ordered: readonly FencedSession[];
  readonly unresolved: readonly string[];
}> {
  const ordered: FencedSession[] = [];
  const unresolved: string[] = [];
  const visited = new Set<string>();

  const visit = async (sessionId: string): Promise<void> => {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    await fenceSubagentControlMailbox(sessionId, "cancelled");

    const mailbox = await readSubagentControlLineageMailbox(sessionId);
    if (mailbox.fence === undefined) {
      unresolved.push(`${sessionId}:fence`);
      return;
    }
    const lineage = resolveDirectSubagentLineage({
      mailbox,
      parentSessionId: sessionId,
    });
    const turns = resolveSessionTurnLineage(sessionId, mailbox);
    unresolved.push(...lineage.unresolved, ...turns.unresolved);
    for (const childId of lineage.children) await visit(childId);
    ordered.push({
      fenceSequence: mailbox.fence.sequence,
      sessionId,
      turns: turns.turnRuns,
    });
  };

  await visit(rootSessionId);
  return { ordered, unresolved };
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function normalizeStatus(value: string): ChildLifecycleStatus {
  switch (value) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}
