import type { DeliverHookPayload } from "#channel/types.js";

const SUBAGENT_CONTROL_MAILBOX_STREAM_PREFIX = "eve-subagent-control-mailbox";
const SUBAGENT_WAIT_STATE_STREAM_PREFIX = "eve-subagent-wait-state";
const CONTROL_WAKE_PAYLOAD_KEY = "eve.subagentControlWake";

export function subagentControlMailboxStream(childSessionId: string): string {
  return `${SUBAGENT_CONTROL_MAILBOX_STREAM_PREFIX}-${childSessionId}`;
}

export function subagentWaitStateStream(callerSessionId: string): string {
  return `${SUBAGENT_WAIT_STATE_STREAM_PREFIX}-${callerSessionId}`;
}

export interface SubagentControlMessageRecord {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly kind: "message";
  readonly message: string;
  readonly messageId: string;
  readonly version: 1;
}

export interface SubagentControlFenceRecord {
  readonly kind: "fence";
  readonly reason: "cancelled" | "completed";
  readonly version: 1;
}

export interface SubagentControlSpawnRecord {
  readonly callId: string;
  readonly kind: "spawn";
  readonly version: 1;
}

export interface SubagentControlSpawnedRecord {
  readonly callId: string;
  readonly childSessionId: string;
  readonly kind: "spawned";
  readonly version: 1;
}

export interface SubagentControlSpawnFailedRecord {
  readonly callId: string;
  readonly kind: "spawn-failed";
  readonly version: 1;
}

export interface SubagentControlTurnRecord {
  readonly kind: "turn";
  readonly turnId: string;
  readonly version: 1;
}

export interface SubagentControlTurnStartedRecord {
  readonly kind: "turn-started";
  readonly turnId: string;
  readonly turnRunId: string;
  readonly version: 1;
}

export interface SubagentControlTurnFailedRecord {
  readonly kind: "turn-failed";
  readonly turnId: string;
  readonly version: 1;
}

export interface SubagentControlTurnCancellationAcknowledgedRecord {
  readonly kind: "turn-cancellation-acknowledged";
  readonly turnId: string;
  readonly version: 1;
}

export type SubagentControlMailboxRecord =
  | SubagentControlFenceRecord
  | SubagentControlMessageRecord
  | SubagentControlSpawnRecord
  | SubagentControlSpawnFailedRecord
  | SubagentControlSpawnedRecord
  | SubagentControlTurnCancellationAcknowledgedRecord
  | SubagentControlTurnFailedRecord
  | SubagentControlTurnRecord
  | SubagentControlTurnStartedRecord;

export interface SubagentWaitStateRecord {
  readonly after?: string;
  readonly deadlineAt: number;
  readonly operationId: string;
  readonly version: 1;
}

export function controlMessageId(idempotencyKey: string): string {
  return `msg:${encodeURIComponent(idempotencyKey)}`;
}

export function createSubagentControlWake(input: {
  readonly messageId: string;
}): DeliverHookPayload {
  return {
    kind: "deliver",
    payloads: [
      {
        [CONTROL_WAKE_PAYLOAD_KEY]: {
          messageId: input.messageId,
          version: 1,
        },
      },
    ],
  };
}

export function splitSubagentControlWake(value: DeliverHookPayload): {
  readonly delivery?: DeliverHookPayload;
  readonly hadWake: boolean;
} {
  const payloads = value.payloads.filter((payload) => !isControlWakePayload(payload));
  return {
    ...(payloads.length === 0 ? {} : { delivery: { ...value, payloads } }),
    hadWake: payloads.length !== value.payloads.length,
  };
}

export function serializeSubagentControlMailboxRecord(
  record: SubagentControlMailboxRecord,
): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseSubagentControlMailboxChunk(
  value: Uint8Array,
): readonly SubagentControlMailboxRecord[] {
  return new TextDecoder()
    .decode(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseSubagentControlMailboxRecord(line));
}

export function serializeSubagentWaitState(record: SubagentWaitStateRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseSubagentWaitStateChunk(value: Uint8Array): readonly SubagentWaitStateRecord[] {
  return new TextDecoder()
    .decode(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseSubagentWaitState(line));
}

function parseSubagentControlMailboxRecord(value: string): SubagentControlMailboxRecord {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid subagent control mailbox record");
  }
  const candidate = parsed as Partial<SubagentControlMailboxRecord>;
  if (candidate.version !== 1) {
    throw new Error("Invalid subagent control mailbox record");
  }
  if (candidate.kind === "fence") {
    if (candidate.reason !== "cancelled" && candidate.reason !== "completed") {
      throw new Error("Invalid subagent control fence");
    }
    return candidate as SubagentControlFenceRecord;
  }
  if (candidate.kind === "spawn") {
    if (typeof candidate.callId !== "string") {
      throw new Error("Invalid subagent control spawn reservation");
    }
    return candidate as SubagentControlSpawnRecord;
  }
  if (candidate.kind === "spawned") {
    if (typeof candidate.callId !== "string" || typeof candidate.childSessionId !== "string") {
      throw new Error("Invalid subagent control spawned child");
    }
    return candidate as SubagentControlSpawnedRecord;
  }
  if (candidate.kind === "spawn-failed") {
    if (typeof candidate.callId !== "string") {
      throw new Error("Invalid subagent control failed spawn");
    }
    return candidate as SubagentControlSpawnFailedRecord;
  }
  if (candidate.kind === "turn") {
    if (typeof candidate.turnId !== "string") {
      throw new Error("Invalid subagent control turn reservation");
    }
    return candidate as SubagentControlTurnRecord;
  }
  if (candidate.kind === "turn-started") {
    if (typeof candidate.turnId !== "string" || typeof candidate.turnRunId !== "string") {
      throw new Error("Invalid subagent control started turn");
    }
    return candidate as SubagentControlTurnStartedRecord;
  }
  if (candidate.kind === "turn-failed") {
    if (typeof candidate.turnId !== "string") {
      throw new Error("Invalid subagent control failed turn");
    }
    return candidate as SubagentControlTurnFailedRecord;
  }
  if (candidate.kind === "turn-cancellation-acknowledged") {
    if (typeof candidate.turnId !== "string") {
      throw new Error("Invalid subagent control turn cancellation acknowledgement");
    }
    return candidate as SubagentControlTurnCancellationAcknowledgedRecord;
  }
  if (
    candidate.kind !== "message" ||
    typeof candidate.attemptId !== "string" ||
    typeof candidate.idempotencyKey !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.messageId !== "string"
  ) {
    throw new Error("Invalid subagent control message");
  }
  return candidate as SubagentControlMessageRecord;
}

function parseSubagentWaitState(value: string): SubagentWaitStateRecord {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid subagent wait state");
  }
  const candidate = parsed as Partial<SubagentWaitStateRecord>;
  if (
    candidate.version !== 1 ||
    (candidate.after !== undefined && typeof candidate.after !== "string") ||
    typeof candidate.deadlineAt !== "number" ||
    !Number.isFinite(candidate.deadlineAt) ||
    typeof candidate.operationId !== "string"
  ) {
    throw new Error("Invalid subagent wait state");
  }
  return candidate as SubagentWaitStateRecord;
}

function isControlWakePayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as Record<string, unknown>)[CONTROL_WAKE_PAYLOAD_KEY];
  if (typeof candidate !== "object" || candidate === null) return false;
  const marker = candidate as { readonly messageId?: unknown; readonly version?: unknown };
  return marker.version === 1 && typeof marker.messageId === "string";
}
