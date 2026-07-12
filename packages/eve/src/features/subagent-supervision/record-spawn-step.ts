import { recordSpawnedSubagent } from "#features/subagent-supervision/messages.js";

/** Persists the child identity before the coordinated spawn can complete. */
export async function recordSpawnedSubagentStep(
  parentSessionId: string,
  callId: string,
  childSessionId: string,
): Promise<void> {
  "use step";
  await recordSpawnedSubagent(parentSessionId, callId, childSessionId);
}
