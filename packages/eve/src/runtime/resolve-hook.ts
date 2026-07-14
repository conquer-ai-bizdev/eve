import type { CompiledHookDefinition } from "../compiler/manifest.js";
import type { CompiledModuleMap } from "../compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "../internal/authored-module.js";
import type { HandleMessageStreamEvent } from "../protocol/message.js";
import type { ReleaseHook, StreamEventHook } from "../public/definitions/hook.js";
import { toErrorMessage } from "../shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "./resolve-helpers.js";
import type { ResolvedHookDefinition } from "./types.js";

/**
 * Resolves one compiled authored hook into a runtime-owned definition
 * with live handlers reattached from the authored module.
 *
 * The authored shape is `{ events?: { ... }, lifecycle?: { release?: ... } }`.
 * Each declared handler must be a function. Any other shape raises a
 * {@link ResolveAgentError} so typos surface at resolve time instead of
 * at first dispatch call.
 */
export async function resolveHookDefinition(
  definition: CompiledHookDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedHookDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "hook",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      describe(definition, "to return an object"),
    );

    const events: Record<string, StreamEventHook<HandleMessageStreamEvent>> = {};
    let release: ReleaseHook | undefined;

    const eventsRaw = resolvedRecord.events;
    if (eventsRaw !== undefined) {
      const eventsRecord = expectObjectRecord(
        eventsRaw,
        describe(definition, "to expose `events` as an object"),
      );
      for (const [key, value] of Object.entries(eventsRecord)) {
        if (value === undefined) continue;
        const handler = expectFunction(
          value,
          describe(definition, `to provide a function for "events.${key}"`),
        );
        events[key] = handler as StreamEventHook<HandleMessageStreamEvent>;
      }
    }

    const lifecycleRaw = resolvedRecord.lifecycle;
    if (lifecycleRaw !== undefined) {
      const lifecycle = expectObjectRecord(
        lifecycleRaw,
        describe(definition, "to expose `lifecycle` as an object"),
      );
      if (lifecycle.release !== undefined) {
        release = expectFunction(
          lifecycle.release,
          describe(definition, 'to provide a function for "lifecycle.release"'),
        ) as ReleaseHook;
      }
    }

    const resolved: ResolvedHookDefinition = {
      events,
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      slug: definition.slug,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
    if (release !== undefined) Object.assign(resolved, { release });
    return resolved;
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to attach hook handlers from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function describe(definition: CompiledHookDefinition, predicate: string): string {
  return `Expected the hook export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
