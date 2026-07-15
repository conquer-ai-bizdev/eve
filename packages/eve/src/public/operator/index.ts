import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { resolveSandboxTemplateKeys } from "#execution/sandbox/prewarm.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { releaseSessionTree } from "#execution/release-participants.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("operator");

export interface OperatorWorkflowRunRecord {
  readonly attributes?: Record<string, string>;
  readonly completedAt?: Date | string;
  readonly createdAt?: Date | string;
  readonly deploymentId?: string;
  readonly errorCode?: string;
  readonly runId: string;
  readonly specVersion?: number;
  readonly startedAt?: Date | string;
  readonly status: string;
  readonly updatedAt?: Date | string;
  readonly workflowName?: string;
}

export interface OperatorWorkflowStepRecord {
  readonly attempt?: number;
  readonly completedAt?: Date | string;
  readonly createdAt?: Date | string;
  readonly runId: string;
  readonly startedAt?: Date | string;
  readonly status: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly updatedAt?: Date | string;
}

export interface OperatorWorkflowEventRecord {
  readonly correlationId?: string;
  readonly createdAt?: Date | string;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly runId?: string;
  readonly specVersion?: number;
}

export interface OperatorPage<T> {
  readonly cursor: string | null;
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly pageInfo?: {
    readonly currentLookbackDays: number;
    readonly currentWindowStart: Date | string;
    readonly maxLookbackDays: number;
    readonly maxWindowStart: Date | string;
    readonly upgradeAvailable: boolean;
  };
}

export interface OperatorPagination {
  readonly cursor?: string;
  readonly limit: number;
  /** Sorts workflow records by creation time. */
  readonly sortOrder?: "asc" | "desc";
}

export type OperatorWorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface OperatorWorkflowClient {
  getRun(runId: string): Promise<OperatorWorkflowRunRecord>;
  listEvents(input: {
    readonly pagination: OperatorPagination;
    readonly runId: string;
  }): Promise<OperatorPage<OperatorWorkflowEventRecord>>;
  listRuns(input: {
    readonly pagination: OperatorPagination;
    readonly status?: OperatorWorkflowRunStatus;
  }): Promise<OperatorPage<OperatorWorkflowRunRecord>>;
  listObservedRuns(input: {
    /** Optional upper bound for the run activity window. Supply with `startTime`. */
    readonly endTime?: string;
    readonly pagination: OperatorPagination;
    /** Optional lower bound for the run activity window. Supply with `endTime`. */
    readonly startTime?: string;
    readonly status?: OperatorWorkflowRunStatus;
  }): Promise<OperatorPage<OperatorWorkflowRunRecord>>;
  listSteps(input: {
    readonly pagination: OperatorPagination;
    readonly runId: string;
  }): Promise<OperatorPage<OperatorWorkflowStepRecord>>;
}

export interface OperatorWorkflowCancellationResult {
  readonly runId: string;
  readonly statusAfter: string;
  readonly statusBefore: string;
}

export interface OperatorSandboxTarget {
  readonly hasSandbox: boolean;
  readonly id: string;
  readonly name: string;
}

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

/** Creates a metadata-only reader over Eve's active workflow world. */
export async function createOperatorWorkflowClient(): Promise<OperatorWorkflowClient> {
  const world = await getWorld();

  return {
    async getRun(runId) {
      return (await world.runs.get(runId, { resolveData: "none" })) as OperatorWorkflowRunRecord;
    },
    async listEvents(input) {
      return (await world.events.list({
        pagination: input.pagination,
        resolveData: "none",
        runId: input.runId,
      })) as OperatorPage<OperatorWorkflowEventRecord>;
    },
    async listRuns(input) {
      const query = {
        pagination: input.pagination,
        resolveData: "none",
      } as const;
      if (input.status !== undefined) Object.assign(query, { status: input.status });
      return (await world.runs.list(query)) as OperatorPage<OperatorWorkflowRunRecord>;
    },
    async listObservedRuns(input) {
      if (world.analytics === undefined) {
        throw new Error("Eve operator run listing requires Workflow analytics support.");
      }
      const query = {
        pagination: input.pagination,
      };
      if (input.endTime !== undefined) Object.assign(query, { endTime: input.endTime });
      if (input.startTime !== undefined) Object.assign(query, { startTime: input.startTime });
      if (input.status !== undefined) Object.assign(query, { status: input.status });
      return (await world.analytics.runs.list(query)) as OperatorPage<OperatorWorkflowRunRecord>;
    },
    async listSteps(input) {
      return (await world.steps.list({
        pagination: input.pagination,
        resolveData: "none",
        runId: input.runId,
      })) as OperatorPage<OperatorWorkflowStepRecord>;
    },
  };
}

/** Cancels a workflow run unless it is already terminal. */
export async function cancelOperatorWorkflowRun(
  runId: string,
  appRoot = process.cwd(),
): Promise<OperatorWorkflowCancellationResult> {
  const run = getRun(runId);
  const statusBefore = await readRunStatus(run);
  if (!isTerminalRunStatus(statusBefore)) {
    try {
      const { bundle } = await loadOperatorRuntime(appRoot);
      await releaseSessionTree({
        abortSignal: AbortSignal.timeout(30_000),
        bundle,
        cancelRoot: false,
        reason: "cancelled",
        sessionId: runId,
      });
    } catch (error) {
      logError(log, "release before operator cancellation failed", error, { runId });
    }
    await run.cancel();
  }
  return {
    runId,
    statusAfter: await readRunStatus(run),
    statusBefore,
  };
}

/** Lists authored agent nodes and whether each node has a sandbox. */
export async function listOperatorSandboxTargets(
  appRoot = process.cwd(),
): Promise<readonly OperatorSandboxTarget[]> {
  const { bundle } = await loadOperatorRuntime(appRoot);
  const graph = bundle.graph;
  return [...graph.nodesByNodeId.values()]
    .map((node) => ({
      hasSandbox: node.sandboxRegistry.sandbox !== null,
      id: node.nodeId,
      name: node.agent.config.name,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Returns the exact template sandbox names referenced by the current build. */
export async function listOperatorSandboxTemplateKeys(
  appRoot = process.cwd(),
): Promise<readonly string[]> {
  const { bundle, compiledArtifactsSource } = await loadOperatorRuntime(appRoot);
  return await resolveSandboxTemplateKeys({
    compiledArtifactsSource,
    graph: bundle.graph,
  });
}

/** Runs one command through the target node's resolved Bash tool. */
export async function runOperatorSandboxCommand(
  options: OperatorSandboxCommandOptions,
): Promise<OperatorSandboxCommandResult> {
  const command = options.command.trim();
  if (!command) throw new Error("command is required");

  const { bundle: rootBundle, compiledArtifactsSource } = await loadOperatorRuntime(
    options.appRoot ?? process.cwd(),
  );
  const graph = rootBundle.graph;
  const nodeId = normalizeSandboxTarget(options.target);
  const node = nodeId === "__root__" ? graph.root : graph.nodesByNodeId.get(nodeId);
  if (node === undefined) {
    throw new Error(
      `Unsupported operator sandbox target "${options.target}". Supported: ${[
        ...graph.nodesByNodeId.keys(),
      ]
        .sort()
        .join(", ")}`,
    );
  }
  if (node.sandboxRegistry.sandbox === null) {
    throw new Error(`Node "${node.nodeId}" has no sandbox configured.`);
  }

  const context = new ContextContainer();
  context.set(SessionIdKey, options.sessionId);
  context.set(SessionKey, {
    auth: { current: null, initiator: null },
    parent: undefined,
    sessionId: options.sessionId,
    turn: undefined,
  } as never);
  const bundleOptions = {
    compiledArtifactsSource,
  };
  if (node.nodeId !== "__root__") Object.assign(bundleOptions, { nodeId: node.nodeId });
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
      agent: node.agent.config.name,
      channel: "operator-sandbox-command",
      sessionId: options.sessionId,
    },
  });
  context.set(SandboxKey, sandboxAccess);

  const execute = node.toolRegistry.toolsByName.get("bash")?.definition.execute;
  if (execute === undefined) {
    throw new Error(`Node "${node.nodeId}" has no resolved bash tool.`);
  }

  const result = await withAbortTimeout(
    async (abortSignal) =>
      await contextStorage.run(context, async () => {
        return await execute(
          { command },
          { abortSignal, messages: [], toolCallId: `operator:${options.sessionId}` },
        );
      }),
    options.timeoutMs ?? 120_000,
  );
  const output = normalizeCommandResult(result);
  return {
    agentName: node.agent.config.name,
    exitCode: output.exitCode,
    nodeId: node.nodeId,
    sessionId: options.sessionId,
    stderr: output.stderr,
    stdout: output.stdout,
  };
}

async function loadOperatorRuntime(appRoot: string) {
  const hosted = Boolean(process.env.VERCEL);
  const compiledArtifactsSource = hosted
    ? createBundledRuntimeCompiledArtifactsSource()
    : createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot);
  return {
    compiledArtifactsSource,
    bundle: await getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
  };
}

async function readRunStatus(run: { readonly status: Promise<unknown> }): Promise<string> {
  const status = await run.status;
  return typeof status === "string" ? status : JSON.stringify(status);
}

function isTerminalRunStatus(status: string): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function normalizeSandboxTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed || trimmed === "root" || trimmed === "__root__") return "__root__";
  return trimmed.startsWith("subagents/") ? trimmed : `subagents/${trimmed}`;
}

function normalizeCommandResult(result: unknown): {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
} {
  if (result !== null && typeof result === "object") {
    const value = result as {
      readonly exitCode?: unknown;
      readonly stderr?: unknown;
      readonly stdout?: unknown;
    };
    return {
      exitCode: typeof value.exitCode === "number" ? value.exitCode : 1,
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      stdout: typeof value.stdout === "string" ? value.stdout : "",
    };
  }
  return {
    exitCode: 0,
    stderr: "",
    stdout: typeof result === "string" ? result : JSON.stringify(result),
  };
}

async function withAbortTimeout<T>(
  execute: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`bash tool timed out after ${timeoutMs}ms`);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, timeoutMs);
    timer.unref?.();

    const result = await execute(controller.signal);
    if (timedOut) throw timeoutError;
    return result;
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
