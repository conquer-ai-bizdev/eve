import { fenceSubagentControlMailbox } from "#features/subagent-supervision/messages.js";

/** Orders a terminal fence against concurrent mailbox appends. */
export async function fenceSubagentControlMailboxStep(
  childSessionId: string,
  reason: "cancelled" | "completed",
): Promise<void> {
  "use step";

  await fenceSubagentControlMailbox(childSessionId, reason);
}
