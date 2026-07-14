import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const mocks = vi.hoisted(() => ({
  cancelTurn: vi.fn(),
  cancelWorkflow: vi.fn(),
  fence: vi.fn(),
  getWorld: vi.fn(),
  readMailbox: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: mocks.getWorld }));
vi.mock("#features/subagent-supervision/cancellation-runtime.js", () => ({
  cancelAcknowledgedSubagentTurn: mocks.cancelTurn,
  cancelSubagentWorkflowRun: mocks.cancelWorkflow,
}));
vi.mock("#features/subagent-supervision/messages.js", () => ({
  fenceSubagentControlMailbox: mocks.fence,
  readSubagentControlLineageMailbox: mocks.readMailbox,
}));

import { releaseRequestParticipants, releaseSessionTree } from "./release-participants.js";

describe("release participants", () => {
  const records = new Map<string, RunRecord>();
  const fences = new Map<string, "cancelled" | "completed">();
  const calls: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    records.clear();
    fences.clear();
    calls.length = 0;

    records.set("root", run("root", "running", { "$eve.trigger": "http" }));
    records.set(
      "child",
      run("child", "running", {
        "$eve.parent_turn": "turn_0",
        "$eve.subagent": "subagents/worker",
        "$eve.trigger": "subagent",
      }),
    );
    records.set(
      "nested",
      run("nested", "completed", {
        "$eve.parent_turn": "turn_0",
        "$eve.subagent": "subagents/worker::subagents/nested",
        "$eve.trigger": "subagent",
      }),
    );
    records.set(
      "builtin",
      run("builtin", "running", {
        "$eve.parent_turn": "turn_0",
        "$eve.subagent": "__root__",
        "$eve.trigger": "subagent",
      }),
    );
    records.set(
      "old-child",
      run("old-child", "running", {
        "$eve.parent_turn": "turn_previous",
        "$eve.subagent": "subagents/worker",
      }),
    );

    mocks.getWorld.mockResolvedValue({
      runs: {
        get: vi.fn(async (runId: string) => records.get(runId)),
      },
    });
    mocks.fence.mockImplementation(async (sessionId: string, reason: "cancelled" | "completed") => {
      fences.set(sessionId, reason);
    });
    mocks.readMailbox.mockImplementation(async (sessionId: string) => mailbox(sessionId, fences));
    mocks.cancelWorkflow.mockImplementation(async (runId: string) => {
      const record = records.get(runId);
      if (record !== undefined) records.set(runId, { ...record, status: "cancelled" });
    });
  });

  it("releases only the current request tree deepest-first and the root last", async () => {
    const bundle = bundleFixture(calls);

    const result = await releaseRequestParticipants({
      abortSignal: new AbortController().signal,
      bundle,
      reason: "completed",
      sessionId: "root",
      turnId: "turn_0",
    });

    expect(calls).toEqual([
      "nested:completed:nested",
      "worker:completed:child",
      "root:completed:builtin",
      "root:completed:root",
    ]);
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      "nested",
      "child",
      "builtin",
    ]);
    expect(records.get("child")?.status).toBe("cancelled");
    expect(records.get("builtin")?.status).toBe("cancelled");
    expect(records.get("old-child")?.status).toBe("running");
    expect(fences.has("root")).toBe(false);
    expect(fences.get("child")).toBe("cancelled");
    expect(fences.get("nested")).toBe("cancelled");
    expect(fences.get("builtin")).toBe("cancelled");
    expect(mocks.cancelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        ancestorSessionId: "child",
        sessionId: "child",
        turn: { turnId: "turn_active", turnRunId: "turn-run-active" },
      }),
    );
  });

  it("releases a terminal session tree without cancelling the current root workflow", async () => {
    const bundle = bundleFixture(calls);

    const result = await releaseSessionTree({
      abortSignal: new AbortController().signal,
      bundle,
      cancelRoot: false,
      reason: "failed",
      sessionId: "child",
    });

    expect(calls).toEqual(["nested:failed:nested", "worker:failed:child"]);
    expect(fences.get("child")).toBe("cancelled");
    expect(records.get("child")?.status).toBe("running");
    expect(result.sessions.at(-1)).toEqual({
      sessionId: "child",
      statusAfter: "running",
      statusBefore: "running",
    });
  });

  it("marks only a naturally completing root as completed and cancels its descendants", async () => {
    const bundle = bundleFixture(calls);

    await releaseSessionTree({
      abortSignal: new AbortController().signal,
      bundle,
      cancelRoot: false,
      reason: "completed",
      sessionId: "child",
    });

    expect(fences.get("child")).toBe("completed");
    expect(fences.get("nested")).toBe("cancelled");
  });

  it("continues safe siblings but protects the failed branch and root resource", async () => {
    mocks.cancelTurn.mockRejectedValueOnce(new Error("turn cancellation timed out"));

    await expect(
      releaseRequestParticipants({
        abortSignal: new AbortController().signal,
        bundle: bundleFixture(calls),
        reason: "completed",
        sessionId: "root",
        turnId: "turn_0",
      }),
    ).rejects.toThrow("Request participant release failed for root");

    expect(calls).toEqual(["nested:completed:nested", "root:completed:builtin"]);
    expect(records.get("child")?.status).toBe("cancelled");
    expect(records.get("builtin")?.status).toBe("cancelled");
  });

  it("protects the root resource when a built-in shared-sandbox turn stays active", async () => {
    mocks.cancelTurn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "builtin") throw new Error("built-in turn cancellation timed out");
    });

    await expect(
      releaseRequestParticipants({
        abortSignal: new AbortController().signal,
        bundle: bundleFixture(calls),
        reason: "completed",
        sessionId: "root",
        turnId: "turn_0",
      }),
    ).rejects.toThrow("Request participant release failed for root");

    expect(calls).toEqual(["nested:completed:nested", "worker:completed:child"]);
    expect(records.get("child")?.status).toBe("cancelled");
    expect(records.get("builtin")?.status).toBe("cancelled");
  });

  it("is a no-op for projects without release handlers", async () => {
    const bundle = bundleFixture([] as string[], false);

    await expect(
      releaseSessionTree({
        abortSignal: new AbortController().signal,
        bundle,
        cancelRoot: false,
        reason: "completed",
        sessionId: "nested",
      }),
    ).resolves.toMatchObject({ sessions: [{ sessionId: "nested" }] });
  });
});

interface RunRecord {
  readonly attributes: Record<string, string>;
  readonly runId: string;
  readonly status: string;
}

function run(runId: string, status: string, attributes: Record<string, string>): RunRecord {
  return { attributes, runId, status };
}

function mailbox(sessionId: string, fences: ReadonlyMap<string, "cancelled" | "completed">) {
  const fence = fences.get(sessionId);
  const shared = {
    failedSpawns: [],
    messages: [],
    nextCursor: 10,
    turns: [],
  };
  if (fence !== undefined) Object.assign(shared, { fence: { reason: fence, sequence: 9 } });
  if (sessionId === "root") {
    return {
      ...shared,
      spawned: [
        { callId: "call-child", childSessionId: "child", kind: "spawned", sequence: 1, version: 1 },
        {
          callId: "call-builtin",
          childSessionId: "builtin",
          kind: "spawned",
          sequence: 3,
          version: 1,
        },
        {
          callId: "call-old",
          childSessionId: "old-child",
          kind: "spawned",
          sequence: 5,
          version: 1,
        },
      ],
      spawns: [
        { callId: "call-child", kind: "spawn", sequence: 0, version: 1 },
        { callId: "call-builtin", kind: "spawn", sequence: 2, version: 1 },
        { callId: "call-old", kind: "spawn", sequence: 4, version: 1 },
      ],
    };
  }
  if (sessionId === "child") {
    return {
      ...shared,
      spawned: [
        {
          callId: "call-nested",
          childSessionId: "nested",
          kind: "spawned",
          sequence: 1,
          version: 1,
        },
      ],
      spawns: [{ callId: "call-nested", kind: "spawn", sequence: 0, version: 1 }],
      turns: [
        { kind: "turn", sequence: 2, turnId: "turn_active", version: 1 },
        {
          kind: "turn-started",
          sequence: 3,
          turnId: "turn_active",
          turnRunId: "turn-run-active",
          version: 1,
        },
      ],
    };
  }
  if (sessionId === "builtin") {
    return {
      ...shared,
      spawned: [],
      spawns: [],
      turns: [
        { kind: "turn", sequence: 0, turnId: "turn_builtin", version: 1 },
        {
          kind: "turn-started",
          sequence: 1,
          turnId: "turn_builtin",
          turnRunId: "turn-run-builtin",
          version: 1,
        },
      ],
    };
  }
  return { ...shared, spawned: [], spawns: [] };
}

function bundleFixture(calls: string[], withHandlers = true): CompiledRuntimeAgentBundle {
  const node = (nodeId: string, name: string) => ({
    agent: { config: { name } },
    hookRegistry: createRuntimeHookRegistry(
      withHandlers
        ? [
            {
              events: {},
              exportName: undefined,
              logicalPath: `${nodeId}/hooks/release.ts`,
              release: async (signal, ctx) => {
                calls.push(`${name}:${signal.reason}:${ctx.session.id}`);
              },
              slug: "release",
              sourceId: `${nodeId}/hooks/release.ts`,
              sourceKind: "module",
            },
          ]
        : [],
    ),
    nodeId,
  });
  const root = node("__root__", "root");
  const worker = node("subagents/worker", "worker");
  const nested = node("subagents/worker::subagents/nested", "nested");
  return {
    graph: {
      nodesByNodeId: new Map([
        ["__root__", root],
        ["subagents/worker", worker],
        ["subagents/worker::subagents/nested", nested],
      ]),
      root,
    },
    nodeId: undefined,
  } as never;
}
