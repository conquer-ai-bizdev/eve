import {
  acknowledgeCancelledSubagentTurn,
  readSubagentCancellationMailbox,
} from "#features/subagent-supervision/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

export interface SubagentControlCancellationWatch {
  readonly signal: AbortSignal;
  dispose(): Promise<void>;
}

/** Aborts an active descendant turn when its durable control mailbox is cancelled. */
export function watchSubagentControlCancellation(
  sessionId: string,
  turnId: string,
): SubagentControlCancellationWatch {
  const cancellation = new AbortController();
  const stop = new AbortController();
  const done = monitorCancellation(sessionId, cancellation, stop.signal);

  return {
    signal: cancellation.signal,
    async dispose() {
      stop.abort();
      await done;
      if (cancellation.signal.aborted) {
        await acknowledgeCancelledSubagentTurn(sessionId, turnId);
      }
    },
  };
}

async function monitorCancellation(
  sessionId: string,
  cancellation: AbortController,
  stopSignal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  while (!stopSignal.aborted && !cancellation.signal.aborted) {
    try {
      const snapshot = await readSubagentCancellationMailbox(sessionId, cursor);
      if (snapshot.fence?.reason === "cancelled") {
        cancellation.abort(new TurnCancelledError(`Subagent session ${sessionId} was stopped.`));
        return;
      }
      cursor = snapshot.nextCursor;
    } catch {
      if (stopSignal.aborted) return;
    }
    await waitForPoll(stopSignal);
  }
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 100);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
