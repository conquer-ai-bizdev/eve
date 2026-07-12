import { readSubagentControlMailbox } from "#features/subagent-supervision/messages.js";

export interface SubagentControlMessageBatch {
  readonly fenced: boolean;
  readonly messages: readonly {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly messageId: string;
    readonly sequence: number;
  }[];
  readonly nextCursor: number;
}

/** Reads the finite mailbox tail visible at one child turn boundary. */
export async function readSubagentControlMessagesStep(
  childSessionId: string,
  cursor: number,
): Promise<SubagentControlMessageBatch> {
  "use step";

  const snapshot = await readSubagentControlMailbox(childSessionId, cursor);
  const messages =
    snapshot.fence === undefined
      ? snapshot.messages
      : snapshot.fence.reason === "cancelled"
        ? []
        : snapshot.messages.filter((message) => message.sequence < snapshot.fence!.sequence);
  return {
    fenced: snapshot.fence !== undefined,
    messages: messages.map((message) => ({
      idempotencyKey: message.idempotencyKey,
      message: message.message,
      messageId: message.messageId,
      sequence: message.sequence,
    })),
    nextCursor: snapshot.nextCursor,
  };
}
