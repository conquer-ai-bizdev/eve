import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSubagentWaitState } from "#features/subagent-supervision/messages.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";

import { createSubagentController } from "./controller.js";

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: vi.fn(),
  getWorld: vi.fn(),
}));

vi.mock("#features/subagent-supervision/messages.js", () => ({
  fenceSubagentControlMailbox: vi.fn(),
  readSubagentControlLineageMailbox: vi.fn(),
  resolveSubagentWaitState: vi.fn(),
}));

describe("subagent controller snapshots and waits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        get: vi.fn().mockResolvedValue({
          attributes: { "$eve.parent": "parent" },
          runId: "child",
          status: "running",
        }),
      },
    } as never);
    vi.mocked(getRun).mockReturnValue(fakeRun([messageReceivedEvent()]) as never);
  });

  it("returns a versioned snapshot", async () => {
    const child = await controller().get("child");

    await expect(child.snapshot()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it("honors an expired persisted deadline before later activity", async () => {
    vi.mocked(resolveSubagentWaitState).mockResolvedValue({
      after: "cursor:v1:0",
      deadlineAt: Date.now() - 1_000,
    });
    const child = await controller().get("child");

    await expect(
      child.wait({
        after: "cursor:v1:0",
        idempotencyKey: "replayed-wait",
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ reason: "timeout", timedOut: true });
    expect(resolveSubagentWaitState).toHaveBeenCalledOnce();
  });

  it("validates wait identity before returning immediate activity", async () => {
    const child = await controller().get("child");

    await expect(
      child.wait({ after: "cursor:v1:0", idempotencyKey: "   ", timeoutMs: 10_000 }),
    ).rejects.toThrow("wait idempotencyKey is required");
  });
});

function controller() {
  return createSubagentController({
    abortSignal: new AbortController().signal,
    callerSessionId: "parent",
  });
}

function fakeRun(events: readonly object[]) {
  return {
    getReadable({ startIndex = 0 }: { readonly startIndex?: number }) {
      const visible = startIndex < 0 ? events : events.slice(startIndex);
      let index = 0;
      return {
        cancel: vi.fn(),
        getReader() {
          return {
            cancel: vi.fn(),
            read: vi.fn(async () =>
              index < visible.length
                ? {
                    done: false,
                    value: new TextEncoder().encode(`${JSON.stringify(visible[index++])}\n`),
                  }
                : { done: true, value: undefined },
            ),
            releaseLock: vi.fn(),
          };
        },
        getTailIndex: vi.fn(async () => events.length - 1),
      };
    },
    status: "running",
  };
}

function messageReceivedEvent() {
  return {
    data: { message: "later activity" },
    type: "message.received",
  };
}
