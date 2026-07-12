import { describe, expect, it } from "vitest";

import { resolveToolOperationId } from "#features/subagent-supervision/tool-operation-id.js";

describe("resolveToolOperationId", () => {
  it("is stable across provider call ids and object insertion order", () => {
    const first = resolveToolOperationId({
      fallbackCallId: "call-first",
      identity: { input: { z: 1, nested: { b: 2, a: 1 } }, name: "subagent_wait" },
      sessionId: "session",
      stepIndex: 0,
      turnId: "turn",
    });
    const replay = resolveToolOperationId({
      fallbackCallId: "call-replay",
      identity: { input: { nested: { a: 1, b: 2 }, z: 1 }, name: "subagent_wait" },
      sessionId: "session",
      stepIndex: 0,
      turnId: "turn",
    });

    expect(replay).toBe(first);
  });

  it("separates different tool inputs and turns", () => {
    const base = {
      fallbackCallId: "call",
      identity: { input: { message: "one" }, name: "subagent_send" },
      sessionId: "session",
      stepIndex: 0,
      turnId: "turn-one",
    } as const;

    expect(resolveToolOperationId({ ...base, turnId: "turn-two" })).not.toBe(
      resolveToolOperationId(base),
    );
    expect(
      resolveToolOperationId({
        ...base,
        identity: { ...base.identity, input: { message: "two" } },
      }),
    ).not.toBe(resolveToolOperationId(base));
  });

  it("separates identical authored calls in later model steps of one turn", () => {
    const base = {
      fallbackCallId: "call",
      identity: { input: { childSessionId: "child", timeoutMs: 1_000 }, name: "subagent_wait" },
      sessionId: "session",
      turnId: "turn",
    } as const;

    const first = resolveToolOperationId({ ...base, stepIndex: 0 });
    const later = resolveToolOperationId({ ...base, stepIndex: 1 });

    expect(later).not.toBe(first);
  });

  it("uses the provider call id only when no authored identity is available", () => {
    expect(
      resolveToolOperationId({
        fallbackCallId: "call-provider",
        sessionId: "session",
        stepIndex: 0,
        turnId: "turn",
      }),
    ).toBe("turn:call-provider");
  });
});
