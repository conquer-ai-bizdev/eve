import { describe, expect, it } from "vitest";

import {
  createSubagentControlWake,
  parseSubagentControlMailboxChunk,
  serializeSubagentControlMailboxRecord,
  splitSubagentControlWake,
  subagentControlMailboxStream,
} from "#features/subagent-supervision/message-format.js";

describe("subagent control message format", () => {
  it("isolates the mailbox stream by child session", () => {
    const first = subagentControlMailboxStream("child-a");
    expect(first).not.toBe(subagentControlMailboxStream("child-b"));
    expect(first).toMatch(/^[^./\0]+$/);
  });

  it("round-trips messages and fences", () => {
    const records = [
      {
        attemptId: "attempt-alpha",
        idempotencyKey: "alpha",
        kind: "message" as const,
        message: "ALPHA",
        messageId: "msg-alpha",
        version: 1 as const,
      },
      {
        callId: "spawn-1",
        childSessionId: "child-1",
        kind: "spawned" as const,
        version: 1 as const,
      },
      {
        kind: "turn-started" as const,
        turnId: "turn-1",
        turnRunId: "wrun_turn",
        version: 1 as const,
      },
      { kind: "fence" as const, reason: "cancelled" as const, version: 1 as const },
    ];
    const chunk = new TextEncoder().encode(
      records.map(serializeSubagentControlMailboxRecord).join(""),
    );
    expect(parseSubagentControlMailboxChunk(chunk)).toEqual(records);
  });

  it("removes wake markers without dropping ordinary payloads", () => {
    const wake = createSubagentControlWake({ messageId: "msg-alpha" });
    const value = {
      ...wake,
      payloads: [...wake.payloads, { message: "ordinary" }],
    };

    expect(splitSubagentControlWake(value)).toEqual({
      delivery: { kind: "deliver", payloads: [{ message: "ordinary" }] },
      hadWake: true,
    });
  });
});
