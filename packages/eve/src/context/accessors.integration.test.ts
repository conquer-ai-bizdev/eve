import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { buildActiveSessionContext } from "#internal/testing/active-session-context.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { mockSkill } from "#internal/testing/mocks/mock-skill.js";
import type { SandboxSession } from "#public/definitions/sandbox.js";
import { contextStorage } from "#context/container.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * Integration coverage for {@link buildCallbackContext} — the single
 * factory that builds the `ctx` object every authored callback receives.
 *
 * Each case runs in-memory through the AppHarness.
 * `runtime.runAsSession(init, fn)` binds the authored context and
 * invokes `fn`. `mockSkill()` owns its own tmpdir cleanup via an
 * internally-registered `afterEach`.
 */

describe("buildCallbackContext – session", () => {
  it("throws when no authored runtime session is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("returns the active session identity across async boundaries", async () => {
    const runtime = createTestRuntime();

    const session = await runtime.runAsSession(
      {
        sessionId: "session_public_session",
        turn: { id: "turn_public_session_001", sequence: 1 },
      },
      async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return buildCallbackContext().session;
      },
    );

    expect(session).toEqual({
      auth: {
        current: null,
        initiator: null,
      },
      id: "session_public_session",
      turn: {
        id: "turn_public_session_001",
        sequence: 1,
      },
    });
  });

  it("preserves parent lineage on the public session", async () => {
    const runtime = createTestRuntime();

    const session = await runtime.runAsSession(
      {
        parent: {
          callId: "call_parent_001",
          rootSessionId: "session_parent",
          sessionId: "session_parent",
          turn: { id: "turn_parent_001", sequence: 3 },
        },
        sessionId: "session_public_child",
        turn: { id: "turn_public_child_001", sequence: 1 },
      },
      () => buildCallbackContext().session,
    );

    expect(session.parent).toEqual({
      callId: "call_parent_001",
      rootSessionId: "session_parent",
      sessionId: "session_parent",
      turn: { id: "turn_parent_001", sequence: 3 },
    });
  });
});

describe("buildCallbackContext – agent", () => {
  it("returns the active root identity and supports graph lookup", async () => {
    const runtime = createTestRuntime({ agent: { name: "root-agent" } });

    const result = await runtime.runAsSession({}, () => {
      const ctx = buildCallbackContext();
      return {
        active: ctx.agent,
        activeFrozen: Object.isFrozen(ctx.agent),
        lookup: ctx.getAgent(ctx.agent.nodeId),
        missing: ctx.getAgent("subagents/missing"),
        prototypeName: ctx.getAgent("toString"),
      };
    });

    expect(result.active).toEqual({
      behaviorRevision: runtime.manifest.behaviorRevision,
      name: "root-agent",
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    });
    expect(result.lookup).toEqual(result.active);
    expect(result.missing).toBeUndefined();
    expect(result.prototypeName).toBeUndefined();
    expect(result.activeFrozen).toBe(true);
  });

  it("returns the selected subagent while retaining lookup of the root", async () => {
    const childNodeId = "subagents/reviewer";
    const rootRevision = "1".repeat(64);
    const childRevision = "2".repeat(64);
    const childAgent = createCompiledAgentNodeManifest({
      agentRoot: "/app/agent/subagents/reviewer",
      appRoot: "/app",
      behaviorRevision: childRevision,
      config: {
        description: "Review one result.",
        model: { id: "openai/gpt-5.4", routing: classifyModelRouting("openai/gpt-5.4") },
        name: "reviewer",
      },
    });
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      behaviorRevision: rootRevision,
      config: {
        model: { id: "openai/gpt-5.4", routing: classifyModelRouting("openai/gpt-5.4") },
        name: "root-agent",
      },
      subagentEdges: [{ childNodeId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID }],
      subagents: [
        {
          agent: childAgent,
          description: "Review one result.",
          entryPath: "/app/agent/subagents/reviewer",
          logicalPath: childNodeId,
          name: "reviewer",
          nodeId: childNodeId,
          rootPath: "/app/agent/subagents/reviewer",
          sourceId: childNodeId,
          sourceKind: "module",
        },
      ],
    });

    const result = await withBundledCompiledArtifacts(
      {
        manifest,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
            [childNodeId]: { modules: {} },
          },
        },
      },
      async () => {
        const bundle = await getCompiledRuntimeAgentBundle({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          nodeId: childNodeId,
        });
        const context = buildActiveSessionContext({
          bundle,
          sessionId: "session_child",
          turn: { id: "turn_child", sequence: 1 },
        });

        return await contextStorage.run(context, () => {
          const ctx = buildCallbackContext();
          return { active: ctx.agent, root: ctx.getAgent(ROOT_COMPILED_AGENT_NODE_ID) };
        });
      },
    );

    expect(result.active).toEqual({
      behaviorRevision: childRevision,
      name: "reviewer",
      nodeId: childNodeId,
    });
    expect(result.root).toEqual({
      behaviorRevision: rootRevision,
      name: "root-agent",
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    });
  });
});

describe("buildCallbackContext – getSandbox", () => {
  it("throws when no authored runtime context is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("returns the active authored sandbox across async boundaries", async () => {
    const sandboxId = "sbx_public_sandbox";
    const sandbox = mockSandbox({
      id: sandboxId,
      commands: {
        "echo ready": { exitCode: 0, stderr: "", stdout: "ready" },
      },
    });
    const runtime = createTestRuntime();

    const live = (await runtime.runAsSession({ sandbox }, async () => {
      await Promise.resolve();
      return await buildCallbackContext().getSandbox();
    })) as SandboxSession;

    await live.run({ command: "echo ready" });

    expect(sandbox.commandLog).toEqual(["echo ready"]);
    expect(live.id).toBe(sandboxId);
  });

  it("passes file operations through the expanded session surface", async () => {
    const sandbox = mockSandbox({
      id: "sbx_public_sandbox_file",
      initialFiles: { "note.txt": "file content" },
    });
    const runtime = createTestRuntime();

    const live = (await runtime.runAsSession(
      { sandbox },
      async () => await buildCallbackContext().getSandbox(),
    )) as SandboxSession;

    const content = await live.readTextFile({ path: "note.txt" });
    await live.writeTextFile({ content: "updated", path: "note.txt" });
    await live.removePath({ force: true, path: "note.txt" });

    expect(content).toBe("file content");
    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.removedPaths).toEqual(["/workspace/note.txt"]);
    expect(sandbox.files.has("/workspace/note.txt")).toBe(false);
  });
});

describe("buildCallbackContext – getSkill", () => {
  it("throws when no authored runtime context is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("throws when authored runtime execution does not include skill access", async () => {
    const runtime = createTestRuntime();

    await expect(
      runtime.runAsSession({}, () => buildCallbackContext().getSkill("semantic-model")),
    ).rejects.toThrow("eve sandbox runtime access is unavailable in the current async context.");
  });

  it("resolves visible skill files across async boundaries", async () => {
    const skill = await mockSkill({
      name: "semantic-model",
      description: "Inspect the semantic model.",
      markdown: "Inspect the semantic model.",
      references: { "catalog.yml": "entities: []\n" },
    });

    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/semantic-model/SKILL.md": "Inspect the semantic model.",
        "/workspace/skills/semantic-model/references/catalog.yml": "entities: []\n",
      },
    });
    const runtime = createTestRuntime({ skills: [skill.source] });

    const result = await runtime.runAsSession({ sandbox }, async () => {
      await Promise.resolve();
      const ctx = buildCallbackContext();

      return {
        skill: ctx.getSkill("semantic-model"),
        text: await ctx.getSkill("semantic-model").file("references/catalog.yml").text(),
      };
    });

    expect(result.skill.name).toBe("semantic-model");
    await expect(result.skill.file("SKILL.md").text()).resolves.toBe("Inspect the semantic model.");
    await expect(result.skill.file("references/catalog.yml").text()).resolves.toBe(
      "entities: []\n",
    );
    expect(result.text).toBe("entities: []\n");
  });
});
