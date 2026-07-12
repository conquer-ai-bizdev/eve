import type { MailboxSnapshot } from "#features/subagent-supervision/messages.js";

export interface DirectSubagentLineage {
  readonly children: readonly string[];
  readonly unresolved: readonly string[];
}

/** Resolves direct native children from one parent's durable spawn order. */
export function resolveDirectSubagentLineage(input: {
  readonly mailbox: MailboxSnapshot;
  readonly parentSessionId: string;
}): DirectSubagentLineage {
  const fenceSequence = input.mailbox.fence?.sequence ?? Number.POSITIVE_INFINITY;
  const accepted = new Set(
    input.mailbox.spawns
      .filter((spawn) => spawn.sequence < fenceSequence)
      .map((spawn) => spawn.callId),
  );
  const resolvedCalls = new Set([
    ...input.mailbox.spawned.map((spawn) => spawn.callId),
    ...input.mailbox.failedSpawns.map((spawn) => spawn.callId),
  ]);
  const unresolved = input.mailbox.spawns
    .filter(
      (spawn) =>
        spawn.sequence < fenceSequence &&
        !resolvedCalls.has(spawn.callId),
    )
    .map((spawn) => `${input.parentSessionId}:${spawn.callId}`);

  return {
    children: input.mailbox.spawned
      .filter((spawn) => accepted.has(spawn.callId))
      .map((spawn) => spawn.childSessionId),
    unresolved,
  };
}
