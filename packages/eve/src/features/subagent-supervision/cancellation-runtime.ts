import { getWorld, resumeHook } from "#internal/workflow/runtime.js";

import { readSubagentCancellationMailbox } from "#features/subagent-supervision/messages.js";
import type { ChildLifecycleStatus } from "#public/definitions/subagent-control.js";

const TERMINAL_STATUSES = new Set<ChildLifecycleStatus>(["completed", "failed", "cancelled"]);

/** Waits for execution acknowledgement, then terminates the acknowledged turn Workflow. */
export async function cancelAcknowledgedSubagentTurn(input: {
  readonly abortSignal: AbortSignal;
  readonly ancestorSessionId: string;
  readonly fenceSequence: number;
  readonly sessionId: string;
  readonly turn: { readonly turnId: string; readonly turnRunId: string };
}): Promise<void> {
  if (TERMINAL_STATUSES.has(await workflowStatus(input.turn.turnRunId))) return;

  try {
    await resumeHook(`${input.turn.turnId}:inbox`, { kind: "subagent-control-cancelled" });
  } catch (error) {
    if (TERMINAL_STATUSES.has(await workflowStatus(input.turn.turnRunId))) return;
    throw error;
  }

  let cursor = input.fenceSequence + 1;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (TERMINAL_STATUSES.has(await workflowStatus(input.turn.turnRunId))) return;
    const mailbox = await readSubagentCancellationMailbox(input.sessionId, cursor);
    cursor = mailbox.nextCursor;
    const acknowledged = mailbox.acknowledgements.some(
      (record) =>
        record.turnId === input.turn.turnId &&
        record.sequence > input.fenceSequence,
    );
    if (acknowledged) {
      await cancelSubagentWorkflowRun(input.turn.turnRunId, input.ancestorSessionId);
      await waitForTerminalStatus(input);
      return;
    }
    await delay(100, input.abortSignal);
    assertNotAborted(input);
  }
  throw new Error(
    `Active turn ${input.turn.turnRunId} did not acknowledge termination for ${input.ancestorSessionId}`,
  );
}

/** Emits Workflow's cancellation event without introducing a nested durable step. */
export async function cancelSubagentWorkflowRun(
  runId: string,
  ancestorSessionId: string,
): Promise<void> {
  const world = await getWorld();
  await world.events.create(runId, {
    eventData: { cancelReason: `Stopped by ancestor ${ancestorSessionId}` },
    eventType: "run_cancelled",
    specVersion: world.specVersion,
  });
}

async function waitForTerminalStatus(input: {
  readonly abortSignal: AbortSignal;
  readonly ancestorSessionId: string;
  readonly turn: { readonly turnRunId: string };
}): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (TERMINAL_STATUSES.has(await workflowStatus(input.turn.turnRunId))) return;
    await delay(100, input.abortSignal);
    assertNotAborted(input);
  }
  throw new Error(`Cancelled turn ${input.turn.turnRunId} did not reach a terminal status`);
}

async function workflowStatus(runId: string): Promise<ChildLifecycleStatus> {
  const world = await getWorld();
  const run = (await world.runs.get(runId, { resolveData: "none" })) as { readonly status?: unknown };
  switch (run.status) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return run.status;
    default:
      return "unknown";
  }
}

function assertNotAborted(input: {
  readonly abortSignal: AbortSignal;
  readonly ancestorSessionId: string;
}): void {
  if (input.abortSignal.aborted) {
    throw new Error(`Stopping ${input.ancestorSessionId} was aborted`);
  }
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
