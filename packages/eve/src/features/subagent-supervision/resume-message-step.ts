import { resumeHook } from "#internal/workflow/runtime.js";

import { createSubagentControlWake } from "#features/subagent-supervision/message-format.js";

/** Wakes the child after its logical message is durably visible. */
export async function resumeSubagentControlMessageStep(
  continuationToken: string,
  messageId: string,
): Promise<void> {
  "use step";

  await resumeHook(continuationToken, createSubagentControlWake({ messageId }));
}
