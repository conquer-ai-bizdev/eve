import { describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  loadDynamicRuntimeModelDefinition,
  normalizeDynamicRuntimeModelResult,
  resolveRuntimeModelReference,
} from "#runtime/agent/resolve-model.js";

vi.mock("#runtime/agent/mock-model-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/agent/mock-model-adapter.js")>()),
  resolveMockAuthoredRuntimeModel: () => null,
}));

const DYNAMIC_MODEL_SOURCE = {
  eventNames: ["session.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module" as const,
};

describe("dynamic runtime model resolution", () => {
  it("loads dynamic model definitions and normalizes string selections", async () => {
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": (_event, ctx) =>
              ctx.channel.kind === "slack"
                ? {
                    model: "openai/gpt-5.5-mini",
                    modelContextWindowTokens: 128_000,
                    modelOptions: {
                      providerOptions: { gateway: { order: ["openai"] } },
                    },
                  }
                : null,
          },
        }),
      },
    });

    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      scope: { moduleMap, nodeId: undefined },
    });
    const result = await definition.events["session.started"]?.(
      { type: "session.started" },
      {
        channel: { kind: "slack" },
        messages: [{ content: "Hi", role: "user" }],
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(result).not.toBeNull();
    if (result === null || result === undefined) throw new Error("expected selection");

    const resolved = normalizeDynamicRuntimeModelResult({
      fallback: { contextWindowTokens: 256_000, id: "openai/gpt-5.5" },
      result,
    });

    expect(resolved).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        providerOptions: { gateway: { order: ["openai"] } },
      },
    });
  });

  it("inherits fallback provider options but never the fallback context window", () => {
    const resolved = normalizeDynamicRuntimeModelResult({
      fallback: {
        contextWindowTokens: 256_000,
        id: "openai/gpt-5.5",
        providerOptions: { gateway: { order: ["openai"] } },
      },
      result: "openai/gpt-5.5-mini",
    });

    expect(resolved.reference).toEqual({
      contextWindowTokens: undefined,
      id: "openai/gpt-5.5-mini",
      providerOptions: { gateway: { order: ["openai"] } },
    });
  });

  it("rejects selections with unknown keys", () => {
    expect(() =>
      normalizeDynamicRuntimeModelResult({
        fallback: { id: "openai/gpt-5.5" },
        result: {
          model: "openai/gpt-5.5-mini",
          contextWindowTokens: 128_000,
        } as never,
      }),
    ).toThrowError(/unknown key\(s\): contextWindowTokens/);
  });
});

describe("source-backed runtime model resolution", () => {
  it("hydrates the authored compaction model even when both models have the same id", async () => {
    const primaryModel = createLanguageModel();
    const compactionModel = createLanguageModel();
    const moduleMap = createModuleMap({
      default: {
        compaction: { model: compactionModel },
        model: primaryModel,
      },
    });
    const scope = { moduleMap, nodeId: undefined };
    const source = {
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module" as const,
    };

    await expect(
      resolveRuntimeModelReference({ id: "test/same-model", source }, scope),
    ).resolves.toBe(primaryModel);
    await expect(
      resolveRuntimeModelReference(
        {
          authoredModelSlot: "compaction",
          id: "test/same-model",
          source,
        },
        scope,
      ),
    ).resolves.toBe(compactionModel);
  });
});

function createLanguageModel() {
  return {
    doGenerate: () => undefined,
    doStream: () => undefined,
    modelId: "same-model",
    provider: "test",
    specificationVersion: "v3" as const,
  } as never;
}

function createModuleMap(moduleNamespace: Record<string, unknown>): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [DYNAMIC_MODEL_SOURCE.sourceId]: moduleNamespace,
        },
      },
    },
  };
}
