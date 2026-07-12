import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAuthoredSource: vi.fn(() => ({ appRoot: "/app", kind: "disk" as const })),
  createBundledSource: vi.fn(() => ({ kind: "bundled" as const })),
  ensureSandboxAccess: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  getRun: vi.fn(),
  getWorld: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: mocks.getRun,
  getWorld: mocks.getWorld,
}));
vi.mock("#internal/application/runtime-compiled-artifacts-source.js", () => ({
  createAuthoredSourceRuntimeCompiledArtifactsSource: mocks.createAuthoredSource,
}));
vi.mock("#execution/sandbox/ensure.js", () => ({
  ensureSandboxAccess: mocks.ensureSandboxAccess,
}));
vi.mock("#runtime/compiled-artifacts-source.js", () => ({
  createBundledRuntimeCompiledArtifactsSource: mocks.createBundledSource,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

import {
  cancelOperatorWorkflowRun,
  createOperatorWorkflowClient,
  listOperatorSandboxTargets,
  runOperatorSandboxCommand,
} from "./index.js";

describe("operator workflow API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads metadata-only runs, steps, and events", async () => {
    const run = { runId: "run-1", status: "running" };
    const step = { runId: "run-1", status: "completed", stepId: "step-1", stepName: "work" };
    const event = { eventId: "event-1", runId: "run-1" };
    const world = {
      events: { list: vi.fn(async () => page(event)) },
      runs: {
        get: vi.fn(async () => run),
        list: vi.fn(async () => page(run)),
      },
      steps: { list: vi.fn(async () => page(step)) },
    };
    mocks.getWorld.mockResolvedValue(world);

    const client = await createOperatorWorkflowClient();
    await expect(client.getRun("run-1")).resolves.toBe(run);
    await expect(
      client.listRuns({ pagination: { limit: 20, sortOrder: "desc" }, status: "running" }),
    ).resolves.toEqual(page(run));
    await expect(
      client.listSteps({ pagination: { cursor: "next", limit: 100 }, runId: "run-1" }),
    ).resolves.toEqual(page(step));
    await expect(
      client.listEvents({ pagination: { limit: 100 }, runId: "run-1" }),
    ).resolves.toEqual(page(event));

    expect(world.runs.get).toHaveBeenCalledWith("run-1", { resolveData: "none" });
    expect(world.runs.list).toHaveBeenCalledWith({
      pagination: { limit: 20, sortOrder: "desc" },
      resolveData: "none",
      status: "running",
    });
    expect(world.steps.list).toHaveBeenCalledWith({
      pagination: { cursor: "next", limit: 100 },
      resolveData: "none",
      runId: "run-1",
    });
  });

  it("cancels an active run and reports before and after status", async () => {
    let status = "running";
    const cancel = vi.fn(async () => {
      status = "cancelled";
    });
    mocks.getRun.mockReturnValue({
      cancel,
      get status() {
        return Promise.resolve(status);
      },
    });

    await expect(cancelOperatorWorkflowRun("run-1")).resolves.toEqual({
      runId: "run-1",
      statusAfter: "cancelled",
      statusBefore: "running",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves a terminal run unchanged", async () => {
    const cancel = vi.fn();
    mocks.getRun.mockReturnValue({ cancel, status: Promise.resolve("completed") });

    await expect(cancelOperatorWorkflowRun("run-1")).resolves.toMatchObject({
      statusAfter: "completed",
      statusBefore: "completed",
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("operator sandbox API", () => {
  const originalVercel = process.env.VERCEL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL;
    mocks.ensureSandboxAccess.mockResolvedValue({ captureState: vi.fn(), get: vi.fn() });
  });

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("lists root and child targets from authored artifacts", async () => {
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ graph: graphFixture() });

    await expect(listOperatorSandboxTargets("/app")).resolves.toEqual([
      { hasSandbox: true, id: "__root__", name: "root" },
      { hasSandbox: true, id: "subagents/worker", name: "worker" },
    ]);
    expect(mocks.createAuthoredSource).toHaveBeenCalledWith("/app");
    expect(mocks.getCompiledRuntimeAgentBundle).toHaveBeenCalledWith({
      compiledArtifactsSource: { appRoot: "/app", kind: "disk" },
    });
  });

  it("loads bundled artifacts in a hosted runtime", async () => {
    process.env.VERCEL = "1";
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ graph: graphFixture() });

    await listOperatorSandboxTargets("/ignored");

    expect(mocks.createBundledSource).toHaveBeenCalled();
    expect(mocks.getCompiledRuntimeAgentBundle).toHaveBeenCalledWith({
      compiledArtifactsSource: { kind: "bundled" },
    });
  });

  it("normalizes a child target and executes its resolved Bash tool", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "CONTROL_OK" }));
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ graph: graphFixture(execute) });

    await expect(
      runOperatorSandboxCommand({
        appRoot: "/app",
        command: "printf CONTROL_OK",
        sessionId: "operator-1",
        target: "worker",
      }),
    ).resolves.toEqual({
      agentName: "worker",
      exitCode: 0,
      nodeId: "subagents/worker",
      sessionId: "operator-1",
      stderr: "",
      stdout: "CONTROL_OK",
    });
    expect(execute).toHaveBeenCalledWith(
      { command: "printf CONTROL_OK" },
      { messages: [], toolCallId: "operator:operator-1" },
    );
    expect(mocks.ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "subagents/worker",
        sessionId: "operator-1",
        tags: {
          agent: "worker",
          channel: "operator-sandbox-command",
          sessionId: "operator-1",
        },
      }),
    );
  });

  it("rejects a node without a sandbox", async () => {
    const graph = graphFixture();
    (graph.nodesByNodeId.get("subagents/worker")!.sandboxRegistry as { sandbox: unknown }).sandbox =
      null;
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ graph });

    await expect(
      runOperatorSandboxCommand({
        command: "true",
        sessionId: "operator-1",
        target: "worker",
      }),
    ).rejects.toThrow('Node "subagents/worker" has no sandbox configured.');
  });

  it("times out a command that does not settle", async () => {
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
      graph: graphFixture(async () => await new Promise(() => {})),
    });

    await expect(
      runOperatorSandboxCommand({
        command: "sleep forever",
        sessionId: "operator-1",
        target: "worker",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("bash tool timed out after 5ms");
  });
});

function page<T>(item: T) {
  return { cursor: null, data: [item], hasMore: false };
}

function graphFixture(
  execute: (input: unknown, options: unknown) => Promise<unknown> = async () => ({
    exitCode: 0,
    stderr: "",
    stdout: "",
  }),
) {
  const root = nodeFixture("__root__", "root", execute);
  const worker = nodeFixture("subagents/worker", "worker", execute);
  return {
    nodesByNodeId: new Map([
      [root.nodeId, root],
      [worker.nodeId, worker],
    ]),
    root,
  };
}

function nodeFixture(
  nodeId: string,
  name: string,
  execute: (input: unknown, options: unknown) => Promise<unknown>,
) {
  return {
    agent: { config: { name } },
    nodeId,
    sandboxRegistry: { sandbox: {} },
    toolRegistry: { toolsByName: new Map([["bash", { definition: { execute } }]]) },
  };
}
