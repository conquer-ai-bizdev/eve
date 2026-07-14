import { getWorld, getRun, type Run } from "#internal/workflow/runtime.js";

import { mintSubagentContinuationToken } from "#execution/session.js";
import { SUBAGENT_MAX_WAIT_TIMEOUT_MS } from "#features/subagent-supervision/capability.js";
import { resolveSubagentWaitState } from "#features/subagent-supervision/messages.js";
import { controlMessageId } from "#features/subagent-supervision/message-format.js";
import {
  deliverSubagentControlMessage,
  subagentDeliveryLockToken,
} from "#features/subagent-supervision/delivery-coordinator.js";
import { releaseSessionTree } from "#execution/release-participants.js";
import {
  decodeCursor,
  encodeCursor,
  initialCursor,
  normalizeCursor,
} from "#features/subagent-supervision/cursor.js";
import { readFiniteEvents } from "#features/subagent-supervision/session-stream.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type {
  ChildCancelResult,
  ChildCancelSessionResult,
  ChildError,
  ChildEventType,
  ChildLifecycleStatus,
  ChildSessionEvent,
  ChildSessionStreamEvent,
  ChildSessionHandle,
  ChildSnapshot,
  ChildWaitResult,
  SubagentController,
} from "#public/definitions/subagent-control.js";

interface WorkflowRunRecord {
  readonly attributes: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly status: ChildLifecycleStatus;
}

interface ControllerOptions {
  readonly abortSignal: AbortSignal;
  readonly callerSessionId: string;
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
}

const TERMINAL_STATUSES = new Set<ChildLifecycleStatus>(["completed", "failed", "cancelled"]);

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
      return await cancelDescendantTree(
        options.childSessionId,
        options.abortSignal,
        options.compiledArtifactsSource,
      );
    },
  };
}

async function buildSnapshot(
  childSessionId: string,
  requestedCursor: number,
  eventStartIndex?: number,
  tailFromStart = false,
): Promise<ChildSnapshot> {
  normalizeCursor(requestedCursor);
  const record = await getWorkflowRunRecord(childSessionId);
  const run = getRun<{ readonly output?: unknown }>(childSessionId);
  let status = normalizeStatus(String(await run.status));
  let history = await readFiniteEvents(run, eventStartIndex, tailFromStart);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latestStatus = normalizeStatus(String(await run.status));
    if (latestStatus === status) break;
    status = latestStatus;
    history = await readFiniteEvents(run, eventStartIndex, tailFromStart);
  }
  const { events, nextCursor } = history;
  if (requestedCursor > nextCursor) {
    throw new Error(
      `Cursor ${requestedCursor} is beyond the current child stream tail ${nextCursor}`,
    );
  }
  const terminal = await terminalResult(run, status, events);
  const waitingEvent = [...events].reverse().find((event) => event.type === "session.waiting");
  const latestReceived = [...events].reverse().find((event) => event.type === "message.received");

  const snapshot: ChildSnapshot = {
    schemaVersion: 1,
    agent: {
      id: record.attributes["$eve.subagent"] || childSessionId,
      name: record.attributes["$eve.subagent"] || undefined,
    },
    childSessionId,
    events,
    nextCursor: encodeCursor(nextCursor),
    status,
  };
  if (history.omittedBeforeIndex !== undefined) {
    Object.assign(snapshot, { omittedBeforeIndex: history.omittedBeforeIndex });
  }
  if (terminal !== undefined) Object.assign(snapshot, { terminal });
  if (
    waitingEvent !== undefined &&
    terminal === undefined &&
    (latestReceived === undefined || latestReceived.index <= waitingEvent.index)
  ) {
    Object.assign(snapshot, { waiting: { reason: "next-user-message" as const } });
  }
  return snapshot;
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
    if (error === undefined) return { outcome: "cancelled" };
    return { outcome: "cancelled", error };
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
  const timeoutMs = Math.max(
    1,
    Math.min(SUBAGENT_MAX_WAIT_TIMEOUT_MS, Math.floor(input.timeoutMs)),
  );
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
    return {
      reason: immediateReason,
      snapshot: await buildSnapshot(options.childSessionId, initialIndex, initialIndex, true),
      timedOut: false,
    };
  }

  let cursor = decodeCursor(initial.nextCursor);
  while (Date.now() < deadline && !options.abortSignal.aborted) {
    await delay(Math.min(250, deadline - Date.now()), options.abortSignal);
    const latest = await buildSnapshot(options.childSessionId, cursor, cursor);
    const reason = snapshotWakeReason(latest, initialStatus, eventTypes, cursor);
    if (reason !== undefined) {
      return {
        reason,
        snapshot: await buildSnapshot(options.childSessionId, initialIndex, initialIndex, true),
        timedOut: false,
      };
    }
    cursor = decodeCursor(latest.nextCursor);
  }

  const finalSnapshot = await buildSnapshot(
    options.childSessionId,
    initialIndex,
    initialIndex,
    true,
  );
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
  compiledArtifactsSource?: RuntimeCompiledArtifactsSource,
): Promise<ChildCancelResult> {
  const bundle =
    compiledArtifactsSource === undefined
      ? undefined
      : await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const released = await releaseSessionTree({
    abortSignal,
    bundle,
    cancelRoot: true,
    reason: "cancelled",
    sessionId: childSessionId,
  });
  const sessions: ChildCancelSessionResult[] = released.sessions.map((session) => ({
    childSessionId: session.sessionId,
    statusAfter: session.statusAfter,
    statusBefore: session.statusBefore,
  }));
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
