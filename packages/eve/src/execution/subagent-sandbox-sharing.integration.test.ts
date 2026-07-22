import { afterEach, describe, expect, it } from "vitest";

import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { buildSubagentRunInput } from "#execution/subagent-tool.js";
import type { HarnessSession } from "#harness/types.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import type { SandboxState } from "#sandbox/state.js";

afterEach(async () => {
  await shutdownActiveSandboxHandles();
});

const createTemporaryAppRoot = useTemporaryAppRoots();

function createRegistry(): RuntimeSandboxRegistry {
  const definition: ResolvedSandboxDefinition = {
    backend: createJustBashSandboxBackend(),
    logicalPath: "agent/sandbox.ts",
    sourceHash: "shared-agent-sandbox-test",
    sourceId: "agent/sandbox",
    sourceKind: "module",
  };

  return {
    sandbox: {
      definition,
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

function createSession(sessionId: string): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: `${sessionId}-token`,
    history: [],
    sessionId,
  };
}

function createAgentAction(callId: string): RuntimeSubagentCallActionRequest {
  return {
    callId,
    description: "Delegate to a fresh copy of this agent.",
    input: { message: `Complete ${callId}.` },
    kind: "subagent-call",
    name: "agent",
    nodeId: "__root__",
    subagentName: "agent",
  };
}

function buildAgentCopy(input: {
  readonly callId: string;
  readonly inheritedSandboxSessionId?: string;
  readonly session: HarnessSession;
}) {
  return buildSubagentRunInput({
    action: createAgentAction(input.callId),
    auth: null,
    batchEvent: { sequence: 0, turnId: "turn-0" },
    inheritedSandboxSessionId: input.inheritedSandboxSessionId,
    initiatorAuth: null,
    session: input.session,
    source: { type: "runtime" },
  }).runInput;
}

function readSharedSandboxInput(runInput: ReturnType<typeof buildAgentCopy>): {
  readonly sessionId: string;
  readonly state: SandboxState | null;
} {
  const state = runInput.adapter.state as Record<string, unknown>;

  return {
    sessionId: state.sandboxSessionId as string,
    state: (state.parentSandboxState as SandboxState | undefined) ?? null,
  };
}

describe("built-in agent sandbox sharing", () => {
  it("shares first-turn files across concurrent and nested copies", async () => {
    const { appRoot } = await createTemporaryAppRoot("eve-agent-sandbox-sharing-");
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const registry = createRegistry();
    const rootSession = createSession("root-session");
    const rootAccess = await ensureSandboxAccess({
      compiledArtifactsSource,
      nodeId: "__root__",
      registry,
      sessionId: rootSession.sessionId,
      state: null,
    });
    const rootSandbox = await rootAccess.get();

    expect(rootSandbox).not.toBeNull();
    await rootSandbox!.writeTextFile({ content: "parent evidence", path: "source.txt" });

    const childRuns = [
      buildAgentCopy({ callId: "child-a", session: rootSession }),
      buildAgentCopy({ callId: "child-b", session: rootSession }),
    ];
    const childSandboxes = await Promise.all(
      childRuns.map(async (runInput, index) => {
        const access = await ensureSandboxAccess({
          compiledArtifactsSource,
          nodeId: "__root__",
          registry,
          ...readSharedSandboxInput(runInput),
        });
        const sandbox = await access.get();

        expect(await sandbox!.readTextFile({ path: "source.txt" })).toBe("parent evidence");
        await sandbox!.writeTextFile({
          content: `child ${index + 1}`,
          path: `child-${index + 1}.txt`,
        });
        return sandbox!;
      }),
    );

    const inheritedSandboxSessionId = (childRuns[0]!.adapter.state as Record<string, unknown>)
      .sandboxSessionId as string;
    const nestedRun = buildAgentCopy({
      callId: "grandchild",
      inheritedSandboxSessionId,
      session: createSession("child-a-session"),
    });
    const nestedAccess = await ensureSandboxAccess({
      compiledArtifactsSource,
      nodeId: "__root__",
      registry,
      ...readSharedSandboxInput(nestedRun),
    });
    const nestedSandbox = await nestedAccess.get();

    expect(await nestedSandbox!.readTextFile({ path: "source.txt" })).toBe("parent evidence");
    await nestedSandbox!.writeTextFile({ content: "nested child", path: "nested.txt" });

    expect(childSandboxes).toHaveLength(2);
    await expect(rootSandbox!.readTextFile({ path: "child-1.txt" })).resolves.toBe("child 1");
    await expect(rootSandbox!.readTextFile({ path: "child-2.txt" })).resolves.toBe("child 2");
    await expect(rootSandbox!.readTextFile({ path: "nested.txt" })).resolves.toBe("nested child");
  });
});
