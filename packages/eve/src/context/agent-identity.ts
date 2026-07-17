import type { ContextReader } from "#context/key.js";
import { ContextKey, resolveKey } from "#context/key.js";

/** Compiler-owned identity of one local agent graph node. */
export interface AgentIdentity {
  /** Content-derived revision of the node's compiled behavior. */
  readonly behaviorRevision: string;
  /** Agent name resolved from its compiled configuration. */
  readonly name: string;
  /** Stable node id stored in the compiled agent graph. */
  readonly nodeId: string;
}

/** JSON-safe agent identities available to authored callbacks. */
export interface AgentIdentityRegistry {
  readonly active: AgentIdentity;
  readonly byNodeId: Readonly<Record<string, AgentIdentity>>;
}

interface AgentIdentityBundleNode {
  readonly agent: {
    readonly behaviorRevision: string;
    readonly config: { readonly name: string };
  };
  readonly nodeId: string;
}

interface AgentIdentityBundle {
  readonly graph: {
    readonly nodesByNodeId: ReadonlyMap<string, AgentIdentityBundleNode>;
    readonly root: AgentIdentityBundleNode;
  };
}

/** Builds an immutable, prototype-safe authored identity view from the runtime graph. */
export function createAgentIdentityRegistry(bundle: AgentIdentityBundle): AgentIdentityRegistry {
  const byNodeId = Object.create(null) as Record<string, AgentIdentity>;

  for (const node of bundle.graph.nodesByNodeId.values()) {
    byNodeId[node.nodeId] = toAgentIdentity(node);
  }

  return Object.freeze({
    active: toAgentIdentity(bundle.graph.root),
    byNodeId: Object.freeze(byNodeId),
  });
}

export const AgentIdentityRegistryKey = new ContextKey<AgentIdentityRegistry>(
  "eve.agentIdentityRegistry.v1",
  {
    codec: {
      deserialize(_data, ctx) {
        return createAgentIdentityRegistry(requireBundle(ctx));
      },
      // The registry is derived from BundleKey. Persist only a marker so
      // deserialization reconstructs it from the authoritative graph.
      serialize() {
        return null;
      },
    },
  },
);

function requireBundle(ctx: ContextReader): AgentIdentityBundle {
  const key = resolveKey("eve.bundle");
  if (key === undefined) {
    throw new Error('Cannot derive "eve.agentIdentityRegistry.v1" without "eve.bundle".');
  }
  return ctx.require(key) as AgentIdentityBundle;
}

function toAgentIdentity(node: AgentIdentityBundleNode): AgentIdentity {
  return Object.freeze({
    behaviorRevision: node.agent.behaviorRevision,
    name: node.agent.config.name,
    nodeId: node.nodeId,
  });
}
