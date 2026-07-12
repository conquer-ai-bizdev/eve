import {
  appendSubagentControlMessage,
  type AppendedControlMessage,
} from "#features/subagent-supervision/messages.js";
import type { SubagentControlMessageRecord } from "#features/subagent-supervision/message-format.js";

/** Durably appends one logical child message before its wake is attempted. */
export async function appendSubagentControlMessageStep(
  childSessionId: string,
  message: SubagentControlMessageRecord,
): Promise<AppendedControlMessage> {
  "use step";

  return await appendSubagentControlMessage(childSessionId, message);
}
