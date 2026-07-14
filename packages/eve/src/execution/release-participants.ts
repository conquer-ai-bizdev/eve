import { dispatchReleaseHooks } from "#context/hook-lifecycle.js";
import {
  cancelAcknowledgedSubagentTurn,
  cancelSubagentWorkflowRun,
} from "#features/subagent-supervision/cancellation-runtime.js";
import { resolveDirectSubagentLineage } from "#features/subagent-supervision/lineage.js";
import {
  fenceSubagentControlMailbox,
  readSubagentControlLineageMailbox,
} from "#features/subagent-supervision/messages.js";
import { resolveSessionTurnLineage } from "#features/subagent-supervision/turn-lineage.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ReleaseReason } from "#public/definitions/hook.js";
import type { ChildLifecycleStatus } from "#public/definitions/subagent-control.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const log = createLogger("execution.release-participants");
const TERMINAL_STATUSES = new Set<ChildLifecycleStatus>(["completed", "failed", "cancelled"]);

interface WorkflowRunRecord {
  readonly attributes: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly status: ChildLifecycleStatus;
}

export interface ReleasedSession {
  readonly sessionId: string;
  readonly statusAfter: ChildLifecycleStatus;
  readonly statusBefore: ChildLifecycleStatus;
}

export interface ReleaseTreeResult {
  readonly sessions: readonly ReleasedSession[];
}

/** Releases descendants created by one completed root request, then releases the root runtime. */
export async function releaseRequestParticipants(input: {
  readonly abortSignal: AbortSignal;
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly reason: ReleaseReason;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<ReleaseTreeResult> {
  const sessions: ReleasedSession[] = [];
  const errors: unknown[] = [];
  let requestSafeToRelease = true;
  let directChildren: readonly string[] = [];

  try {
    directChildren = await directChildrenForTurn({
      abortSignal: input.abortSignal,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  } catch (error) {
    requestSafeToRelease = false;
    errors.push(error);
    logError(log, "failed to resolve request descendants", error, {
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  }

  for (const childSessionId of directChildren) {
    try {
      const released = await releaseSessionTree({
        abortSignal: input.abortSignal,
        bundle: input.bundle,
        cancelRoot: true,
        reason: input.reason,
        sessionId: childSessionId,
      });
      sessions.push(...released.sessions);
    } catch (error) {
      requestSafeToRelease = false;
      errors.push(error);
      logError(log, "failed to release request descendant tree", error, {
        childSessionId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
    }
  }

  if (requestSafeToRelease) {
    await dispatchSessionRelease({
      bundle: input.bundle,
      fallbackNodeId: input.bundle.nodeId,
      reason: input.reason,
      sessionId: input.sessionId,
    });
  } else {
    log.error("skipping root release because a request participant is still active", {
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  }

  throwReleaseErrors(errors, `Request participant release failed for ${input.sessionId}`);
  return { sessions };
}

/** Fences and releases one session tree deepest-first using its durable spawn records. */
export async function releaseSessionTree(input: {
  readonly abortSignal: AbortSignal;
  readonly bundle?: CompiledRuntimeAgentBundle;
  readonly cancelRoot: boolean;
  readonly reason: ReleaseReason;
  readonly sessionId: string;
}): Promise<ReleaseTreeResult> {
  let ordered: readonly FencedSession[];
  try {
    ordered = await settleFencedTree(input);
  } catch (error) {
    if (input.cancelRoot) {
      try {
        await cancelSubagentWorkflowRun(input.sessionId, input.sessionId);
      } catch (cancelError) {
        throw new AggregateError(
          [error, cancelError],
          `Session tree release failed for ${input.sessionId}`,
        );
      }
    }
    throw error;
  }
  const sessions: ReleasedSession[] = [];
  const errors: unknown[] = [];
  const unsafeSessions = new Set<string>();

  for (const session of ordered) {
    let safeToRelease = !unsafeSessions.has(session.sessionId);
    for (const turn of session.turns) {
      try {
        await cancelAcknowledgedSubagentTurn({
          abortSignal: input.abortSignal,
          ancestorSessionId: input.sessionId,
          fenceSequence: session.fenceSequence,
          sessionId: session.sessionId,
          turn,
        });
      } catch (error) {
        safeToRelease = false;
        errors.push(error);
        logError(log, "failed to cancel active descendant turn", error, {
          ancestorSessionId: input.sessionId,
          sessionId: session.sessionId,
          turnId: turn.turnId,
          turnRunId: turn.turnRunId,
        });
      }
    }

    let before: WorkflowRunRecord | undefined;
    try {
      before = await getWorkflowRunRecord(session.sessionId);
    } catch (error) {
      errors.push(error);
      logError(log, "failed to read session status before release", error, {
        ancestorSessionId: input.sessionId,
        sessionId: session.sessionId,
      });
    }

    if (
      (session.sessionId !== input.sessionId || input.cancelRoot) &&
      (before === undefined || !TERMINAL_STATUSES.has(before.status))
    ) {
      try {
        await cancelSubagentWorkflowRun(session.sessionId, input.sessionId);
        await waitForTerminalSession(session.sessionId, input.abortSignal);
      } catch (error) {
        safeToRelease = false;
        errors.push(error);
        logError(log, "failed to cancel descendant session", error, {
          ancestorSessionId: input.sessionId,
          sessionId: session.sessionId,
        });
      }
    }
    let after: WorkflowRunRecord | undefined;
    try {
      after = await getWorkflowRunRecord(session.sessionId);
    } catch (error) {
      errors.push(error);
      logError(log, "failed to read session status after release", error, {
        ancestorSessionId: input.sessionId,
        sessionId: session.sessionId,
      });
    }
    if (safeToRelease && input.bundle !== undefined) {
      await dispatchSessionRelease({
        bundle: input.bundle,
        fallbackNodeId: session.sessionId === input.sessionId ? input.bundle.nodeId : undefined,
        reason: input.reason,
        run: before,
        sessionId: session.sessionId,
      });
    } else if (!safeToRelease) {
      unsafeSessions.add(session.sessionId);
      if (session.parentSessionId !== undefined) {
        unsafeSessions.add(session.parentSessionId);
      }
      log.error("skipping release because the session branch is still active", {
        ancestorSessionId: input.sessionId,
        sessionId: session.sessionId,
      });
    }
    sessions.push({
      sessionId: session.sessionId,
      statusAfter: after?.status ?? "unknown",
      statusBefore: before?.status ?? "unknown",
    });
  }

  throwReleaseErrors(errors, `Session tree release failed for ${input.sessionId}`);
  return { sessions };
}

async function directChildrenForTurn(input: {
  readonly abortSignal: AbortSignal;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const mailbox = await readSubagentControlLineageMailbox(input.sessionId);
    const lineage = resolveDirectSubagentLineage({
      mailbox,
      parentSessionId: input.sessionId,
    });
    if (lineage.unresolved.length === 0) {
      const records = await Promise.all(lineage.children.map(getWorkflowRunRecord));
      return records
        .filter((record) => record.attributes["$eve.parent_turn"] === input.turnId)
        .map((record) => record.runId);
    }
    await delay(100, input.abortSignal);
    assertNotAborted(input.abortSignal, input.sessionId);
  }
  throw new Error(`Descendant lineage for ${input.sessionId} did not settle before release`);
}

interface FencedSession {
  readonly fenceSequence: number;
  readonly parentSessionId?: string;
  readonly sessionId: string;
  readonly turns: readonly {
    readonly turnId: string;
    readonly turnRunId: string;
  }[];
}

async function settleFencedTree(input: {
  readonly abortSignal: AbortSignal;
  readonly cancelRoot: boolean;
  readonly reason: ReleaseReason;
  readonly sessionId: string;
}): Promise<readonly FencedSession[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const discovered = await discoverFencedTree(input.sessionId, input.reason, input.cancelRoot);
    if (discovered.unresolved.length === 0) return discovered.ordered;
    await delay(100, input.abortSignal);
    assertNotAborted(input.abortSignal, input.sessionId);
  }
  throw new Error(`Descendant lineage for ${input.sessionId} did not settle before release`);
}

async function discoverFencedTree(
  rootSessionId: string,
  reason: ReleaseReason,
  cancelRoot: boolean,
): Promise<{
  readonly ordered: readonly FencedSession[];
  readonly unresolved: readonly string[];
}> {
  const ordered: FencedSession[] = [];
  const unresolved: string[] = [];
  const visited = new Set<string>();

  const visit = async (
    sessionId: string,
    parentSessionId: string | undefined,
    isRoot: boolean,
  ): Promise<void> => {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    const fenceReason = isRoot && !cancelRoot && reason === "completed" ? "completed" : "cancelled";
    await fenceSubagentControlMailbox(sessionId, fenceReason);

    const mailbox = await readSubagentControlLineageMailbox(sessionId);
    if (mailbox.fence === undefined) {
      unresolved.push(`${sessionId}:fence`);
      return;
    }
    const lineage = resolveDirectSubagentLineage({ mailbox, parentSessionId: sessionId });
    const turns = resolveSessionTurnLineage(sessionId, mailbox);
    unresolved.push(...lineage.unresolved, ...turns.unresolved);
    for (const childId of lineage.children) await visit(childId, sessionId, false);
    const fencedSession: FencedSession = {
      fenceSequence: mailbox.fence.sequence,
      sessionId,
      turns: turns.turnRuns,
    };
    if (parentSessionId !== undefined) Object.assign(fencedSession, { parentSessionId });
    ordered.push(fencedSession);
  };

  await visit(rootSessionId, undefined, true);
  return { ordered, unresolved };
}

async function dispatchSessionRelease(input: {
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly fallbackNodeId?: string;
  readonly reason: ReleaseReason;
  readonly run?: WorkflowRunRecord;
  readonly sessionId: string;
}): Promise<void> {
  try {
    const run = input.run ?? (await getWorkflowRunRecord(input.sessionId));
    const nodeId = run.attributes["$eve.subagent"] || input.fallbackNodeId || "__root__";
    const node = getResolvedRuntimeAgentNode(input.bundle.graph, nodeId);
    await dispatchReleaseHooks({
      context: {
        agent: { name: node.agent.config.name, nodeId },
        channel: { kind: run.attributes["$eve.trigger"] },
        session: { id: input.sessionId },
      },
      registry: node.hookRegistry,
      signal: { reason: input.reason },
    });
  } catch (error) {
    logError(log, "failed to dispatch release", error, {
      reason: input.reason,
      sessionId: input.sessionId,
    });
  }
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

function assertNotAborted(abortSignal: AbortSignal, sessionId: string): void {
  if (abortSignal.aborted) throw new Error(`Releasing ${sessionId} was aborted`);
}

async function delay(timeoutMs: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted || timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", finish);
      resolve();
    }
    abortSignal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForTerminalSession(
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<WorkflowRunRecord> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const record = await getWorkflowRunRecord(sessionId);
    if (TERMINAL_STATUSES.has(record.status)) return record;
    await delay(100, abortSignal);
    assertNotAborted(abortSignal, sessionId);
  }
  throw new Error(`Cancelled session ${sessionId} did not reach a terminal status`);
}

function throwReleaseErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, message);
}
