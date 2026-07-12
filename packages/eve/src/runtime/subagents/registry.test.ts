import { describe, expect, it } from "vitest";

import type { ResolvedRuntimeDelegationNode } from "#runtime/types.js";

import { createRuntimeSubagentRegistry } from "./registry.js";

describe("createRuntimeSubagentRegistry", () => {
  it("advertises background mode only for local descendants", () => {
    const registry = createRuntimeSubagentRegistry({
      subagents: [localNode(), remoteNode()],
    });

    const localSchema = registry.subagentsByName.get("local")!.prepared.inputSchema;
    const remoteSchema = registry.subagentsByName.get("remote")!.prepared.inputSchema;
    if (localSchema === null || remoteSchema === null) throw new Error("Expected object schemas");

    expect(localSchema.properties).toHaveProperty("mode");
    expect(remoteSchema.properties).not.toHaveProperty("mode");
  });
});

function localNode(): ResolvedRuntimeDelegationNode {
  return {
    description: "Local descendant",
    kind: "subagent",
    logicalPath: "agent/subagents/local",
    name: "local",
    nodeId: "subagents/local",
    sourceId: "source:local",
    sourceKind: "module",
  };
}

function remoteNode(): ResolvedRuntimeDelegationNode {
  return {
    description: "Remote agent",
    kind: "remote",
    logicalPath: "agent/subagents/remote",
    name: "remote",
    nodeId: "remote/remote",
    path: "/eve/v1/session",
    sourceId: "source:remote",
    sourceKind: "module",
    url: "https://remote.example.com",
  };
}
