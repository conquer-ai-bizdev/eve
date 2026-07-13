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

  it("returns a bounded tail with absolute positions instead of rejecting long histories", async () => {
    const events = Array.from({ length: 2_052 }, (_, index) =>
      messageReceivedEvent(`event-${index}`),
    );
    vi.mocked(getRun).mockReturnValue(fakeRun(events) as never);
    const child = await controller().get("child");

    const snapshot = await child.snapshot();

    expect(snapshot.omittedBeforeIndex).toBe(4);
    expect(snapshot.events).toHaveLength(2_048);
    expect(snapshot.events[0]).toMatchObject({ index: 4, data: { message: "event-4" } });
    expect(snapshot.events.at(-1)).toMatchObject({ index: 2_051, data: { message: "event-2051" } });
    expect(snapshot.nextCursor).toBe("cursor:v1:1l0");
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

  it("preserves waits longer than one minute and caps them at ten minutes", async () => {
    vi.mocked(resolveSubagentWaitState).mockResolvedValue({
      after: "cursor:v1:0",
      deadlineAt: Date.now() - 1,
    });
    const child = await controller().get("child");

    await child.wait({
      after: "cursor:v1:0",
      idempotencyKey: "long-wait",
      timeoutMs: 180_000,
    });
    expect(resolveSubagentWaitState).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 180_000 }),
    );

    await child.wait({
      after: "cursor:v1:0",
      idempotencyKey: "bounded-wait",
      timeoutMs: 900_000,
    });
    expect(resolveSubagentWaitState).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("validates wait identity before returning immediate activity", async () => {
    const child = await controller().get("child");

    await expect(
      child.wait({ after: "cursor:v1:0", idempotencyKey: "   ", timeoutMs: 10_000 }),
    ).rejects.toThrow("wait idempotencyKey is required");
  });

  it("returns the bounded delta leading to an actionable wait event", async () => {
    vi.mocked(resolveSubagentWaitState).mockResolvedValue({
      after: "cursor:v1:0",
      deadlineAt: Date.now() + 2_000,
    });
    vi.mocked(getRun).mockReturnValue(
      stagedRun([
        [],
        [messageCompletedEvent()],
        [messageCompletedEvent(), waitingEvent()],
        [messageCompletedEvent(), waitingEvent()],
      ]) as never,
    );
    const child = await controller().get("child");

    const result = await child.wait({
      after: "cursor:v1:0",
      eventTypes: ["session.waiting"],
      idempotencyKey: "actionable-wait",
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({ reason: "event", timedOut: false });
    expect(result.snapshot.events.map((event) => event.type)).toEqual([
      "message.completed",
      "session.waiting",
    ]);
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

function stagedRun(stages: readonly (readonly object[])[]) {
  let stage = 0;
  return {
    getReadable(options: { readonly startIndex?: number }) {
      const events = stages[Math.min(stage, stages.length - 1)] ?? [];
      stage += 1;
      return fakeRun(events).getReadable(options);
    },
    status: "running",
  };
}

function messageReceivedEvent(message = "later activity") {
  return {
    data: { message },
    type: "message.received",
  };
}

function messageCompletedEvent() {
  return {
    data: {
      finishReason: "stop",
      message: "answer",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-1",
    },
    type: "message.completed",
  };
}

function waitingEvent() {
  return {
    data: { wait: "next-user-message" },
    type: "session.waiting",
  };
}
