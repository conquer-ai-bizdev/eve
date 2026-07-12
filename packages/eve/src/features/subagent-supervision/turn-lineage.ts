import type { MailboxSnapshot } from "#features/subagent-supervision/messages.js";

export interface SessionTurnLineage {
  readonly turnRuns: readonly {
    readonly turnId: string;
    readonly turnRunId: string;
  }[];
  readonly turnRunIds: readonly string[];
  readonly unresolved: readonly string[];
}

/** Resolves per-turn Workflow runs from one session's fenced mailbox. */
export function resolveSessionTurnLineage(
  sessionId: string,
  mailbox: MailboxSnapshot,
): SessionTurnLineage {
  const started = new Map<string, string>();
  const failed = new Set<string>();
  for (const turn of mailbox.turns) {
    if (turn.kind === "turn-started") started.set(turn.turnId, turn.turnRunId);
    if (turn.kind === "turn-failed") failed.add(turn.turnId);
  }

  const fenceSequence = mailbox.fence?.sequence ?? Number.POSITIVE_INFINITY;
  const unresolved = mailbox.turns
    .filter(
      (turn) =>
        turn.kind === "turn" &&
        turn.sequence < fenceSequence &&
        !started.has(turn.turnId) &&
        !failed.has(turn.turnId),
    )
    .map((turn) => `${sessionId}:${turn.turnId}`);

  const turnRuns = [...started].map(([turnId, turnRunId]) => ({ turnId, turnRunId }));
  return {
    turnRuns,
    turnRunIds: [...new Set(turnRuns.map((turn) => turn.turnRunId))],
    unresolved,
  };
}
