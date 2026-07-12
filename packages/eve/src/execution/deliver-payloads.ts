import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

/** Coalesces channel payloads while preserving ordered turn input. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (
        key !== "context" &&
        key !== "inputResponses" &&
        key !== "message" &&
        key !== "outputSchema" &&
        value !== undefined
      ) {
        merged[key] = value;
      }
    }
    turnInput = coalesceTurnInputs(turnInput, payload);
  }

  return { ...merged, ...turnInput };
}
