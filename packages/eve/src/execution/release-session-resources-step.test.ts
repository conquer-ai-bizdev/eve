import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { logError } from "#internal/logging.js";
import { releaseSessionResourcesStep } from "#execution/release-session-resources-step.js";

vi.mock("#channel/adapter.js", () => ({
  getAdapterKind: (adapter: { kind: string }) => adapter.kind,
}));
vi.mock("#context/build-callback-context.js", () => ({ buildCallbackContext: vi.fn() }));
vi.mock("#context/run-step.js", () => ({
  withContextScope: vi.fn(async (_ctx, session, callback) => await callback(session)),
}));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/durable-session-store.js", () => ({
  createDurableSessionState: vi.fn(({ session }) => ({ snapshot: { session, version: 1 } })),
  readDurableSession: vi.fn(),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: vi.fn(() => ({ thresholdPercent: 80, turnAgent: {} })),
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: vi.fn(({ durable }) => ({ sessionId: "s1", ...durable })),
}));
vi.mock("#internal/logging.js", () => ({ createLogger: vi.fn(() => ({})), logError: vi.fn() }));
vi.mock("#runtime/sessions/runtime-context-keys.js", () => ({
  BundleKey: "bundle",
  ChannelKey: "channel",
}));

describe("releaseSessionResourcesStep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs every handler after a failure without changing the reason", async () => {
    const calls: string[] = [];
    const first = vi.fn(async () => {
      calls.push("first");
      throw new Error("boom");
    });
    const second = vi.fn(async () => calls.push("second"));
    vi.mocked(deserializeContext).mockResolvedValue({
      get: (key: unknown) => (key === "channel" ? { kind: "mock" } : "channel:thread"),
      require: () => ({
        hookRegistry: { releases: [first, second] },
        nodeId: "child",
        turnAgent: { id: "agent" },
      }),
    } as never);
    vi.mocked(readDurableSession).mockResolvedValue({} as never);
    vi.mocked(buildCallbackContext).mockReturnValue({ session: { id: "s1" } } as never);

    await expect(
      releaseSessionResourcesStep({
        reason: "failed",
        serializedContext: {},
        sessionState: {} as never,
      }),
    ).resolves.toBeDefined();

    expect(calls).toEqual(["first", "second"]);
    expect(second).toHaveBeenCalledWith(
      { reason: "failed" },
      expect.objectContaining({
        agent: { name: "agent", nodeId: "child" },
        channel: { continuationToken: "channel:thread", kind: "mock" },
      }),
    );
    expect(logError).toHaveBeenCalledTimes(1);
    expect(withContextScope).toHaveBeenCalledTimes(1);
  });

  it("does not construct a session when no release handler exists", async () => {
    vi.mocked(deserializeContext).mockResolvedValue({
      require: () => ({ hookRegistry: { releases: [] } }),
    } as never);

    await releaseSessionResourcesStep({
      reason: "completed",
      serializedContext: {},
      sessionState: {} as never,
    });

    expect(readDurableSession).not.toHaveBeenCalled();
  });

  it("returns provider state committed by release handlers", async () => {
    const release = vi.fn();
    vi.mocked(deserializeContext).mockResolvedValue({
      get: () => undefined,
      require: () => ({
        hookRegistry: { releases: [release] },
        nodeId: "__root__",
        turnAgent: { id: "agent" },
      }),
    } as never);
    vi.mocked(readDurableSession).mockResolvedValue({} as never);
    vi.mocked(buildCallbackContext).mockReturnValue({ session: { id: "s1" } } as never);
    vi.mocked(withContextScope).mockImplementationOnce(async (_ctx, session, callback) => {
      const scoped = await callback(session);
      return {
        ...scoped,
        session: { ...scoped.session, sandboxState: { initialized: false, session: null } },
      };
    });

    const result = await releaseSessionResourcesStep({
      reason: "completed",
      serializedContext: {},
      sessionState: {} as never,
    });

    expect(result).toMatchObject({
      snapshot: { session: { sandboxState: { initialized: false, session: null } } },
    });
  });

  it("does not release a cancelled cohort with a nonterminal task", async () => {
    const release = vi.fn();
    vi.mocked(deserializeContext).mockResolvedValue({
      get: () => undefined,
      require: () => ({
        hookRegistry: { releases: [release] },
        nodeId: "__root__",
        turnAgent: { id: "agent" },
      }),
    } as never);
    vi.mocked(readDurableSession).mockResolvedValue({
      state: {
        "eve.tasks": {
          tasks: [
            {
              createdByTurnId: "turn_0",
              metadata: { kind: "subagent", name: "agent" },
              taskId: "task-1",
              taskInboxToken: "task-inbox-1",
              taskRunId: "task-run-1",
            },
          ],
          version: 2,
        },
      },
    } as never);
    const sessionState = {} as never;

    const result = await releaseSessionResourcesStep({
      reason: "cancelled",
      requireSettledCohort: true,
      serializedContext: {},
      sessionState,
    });

    expect(result).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
    expect(withContextScope).not.toHaveBeenCalled();
  });
});
