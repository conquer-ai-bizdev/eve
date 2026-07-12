import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { HookPayload } from "#channel/types.js";
import { readSubagentControlMessagesStep } from "#features/subagent-supervision/read-messages-step.js";

export async function terminalSubagentControlWorkflow(input: {
  readonly token: string;
}): Promise<readonly string[]> {
  "use workflow";

  const ready = createHook<HookPayload>({ token: input.token });
  await ready;

  const childSessionId = getWorkflowMetadata().workflowRunId;
  const batch = await readSubagentControlMessagesStep(childSessionId, 0);
  return batch.messages.map((message) => message.message);
}
