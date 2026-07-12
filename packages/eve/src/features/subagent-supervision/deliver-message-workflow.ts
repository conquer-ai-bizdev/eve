import { createHook } from "#compiled/@workflow/core/index.js";

import { appendSubagentControlMessageStep } from "#features/subagent-supervision/append-message-step.js";
import { resumeSubagentControlMessageStep } from "#features/subagent-supervision/resume-message-step.js";
import type { ChildDeliveryReceipt } from "#public/definitions/subagent-control.js";

export interface DeliverSubagentControlMessageInput {
  readonly childSessionId: string;
  readonly continuationToken: string;
  readonly idempotencyKey: string;
  readonly lockToken: string;
  readonly message: string;
  readonly messageId: string;
}

export type DeliverSubagentControlMessageResult =
  | { readonly kind: "conflict"; readonly ownerRunId: string }
  | { readonly kind: "delivered"; readonly receipt: ChildDeliveryReceipt };

/** Owns one logical delivery token and performs the append/wake sequence durably. */
export async function deliverSubagentControlMessageWorkflow(
  input: DeliverSubagentControlMessageInput,
): Promise<DeliverSubagentControlMessageResult> {
  "use workflow";

  using lock = createHook({ token: input.lockToken });
  let conflict: { readonly runId: string } | null;
  try {
    conflict = await lock.getConflict();
  } catch (error) {
    const ownerRunId = conflictingRunId(error);
    if (ownerRunId !== undefined) return { kind: "conflict", ownerRunId };
    throw error;
  }
  if (conflict !== null) return { kind: "conflict", ownerRunId: conflict.runId };

  const delivery = await appendSubagentControlMessageStep(input.childSessionId, {
    attemptId: input.lockToken,
    idempotencyKey: input.idempotencyKey,
    kind: "message",
    message: input.message,
    messageId: input.messageId,
    version: 1,
  });
  if (delivery.wakeOwner) {
    await resumeSubagentControlMessageStep(input.continuationToken, input.messageId);
  }
  return { kind: "delivered", receipt: delivery.receipt };
}

function conflictingRunId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { readonly conflictingRunId?: unknown; readonly name?: unknown };
  return candidate.name === "HookConflictError" && typeof candidate.conflictingRunId === "string"
    ? candidate.conflictingRunId
    : undefined;
}
