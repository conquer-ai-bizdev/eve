import { describe, expect, it } from "vitest";

import { resolveSessionTurnLineage } from "#features/subagent-supervision/turn-lineage.js";

describe("subagent supervision turn lineage", () => {
  it("returns started runs and accepted unresolved reservations", () => {
    expect(
      resolveSessionTurnLineage("session", {
        fence: { reason: "cancelled", sequence: 4 },
        failedSpawns: [],
        messages: [],
        nextCursor: 5,
        spawned: [],
        spawns: [],
        turns: [
          { kind: "turn", sequence: 0, turnId: "started", version: 1 },
          {
            kind: "turn-started",
            sequence: 1,
            turnId: "started",
            turnRunId: "turn-run",
            version: 1,
          },
          { kind: "turn", sequence: 2, turnId: "failed", version: 1 },
          { kind: "turn-failed", sequence: 3, turnId: "failed", version: 1 },
          { kind: "turn", sequence: 3, turnId: "pending", version: 1 },
          { kind: "turn", sequence: 5, turnId: "after-fence", version: 1 },
        ],
      }),
    ).toEqual({
      turnRuns: [{ turnId: "started", turnRunId: "turn-run" }],
      turnRunIds: ["turn-run"],
      unresolved: ["session:pending"],
    });
  });
});
