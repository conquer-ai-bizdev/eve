import type {
  DeliverSubagentControlMessageInput,
  DeliverSubagentControlMessageResult,
} from "#features/subagent-supervision/deliver-message-workflow.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import type { ChildDeliveryReceipt } from "#public/definitions/subagent-control.js";

const DELIVERY_WORKFLOW_REFERENCE = {
  workflowId: "workflow//eve//deliverSubagentControlMessageWorkflow",
};

/** Starts or reuses the durable coordinator for one logical child message. */
export async function deliverSubagentControlMessage(
  input: DeliverSubagentControlMessageInput,
): Promise<ChildDeliveryReceipt> {
  const coordinator = await start(DELIVERY_WORKFLOW_REFERENCE, [input]);
  return await deliveredReceipt(
    await getRun<DeliverSubagentControlMessageResult>(coordinator.runId).returnValue,
  );
}

/** Derives the stable coordinator token for one child message. */
export async function subagentDeliveryLockToken(
  childSessionId: string,
  messageId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${childSessionId}\0${messageId}`),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `eve:subagent-control-delivery:${hash}`;
}

async function deliveredReceipt(
  result: DeliverSubagentControlMessageResult,
): Promise<ChildDeliveryReceipt> {
  if (result.kind === "delivered") return result.receipt;
  return await deliveredReceipt(
    await getRun<DeliverSubagentControlMessageResult>(result.ownerRunId).returnValue,
  );
}
