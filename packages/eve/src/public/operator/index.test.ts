import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSandboxAccess: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("#execution/sandbox/ensure.js", () => ({
  ensureSandboxAccess: mocks.ensureSandboxAccess,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));
vi.mock("#internal/workflow/runtime.js", () => ({ getRun: mocks.getRun }));

import {
  cancelOperatorWorkflowRun,
  getOperatorWorkflowRunStatus,
  runOperatorSandboxCommand,
} from "./index.js";

describe("operator workflow cancellation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("terminally cancels an active workflow run", async () => {
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

    await expect(cancelOperatorWorkflowRun("wrun_1")).resolves.toEqual({
      runId: "wrun_1",
      statusAfter: "cancelled",
      statusBefore: "running",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads the provider status for an exact workflow run", async () => {
    mocks.getRun.mockReturnValue({ status: Promise.resolve("cancelled") });

    await expect(getOperatorWorkflowRunStatus("wrun_1")).resolves.toBe("cancelled");
    expect(mocks.getRun).toHaveBeenCalledWith("wrun_1");
  });
});

describe("operator sandbox command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the target through the normal session sandbox lifecycle", async () => {
    const sandbox = { id: "sandbox_1" };
    const execute = vi.fn(async (_input, context: ToolExecutionContext) => {
      expect(await context.getSandbox()).toEqual(expect.objectContaining(sandbox));
      return { exitCode: 0, stderr: "", stdout: "CONTROL_OK" };
    });
    const root = node("__root__", "root", execute);
    const worker = node("subagents/worker", "worker", execute);
    const graph = {
      root,
      nodesByNodeId: new Map([
        [root.nodeId, root],
        [worker.nodeId, worker],
      ]),
    };
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ graph });
    mocks.ensureSandboxAccess.mockResolvedValue({ get: vi.fn().mockResolvedValue(sandbox) });

    await expect(
      runOperatorSandboxCommand({
        appRoot: "/app",
        command: "printf CONTROL_OK",
        sessionId: "wrun_1",
        target: "worker",
      }),
    ).resolves.toEqual({
      agentName: "worker",
      exitCode: 0,
      nodeId: "subagents/worker",
      sessionId: "wrun_1",
      stderr: "",
      stdout: "CONTROL_OK",
    });
    expect(mocks.ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "subagents/worker",
        sessionId: "wrun_1",
        state: null,
        tags: { agent: "worker", channel: "operator-sandbox-command", sessionId: "wrun_1" },
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      { command: "printf CONTROL_OK" },
      expect.objectContaining({
        abortSignal: expect.objectContaining({ aborted: false }),
        callId: "operator:wrun_1",
        toolName: "bash",
      }),
      undefined,
    );
  });

  it("aborts and settles a command at the requested timeout", async () => {
    const execute = vi.fn(
      async (_input, context: { abortSignal: AbortSignal }) =>
        await new Promise((_resolve, reject) =>
          context.abortSignal.addEventListener("abort", () => reject(context.abortSignal.reason), {
            once: true,
          }),
        ),
    );
    const root = node("__root__", "root", execute);
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
      graph: { root, nodesByNodeId: new Map([[root.nodeId, root]]) },
    });
    mocks.ensureSandboxAccess.mockResolvedValue({ get: vi.fn() });

    await expect(
      runOperatorSandboxCommand({
        command: "sleep 10",
        sessionId: "wrun_1",
        target: "root",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("bash tool timed out after 5ms");
  });
});

function node(
  nodeId: string,
  name: string,
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>,
) {
  return {
    agent: { config: { name } },
    nodeId,
    sandboxRegistry: { sandbox: {} },
    toolRegistry: { toolsByName: new Map([["bash", { definition: { execute } }]]) },
  };
}

type ToolExecutionContext = {
  readonly abortSignal: AbortSignal;
  getSandbox(): Promise<unknown>;
};
