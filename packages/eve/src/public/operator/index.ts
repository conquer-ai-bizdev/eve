import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

export interface OperatorSandboxCommandOptions {
  readonly appRoot?: string;
  readonly command: string;
  readonly sessionId: string;
  readonly target: string;
  readonly timeoutMs?: number;
}

export interface OperatorSandboxCommandResult {
  readonly agentName: string;
  readonly exitCode: number;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs one command through the target agent's sandbox lifecycle and Bash tool. */
export async function runOperatorSandboxCommand(
  options: OperatorSandboxCommandOptions,
): Promise<OperatorSandboxCommandResult> {
  const command = options.command.trim();
  if (!command) throw new Error("command is required");

  const compiledArtifactsSource = process.env.VERCEL
    ? createBundledRuntimeCompiledArtifactsSource()
    : createAuthoredSourceRuntimeCompiledArtifactsSource(options.appRoot ?? process.cwd());
  const graph = (await getCompiledRuntimeAgentBundle({ compiledArtifactsSource })).graph;
  const nodeId = normalizeTarget(options.target);
  const node = nodeId === "__root__" ? graph.root : graph.nodesByNodeId.get(nodeId);
  if (!node) {
    throw new Error(
      `Unsupported operator sandbox target "${options.target}". Supported: ${[...graph.nodesByNodeId.keys()].sort().join(", ")}`,
    );
  }
  if (node.sandboxRegistry.sandbox === null) {
    throw new Error(`Node "${node.nodeId}" has no sandbox configured.`);
  }

  const context = new ContextContainer();
  context.set(SessionIdKey, options.sessionId);
  context.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: options.sessionId,
    turn: { id: `operator:${options.sessionId}`, sequence: 0 },
  });
  const bundleOptions: {
    compiledArtifactsSource: typeof compiledArtifactsSource;
    nodeId?: string;
  } = {
    compiledArtifactsSource,
  };
  if (node.nodeId !== "__root__") bundleOptions.nodeId = node.nodeId;
  const nodeBundle = await getCompiledRuntimeAgentBundle(bundleOptions);
  context.set(BundleKey, nodeBundle);

  const sandboxAccess = await ensureSandboxAccess({
    compiledArtifactsSource,
    nodeId: node.nodeId,
    registry: node.sandboxRegistry,
    runOnSession: async (callback) => await contextStorage.run(context, callback),
    sessionId: options.sessionId,
    state: null,
    tags: {
      agent: node.agent.config!.name,
      channel: "operator-sandbox-command",
      sessionId: options.sessionId,
    },
  });
  context.set(SandboxKey, sandboxAccess);

  const execute = node.toolRegistry.toolsByName.get("bash")?.definition.execute;
  if (!execute) throw new Error(`Node "${node.nodeId}" has no resolved bash tool.`);
  const result = await withTimeout(
    async (abortSignal) =>
      await contextStorage.run(
        context,
        async () =>
          await execute(
            { command },
            { abortSignal, messages: [], toolCallId: `operator:${options.sessionId}` },
          ),
      ),
    options.timeoutMs ?? 120_000,
  );
  const output = normalizeResult(result);
  return {
    agentName: node.agent.config!.name,
    nodeId: node.nodeId,
    sessionId: options.sessionId,
    ...output,
  };
}

function normalizeTarget(target: string): string {
  const value = target.trim();
  if (!value || value === "agent" || value === "root" || value === "__root__") return "__root__";
  return value.startsWith("subagents/") ? value : `subagents/${value}`;
}

function normalizeResult(result: unknown): { exitCode: number; stderr: string; stdout: string } {
  if (!result || typeof result !== "object") {
    return {
      exitCode: 0,
      stderr: "",
      stdout: typeof result === "string" ? result : JSON.stringify(result),
    };
  }
  const value = result as { exitCode?: unknown; stderr?: unknown; stdout?: unknown };
  return {
    exitCode: typeof value.exitCode === "number" ? value.exitCode : 1,
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    stdout: typeof value.stdout === "string" ? value.stdout : "",
  };
}

async function withTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`bash tool timed out after ${timeoutMs}ms`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();
  try {
    const result = await execute(controller.signal);
    if (timedOut) throw timeoutError;
    return result;
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
