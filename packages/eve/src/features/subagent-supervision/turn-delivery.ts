import type { DeliverHookPayload } from "#channel/types.js";
import { splitSubagentControlWake } from "#features/subagent-supervision/message-format.js";
import { readSubagentControlMessagesStep } from "#features/subagent-supervision/read-messages-step.js";
import { coalesceDeliveries } from "#harness/messages.js";

export interface SubagentControlDeliveryState {
  cursor: number;
  readonly seenMessageIds: string[];
}

export function createSubagentControlDeliveryState(): SubagentControlDeliveryState {
  return { cursor: 0, seenMessageIds: [] };
}

export async function resolveBufferedSubagentControlDeliveries(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly childSessionId: string;
  readonly controlState: SubagentControlDeliveryState;
}): Promise<DeliverHookPayload | undefined> {
  const buffered =
    input.bufferedDeliveries.length === 0
      ? undefined
      : coalesceDeliveries(input.bufferedDeliveries.splice(0));
  return await resolveSubagentControlDelivery({
    childSessionId: input.childSessionId,
    controlState: input.controlState,
    delivery: buffered,
  });
}

export async function resolveSubagentControlDelivery(input: {
  readonly childSessionId: string;
  readonly controlState: SubagentControlDeliveryState;
  readonly delivery?: DeliverHookPayload;
}): Promise<DeliverHookPayload | undefined> {
  const deliveries: DeliverHookPayload[] = [];
  if (input.delivery !== undefined) {
    const { delivery } = splitSubagentControlWake(input.delivery);
    if (delivery !== undefined) deliveries.push(delivery);
  }

  const batch = await readSubagentControlMessagesStep(
    input.childSessionId,
    input.controlState.cursor,
  );
  input.controlState.cursor = batch.nextCursor;

  for (const message of batch.messages) {
    if (input.controlState.seenMessageIds.includes(message.messageId)) continue;
    input.controlState.seenMessageIds.push(message.messageId);
    deliveries.push({ kind: "deliver", payloads: [{ message: message.message }] });
  }

  return deliveries.length === 0 ? undefined : coalesceDeliveries(deliveries);
}
