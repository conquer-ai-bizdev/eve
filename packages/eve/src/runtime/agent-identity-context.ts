import type { ContextContainer } from "#context/container.js";
import { AgentIdentityRegistryKey, createAgentIdentityRegistry } from "#context/agent-identity.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/** Seeds the JSON-safe authored-callback identity view from a compiled bundle. */
export function setAgentIdentityContext(ctx: ContextContainer, bundle: CompiledBundle): void {
  ctx.set(AgentIdentityRegistryKey, createAgentIdentityRegistry(bundle));
}
