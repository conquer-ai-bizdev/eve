import { describe, expect, it } from "vitest";

import type { ResolvedHookDefinition } from "../types.js";
import { createEmptyHookRegistry, createRuntimeHookRegistry } from "./registry.js";

describe("createRuntimeHookRegistry", () => {
  it("splits typed and wildcard stream-event subscribers", () => {
    const typed = async () => {};
    const wildcard = async () => {};

    const registry = createRuntimeHookRegistry([
      makeHook({
        slug: "audit",
        events: { "message.completed": typed, "*": wildcard },
      }),
    ]);

    expect(
      (registry.streamEventsByType.get("message.completed") ?? []).map((e) => e.eventType),
    ).toEqual(["message.completed"]);
    expect(registry.streamEventsWildcard.map((e) => e.eventType)).toEqual(["*"]);
  });

  it("keeps release handlers in hook order", () => {
    const first = async () => {};
    const second = async () => {};
    const registry = createRuntimeHookRegistry([
      makeHook({ slug: "a", release: first }),
      makeHook({ slug: "b", release: second }),
    ]);

    expect(registry.releases).toEqual([first, second]);
  });
});

describe("createEmptyHookRegistry", () => {
  it("returns flat empty buckets", () => {
    const registry = createEmptyHookRegistry();
    expect(registry.streamEventsByType.size).toBe(0);
    expect(registry.streamEventsWildcard).toEqual([]);
    expect(registry.releases).toEqual([]);
  });
});

function makeHook(partial: {
  readonly slug: string;
  readonly events?: ResolvedHookDefinition["events"];
  readonly release?: ResolvedHookDefinition["release"];
}): ResolvedHookDefinition {
  return {
    events: partial.events ?? {},
    release: partial.release,
    exportName: undefined,
    logicalPath: `hooks/${partial.slug}.ts`,
    slug: partial.slug,
    sourceId: `hooks/${partial.slug}.ts`,
    sourceKind: "module",
  };
}
