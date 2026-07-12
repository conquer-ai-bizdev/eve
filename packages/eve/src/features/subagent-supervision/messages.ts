import { getWorld } from "#internal/workflow/runtime.js";

import type { ChildDeliveryReceipt } from "#public/definitions/subagent-control.js";
import {
  parseSubagentControlMailboxChunk,
  parseSubagentWaitStateChunk,
  serializeSubagentControlMailboxRecord,
  serializeSubagentWaitState,
  subagentControlMailboxStream,
  type SubagentControlMailboxRecord,
  subagentWaitStateStream,
  type SubagentControlFenceRecord,
  type SubagentControlMessageRecord,
  type SubagentControlSpawnRecord,
  type SubagentControlSpawnFailedRecord,
  type SubagentControlSpawnedRecord,
  type SubagentControlTurnFailedRecord,
  type SubagentControlTurnCancellationAcknowledgedRecord,
  type SubagentControlTurnRecord,
  type SubagentControlTurnStartedRecord,
  type SubagentWaitStateRecord,
} from "#features/subagent-supervision/message-format.js";

export interface SequencedControlMessage extends SubagentControlMessageRecord {
  readonly sequence: number;
}

export interface MailboxSnapshot {
  readonly fence?: {
    readonly reason: SubagentControlFenceRecord["reason"];
    readonly sequence: number;
  };
  readonly messages: readonly SequencedControlMessage[];
  readonly nextCursor: number;
  readonly failedSpawns: readonly (SubagentControlSpawnFailedRecord & {
    readonly sequence: number;
  })[];
  readonly spawns: readonly (SubagentControlSpawnRecord & { readonly sequence: number })[];
  readonly spawned: readonly (SubagentControlSpawnedRecord & { readonly sequence: number })[];
  readonly turns: readonly (
    | (SubagentControlTurnFailedRecord & { readonly sequence: number })
    | (SubagentControlTurnCancellationAcknowledgedRecord & { readonly sequence: number })
    | (SubagentControlTurnRecord & { readonly sequence: number })
    | (SubagentControlTurnStartedRecord & { readonly sequence: number })
  )[];
}

export interface AppendedControlMessage {
  readonly receipt: ChildDeliveryReceipt;
  readonly wakeOwner: boolean;
}

export interface CancellationMailboxSnapshot {
  readonly acknowledgements: readonly {
    readonly sequence: number;
    readonly turnId: string;
  }[];
  readonly fence?: {
    readonly reason: SubagentControlFenceRecord["reason"];
    readonly sequence: number;
  };
  readonly nextCursor: number;
}

const MAILBOX_SCAN_PAGE_SIZE = 1_000;

/** Appends a mailbox record. The workflow stream supplies its durable total order. */
export async function appendSubagentControlMessage(
  childSessionId: string,
  message: SubagentControlMessageRecord,
): Promise<AppendedControlMessage> {
  const before = await readSubagentControlMailbox(childSessionId, 0);
  const existing = before.messages.find((candidate) => candidate.messageId === message.messageId);
  if (existing !== undefined) {
    return { receipt: publicReceipt(existing), wakeOwner: false };
  }
  if (before.fence !== undefined) {
    throw new Error(`Cannot send to fenced child ${childSessionId}`);
  }

  const world = await getWorld();
  await world.streams.write(
    childSessionId,
    subagentControlMailboxStream(childSessionId),
    serializeSubagentControlMailboxRecord(message),
  );

  const after = await readSubagentControlMailbox(childSessionId, 0);
  const committed = after.messages.find((candidate) => candidate.messageId === message.messageId);
  if (committed === undefined) {
    throw new Error(`Control message ${message.messageId} was not committed`);
  }
  if (after.fence !== undefined && after.fence.sequence < committed.sequence) {
    throw new Error(`Cannot send to fenced child ${childSessionId}`);
  }
  return {
    receipt: publicReceipt(committed),
    wakeOwner: committed.attemptId === message.attemptId,
  };
}

/** Appends the terminal fence used to order send, spawn, and stop races. */
export async function fenceSubagentControlMailbox(
  childSessionId: string,
  reason: SubagentControlFenceRecord["reason"],
): Promise<void> {
  const snapshot = await readSubagentControlMailbox(childSessionId, 0);
  if (snapshot.fence !== undefined) return;
  const world = await getWorld();
  await world.streams.write(
    childSessionId,
    subagentControlMailboxStream(childSessionId),
    serializeSubagentControlMailboxRecord({ kind: "fence", reason, version: 1 }),
  );
}

/** Reads a finite mailbox snapshot and preserves the stream index as message sequence. */
export async function readSubagentControlMailbox(
  childSessionId: string,
  cursor: number,
): Promise<MailboxSnapshot> {
  return await readMailboxSnapshot(childSessionId, cursor, true);
}

/** Reads only lineage records, excluding message payloads from stop traversal state. */
export async function readSubagentControlLineageMailbox(
  childSessionId: string,
): Promise<MailboxSnapshot> {
  return await readMailboxSnapshot(childSessionId, 0, false);
}

/** Reads cancellation state from an absolute stream index without replaying older payloads. */
export async function readSubagentCancellationMailbox(
  childSessionId: string,
  cursor: number,
): Promise<CancellationMailboxSnapshot> {
  const acknowledgements: Array<{ readonly sequence: number; readonly turnId: string }> = [];
  let fence: CancellationMailboxSnapshot["fence"];
  const nextCursor = await scanSubagentControlRecords(
    childSessionId,
    cursor,
    (record, sequence) => {
      if (record.kind === "fence") {
        fence ??= { reason: record.reason, sequence };
      } else if (record.kind === "turn-cancellation-acknowledged") {
        acknowledgements.push({ sequence, turnId: record.turnId });
      }
    },
  );
  return {
    acknowledgements,
    ...(fence === undefined ? {} : { fence }),
    nextCursor,
  };
}

async function readMailboxSnapshot(
  childSessionId: string,
  cursor: number,
  includeMessages: boolean,
): Promise<MailboxSnapshot> {
  const messages: SequencedControlMessage[] = [];
  const spawns: (SubagentControlSpawnRecord & { readonly sequence: number })[] = [];
  const spawned: (SubagentControlSpawnedRecord & { readonly sequence: number })[] = [];
  const failedSpawns: (SubagentControlSpawnFailedRecord & { readonly sequence: number })[] = [];
  const turns: (
    | (SubagentControlTurnFailedRecord & { readonly sequence: number })
    | (SubagentControlTurnCancellationAcknowledgedRecord & { readonly sequence: number })
    | (SubagentControlTurnRecord & { readonly sequence: number })
    | (SubagentControlTurnStartedRecord & { readonly sequence: number })
  )[] = [];
  let fence: MailboxSnapshot["fence"];
  const nextCursor = await scanSubagentControlRecords(
    childSessionId,
    cursor,
    (record, sequence) => {
        if (record.kind === "fence") {
          fence ??= { reason: record.reason, sequence };
        } else if (record.kind === "message" && includeMessages) {
          messages.push({ ...record, sequence });
        } else if (record.kind === "spawn") {
          spawns.push({ ...record, sequence });
        } else if (record.kind === "spawned") {
          spawned.push({ ...record, sequence });
        } else if (record.kind === "spawn-failed") {
          failedSpawns.push({ ...record, sequence });
        } else if (record.kind !== "message") {
          turns.push({ ...record, sequence });
        }
    },
  );
  const seenMessageIds = new Set<string>();
  const firstMessages = messages.filter((message) => {
    if (seenMessageIds.has(message.messageId)) return false;
    seenMessageIds.add(message.messageId);
    return true;
  });
  return {
    ...(fence === undefined ? {} : { fence }),
    failedSpawns,
    messages: firstMessages,
    nextCursor,
    spawned,
    spawns,
    turns,
  };
}

async function scanSubagentControlRecords(
  childSessionId: string,
  cursor: number,
  visit: (record: SubagentControlMailboxRecord, sequence: number) => void,
): Promise<number> {
  const normalizedCursor = Math.max(0, Math.floor(cursor));
  const world = await getWorld();
  const streamName = subagentControlMailboxStream(childSessionId);
  const info = await world.streams.getInfo(childSessionId, streamName);
  if (info.tailIndex < normalizedCursor) return normalizedCursor;

  let pageCursor: string | undefined;
  const pageLimit = Math.ceil((info.tailIndex + 1) / MAILBOX_SCAN_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
    const page = await world.streams.getChunks(childSessionId, streamName, {
      cursor: pageCursor,
      limit: MAILBOX_SCAN_PAGE_SIZE,
    });
    for (const chunk of page.data) {
      if (chunk.index < normalizedCursor || chunk.index > info.tailIndex) continue;
      for (const record of parseSubagentControlMailboxChunk(chunk.data)) {
        visit(record, chunk.index);
      }
    }
    if (page.data.some((chunk) => chunk.index >= info.tailIndex)) break;
    if (!page.hasMore || !page.cursor) break;
    pageCursor = page.cursor;
  }
  return info.tailIndex + 1;
}

/** Resolves a spawn reservation whose child Workflow could not be started. */
export async function recordFailedSubagentSpawn(
  parentSessionId: string,
  callId: string,
): Promise<void> {
  const before = await readSubagentControlMailbox(parentSessionId, 0);
  if (before.failedSpawns.some((spawn) => spawn.callId === callId)) return;
  if (!before.spawns.some((spawn) => spawn.callId === callId)) {
    throw new Error(`Spawn reservation ${callId} was not found`);
  }
  const world = await getWorld();
  await world.streams.write(
    parentSessionId,
    subagentControlMailboxStream(parentSessionId),
    serializeSubagentControlMailboxRecord({ callId, kind: "spawn-failed", version: 1 }),
  );
}

/** Reserves one per-session turn in the same order as cancellation fencing. */
export async function reserveSubagentTurn(sessionId: string, turnId: string): Promise<void> {
  const before = await readSubagentControlMailbox(sessionId, 0);
  if (before.turns.some((turn) => turn.kind === "turn" && turn.turnId === turnId)) return;
  if (before.fence !== undefined)
    throw new Error(`Cannot start turn from fenced session ${sessionId}`);

  const world = await getWorld();
  await world.streams.write(
    sessionId,
    subagentControlMailboxStream(sessionId),
    serializeSubagentControlMailboxRecord({ kind: "turn", turnId, version: 1 }),
  );
  const after = await readSubagentControlMailbox(sessionId, 0);
  const committed = after.turns.find((turn) => turn.kind === "turn" && turn.turnId === turnId);
  if (committed === undefined) throw new Error(`Turn reservation ${turnId} was not committed`);
  if (after.fence !== undefined && after.fence.sequence < committed.sequence) {
    throw new Error(`Cannot start turn from fenced session ${sessionId}`);
  }
}

/** Records the Workflow run started for one accepted turn reservation. */
export async function recordStartedSubagentTurn(
  sessionId: string,
  turnId: string,
  turnRunId: string,
): Promise<void> {
  const before = await readSubagentControlMailbox(sessionId, 0);
  const existing = before.turns.find(
    (turn) => turn.kind === "turn-started" && turn.turnId === turnId,
  );
  if (existing?.kind === "turn-started") {
    if (existing.turnRunId !== turnRunId) {
      throw new Error(`Turn ${turnId} already owns run ${existing.turnRunId}`);
    }
    return;
  }
  if (!before.turns.some((turn) => turn.kind === "turn" && turn.turnId === turnId)) {
    throw new Error(`Turn reservation ${turnId} was not found`);
  }
  await appendTurnRecord(sessionId, {
    kind: "turn-started",
    turnId,
    turnRunId,
    version: 1,
  });
}

/** Resolves a reserved turn whose Workflow run could not be started. */
export async function recordFailedSubagentTurn(sessionId: string, turnId: string): Promise<void> {
  const before = await readSubagentControlMailbox(sessionId, 0);
  if (before.turns.some((turn) => turn.kind === "turn-failed" && turn.turnId === turnId)) return;
  await appendTurnRecord(sessionId, { kind: "turn-failed", turnId, version: 1 });
}

/** Acknowledges that one fenced turn has unwound its active execution. */
export async function acknowledgeCancelledSubagentTurn(
  sessionId: string,
  turnId: string,
): Promise<void> {
  const before = await readSubagentControlMailbox(sessionId, 0);
  const fence = before.fence;
  if (fence?.reason !== "cancelled") {
    throw new Error(`Cannot acknowledge cancellation for unfenced session ${sessionId}`);
  }
  if (!before.turns.some((turn) => turn.kind === "turn" && turn.turnId === turnId)) {
    throw new Error(`Turn reservation ${turnId} was not found`);
  }
  if (
    before.turns.some(
      (turn) => turn.kind === "turn-cancellation-acknowledged" && turn.turnId === turnId,
    )
  ) {
    return;
  }
  await appendTurnRecord(sessionId, {
    kind: "turn-cancellation-acknowledged",
    turnId,
    version: 1,
  });
}

async function appendTurnRecord(
  sessionId: string,
  record:
    | SubagentControlTurnCancellationAcknowledgedRecord
    | SubagentControlTurnFailedRecord
    | SubagentControlTurnStartedRecord,
): Promise<void> {
  const world = await getWorld();
  await world.streams.write(
    sessionId,
    subagentControlMailboxStream(sessionId),
    serializeSubagentControlMailboxRecord(record),
  );
}

/** Persists the durable child identity owned by one accepted spawn reservation. */
export async function recordSpawnedSubagent(
  parentSessionId: string,
  callId: string,
  childSessionId: string,
): Promise<void> {
  const before = await readSubagentControlMailbox(parentSessionId, 0);
  const existing = before.spawned.find((spawn) => spawn.callId === callId);
  if (existing !== undefined) {
    if (existing.childSessionId !== childSessionId) {
      throw new Error(`Spawn ${callId} already owns child ${existing.childSessionId}`);
    }
    return;
  }
  const reservation = before.spawns.find((spawn) => spawn.callId === callId);
  if (reservation === undefined) throw new Error(`Spawn reservation ${callId} was not found`);
  if (before.fence !== undefined && reservation.sequence > before.fence.sequence) {
    throw new Error(`Cannot record spawn from fenced session ${parentSessionId}`);
  }

  const world = await getWorld();
  await world.streams.write(
    parentSessionId,
    subagentControlMailboxStream(parentSessionId),
    serializeSubagentControlMailboxRecord({
      callId,
      childSessionId,
      kind: "spawned",
      version: 1,
    }),
  );
}

/** Reserves a delegated spawn in the same total order as terminal fencing. */
export async function reserveSubagentSpawn(parentSessionId: string, callId: string): Promise<void> {
  const before = await readSubagentControlMailbox(parentSessionId, 0);
  const existing = before.spawns.find((spawn) => spawn.callId === callId);
  if (existing !== undefined) return;
  if (before.fence !== undefined) {
    throw new Error(`Cannot spawn from fenced session ${parentSessionId}`);
  }

  const world = await getWorld();
  await world.streams.write(
    parentSessionId,
    subagentControlMailboxStream(parentSessionId),
    serializeSubagentControlMailboxRecord({ callId, kind: "spawn", version: 1 }),
  );
  const after = await readSubagentControlMailbox(parentSessionId, 0);
  const committed = after.spawns.find((spawn) => spawn.callId === callId);
  if (committed === undefined) throw new Error(`Spawn reservation ${callId} was not committed`);
  if (after.fence !== undefined && after.fence.sequence < committed.sequence) {
    throw new Error(`Cannot spawn from fenced session ${parentSessionId}`);
  }
}

export interface SubagentWaitState {
  readonly after: string;
  readonly deadlineAt: number;
}

/** Persists the first baseline and deadline for one replayable wait operation. */
export async function resolveSubagentWaitState(input: {
  readonly after: string;
  readonly callerSessionId: string;
  readonly operationId: string;
  readonly timeoutMs: number;
}): Promise<SubagentWaitState> {
  const world = await getWorld();
  const streamName = subagentWaitStateStream(input.callerSessionId);
  const existing = await readWaitState(input.callerSessionId, streamName, input.operationId);
  if (existing !== undefined) {
    return { after: existing.after ?? input.after, deadlineAt: existing.deadlineAt };
  }

  await world.streams.write(
    input.callerSessionId,
    streamName,
    serializeSubagentWaitState({
      after: input.after,
      deadlineAt: Date.now() + input.timeoutMs,
      operationId: input.operationId,
      version: 1,
    }),
  );
  const committed = await readWaitState(input.callerSessionId, streamName, input.operationId);
  return committed === undefined
    ? { after: input.after, deadlineAt: Date.now() }
    : { after: committed.after ?? input.after, deadlineAt: committed.deadlineAt };
}

async function readWaitState(
  runId: string,
  streamName: string,
  operationId: string,
): Promise<SubagentWaitStateRecord | undefined> {
  const world = await getWorld();
  const info = await world.streams.getInfo(runId, streamName);
  if (info.tailIndex < 0) return undefined;

  let cursor: string | undefined;
  const pageLimit = Math.ceil((info.tailIndex + 1) / MAILBOX_SCAN_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
    const page = await world.streams.getChunks(runId, streamName, { cursor, limit: 1000 });
    for (const chunk of page.data) {
      if (chunk.index > info.tailIndex) continue;
      for (const record of parseSubagentWaitStateChunk(chunk.data)) {
        if (record.operationId !== operationId) continue;
        return record;
      }
    }
    if (page.data.some((chunk) => chunk.index >= info.tailIndex)) break;
    cursor = page.hasMore && page.cursor ? page.cursor : undefined;
    if (cursor === undefined) break;
  }
  return undefined;
}

function publicReceipt(record: SequencedControlMessage): ChildDeliveryReceipt {
  return {
    accepted: true,
    idempotencyKey: record.idempotencyKey,
    messageId: record.messageId,
    sequence: record.sequence,
    state: "queued",
  };
}
