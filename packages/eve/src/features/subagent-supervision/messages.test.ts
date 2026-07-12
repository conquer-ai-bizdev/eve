import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSubagentControlMailbox,
  resolveSubagentWaitState,
} from "#features/subagent-supervision/messages.js";
import {
  serializeSubagentControlMailboxRecord,
} from "#features/subagent-supervision/message-format.js";
import { getWorld } from "#internal/workflow/runtime.js";

vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: vi.fn() }));

describe("subagent control mailbox snapshots", () => {
  const encoder = new TextEncoder();
  const get = vi.fn();
  const getChunks = vi.fn();
  const getInfo = vi.fn();
  const write = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorld).mockResolvedValue({
      streams: { get, getChunks, getInfo, write },
    } as never);
  });

  it("uses bounded snapshot pages rather than a live stream", async () => {
    getInfo.mockResolvedValue({ done: false, tailIndex: 1 });
    getChunks.mockResolvedValue({
      cursor: null,
      data: [
        {
          data: encoder.encode(
            serializeSubagentControlMailboxRecord({
              callId: "call-1",
              kind: "spawn",
              version: 1,
            }),
          ),
          index: 0,
        },
        {
          data: encoder.encode(
            serializeSubagentControlMailboxRecord({
              callId: "call-1",
              childSessionId: "child-1",
              kind: "spawned",
              version: 1,
            }),
          ),
          index: 1,
        },
      ],
      done: false,
      hasMore: false,
    });

    await expect(readSubagentControlMailbox("parent-1", 0)).resolves.toMatchObject({
      nextCursor: 2,
      spawned: [{ childSessionId: "child-1", sequence: 1 }],
      spawns: [{ callId: "call-1", sequence: 0 }],
    });
    expect(getChunks).toHaveBeenCalledWith(
      "parent-1",
      "eve-subagent-control-mailbox-parent-1",
      { cursor: undefined, limit: 1_000 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("reads a fixed tail beyond 4,096 historical chunks", async () => {
    getInfo.mockResolvedValue({ done: false, tailIndex: 4_999 });
    getChunks.mockImplementation(async (_runId, _streamName, options) => {
      const page = options.cursor === undefined ? 0 : Number(options.cursor);
      const start = page * 1_000;
      return {
        cursor: page < 4 ? String(page + 1) : null,
        data: Array.from({ length: 1_000 }, (_, offset) => ({
          data: encoder.encode(""),
          index: start + offset,
        })),
        done: false,
        hasMore: page < 4,
      };
    });

    await expect(readSubagentControlMailbox("long-lived", 4_500)).resolves.toMatchObject({
      nextCursor: 5_000,
    });
    expect(getChunks).toHaveBeenCalledTimes(5);
  });

  it("stops at the captured tail while concurrent appends continue", async () => {
    getInfo.mockResolvedValue({ done: false, tailIndex: 1 });
    getChunks.mockResolvedValueOnce({
      cursor: "next-page",
      data: [
        { data: encoder.encode(""), index: 0 },
        { data: encoder.encode(""), index: 1 },
      ],
      done: false,
      hasMore: true,
    });

    await expect(readSubagentControlMailbox("growing", 0)).resolves.toMatchObject({
      nextCursor: 2,
    });
    expect(getChunks).toHaveBeenCalledOnce();
  });

  it("reuses the first private wait baseline and deadline after replay", async () => {
    const chunks: Uint8Array[] = [];
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    getInfo.mockImplementation(async () => ({ done: false, tailIndex: chunks.length - 1 }));
    getChunks.mockImplementation(async () => ({
      cursor: null,
      data: chunks.map((data, index) => ({ data, index })),
      done: false,
      hasMore: false,
    }));
    write.mockImplementation(async (_runId, _streamName, data: string) => {
      chunks.push(encoder.encode(data));
    });

    const first = await resolveSubagentWaitState({
      after: "cursor:v1:4",
      callerSessionId: "parent",
      operationId: "same-operation",
      timeoutMs: 10_000,
    });
    const replay = await resolveSubagentWaitState({
      after: "cursor:v1:9",
      callerSessionId: "parent",
      operationId: "same-operation",
      timeoutMs: 60_000,
    });

    expect(first).toEqual({ after: "cursor:v1:4", deadlineAt: 11_000 });
    expect(replay).toEqual(first);
    expect(write).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockRestore();
  });
});
