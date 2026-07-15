import { getWorld } from "#internal/workflow/runtime.js";
import type { SandboxBackendResourceReference } from "#public/definitions/sandbox-backend.js";
import { normalizeEveAttributes, type EveAttributeValue } from "#runtime/attributes/normalize.js";

let warnedAboutResourceWriteFailure = false;

export function sandboxResourceAttributes(
  resource: SandboxBackendResourceReference,
): Record<string, EveAttributeValue> {
  const prefix = resource.type === "sandbox" ? "$eve.sandbox" : "$eve.snapshot";
  return {
    "$eve.resource_tracking": "1",
    [`${prefix}_id`]: resource.id,
    [`${prefix}_provider`]: resource.provider,
  };
}

/** Associates a provider resource with its owning session run. */
export async function recordSandboxResourceReference(
  runId: string,
  resource: SandboxBackendResourceReference,
): Promise<void> {
  const normalizedRunId = runId.trim();
  const normalizedResource = {
    ...resource,
    id: resource.id.trim(),
    provider: resource.provider.trim(),
  };
  if (!normalizedRunId || !normalizedResource.id || !normalizedResource.provider) return;

  const changes = Object.entries(
    normalizeEveAttributes(sandboxResourceAttributes(normalizedResource)),
  ).map(([key, value]) => ({ key, value }));

  try {
    const world = await getWorld();
    const runs = world.runs as typeof world.runs & {
      experimentalSetAttributes?: (
        runId: string,
        changes: Array<{ key: string; value: string | null }>,
        options?: { allowReservedAttributes?: boolean },
      ) => Promise<unknown>;
    };
    if (typeof runs.experimentalSetAttributes !== "function") {
      throw new Error("the active Workflow world does not support run attributes");
    }
    await runs.experimentalSetAttributes(normalizedRunId, changes, {
      allowReservedAttributes: true,
    });
  } catch (error) {
    if (warnedAboutResourceWriteFailure) return;
    warnedAboutResourceWriteFailure = true;
    console.warn("[eve] failed to record sandbox resource attribution", {
      error: error instanceof Error ? error.message : String(error),
      runId: normalizedRunId,
      resourceType: normalizedResource.type,
    });
  }
}
