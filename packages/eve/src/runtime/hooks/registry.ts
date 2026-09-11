import type { MessageStreamEvent } from "#protocol/message.js";
import type { ReleaseHook, ReleaseReason, StreamEventHook } from "../../public/definitions/hook.js";
import type { ResolvedHookDefinition } from "../types.js";

const RELEASE_INTENT_CONTEXT_KEY = "eve.releaseReason";
type SerializedContext = Record<string, unknown>;

export function stampReleaseIntent(
  context: SerializedContext,
  reason: ReleaseReason | undefined,
): SerializedContext {
  return reason === undefined ? context : { ...context, [RELEASE_INTENT_CONTEXT_KEY]: reason };
}

export function takeReleaseIntent(context: SerializedContext): ReleaseReason | undefined {
  const reason = context[RELEASE_INTENT_CONTEXT_KEY];
  delete context[RELEASE_INTENT_CONTEXT_KEY];
  return reason === "completed" || reason === "failed" || reason === "cancelled"
    ? reason
    : undefined;
}

/**
 * One ordered stream-event subscriber paired with its source slug.
 *
 * `eventType` is `"*"` for wildcard subscribers, otherwise the typed
 * event name.
 */
interface RuntimeStreamEventHookEntry {
  readonly slug: string;
  readonly handler: StreamEventHook<MessageStreamEvent>;
  readonly eventType: string;
}

/**
 * Per-node runtime hook registry. Stream-event subscribers are split
 * into typed buckets (keyed by event type) and a flat wildcard bucket
 * so dispatch can iterate one typed bucket plus the wildcard bucket
 * without scanning every entry.
 */
export interface RuntimeHookRegistry {
  readonly releases: readonly ReleaseHook[];
  readonly streamEventsByType: ReadonlyMap<string, readonly RuntimeStreamEventHookEntry[]>;
  readonly streamEventsWildcard: readonly RuntimeStreamEventHookEntry[];
}

/**
 * Returns an empty registry. Used by tests that build a runtime bundle
 * stub without authored hooks — production registries are constructed
 * via {@link createRuntimeHookRegistry} from the resolved authored
 * graph.
 */
export function createEmptyHookRegistry(): RuntimeHookRegistry {
  return {
    releases: [],
    streamEventsByType: new Map(),
    streamEventsWildcard: [],
  };
}

/**
 * Builds the per-node runtime hook registry from an ordered list of
 * resolved hook definitions.
 *
 * The caller is responsible for sorting the input — discover-time
 * lexicographic ordering on full slug is preserved by the discovery
 * helper, so callers usually pass `resolvedHooks` directly.
 */
export function createRuntimeHookRegistry(
  resolvedHooks: readonly ResolvedHookDefinition[],
): RuntimeHookRegistry {
  const streamEventsByType = new Map<string, RuntimeStreamEventHookEntry[]>();
  const streamEventsWildcard: RuntimeStreamEventHookEntry[] = [];
  const releases: ReleaseHook[] = [];

  for (const hook of resolvedHooks) {
    if (hook.release !== undefined) releases.push(hook.release);
    for (const [eventType, handler] of Object.entries(hook.events)) {
      const entry: RuntimeStreamEventHookEntry = { slug: hook.slug, handler, eventType };
      if (eventType === "*") {
        streamEventsWildcard.push(entry);
      } else {
        const bucket = streamEventsByType.get(eventType) ?? [];
        bucket.push(entry);
        streamEventsByType.set(eventType, bucket);
      }
    }
  }

  return {
    releases,
    streamEventsByType,
    streamEventsWildcard,
  };
}
