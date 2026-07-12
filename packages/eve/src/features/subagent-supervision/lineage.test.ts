import { describe, expect, it } from "vitest";

import { resolveDirectSubagentLineage } from "#features/subagent-supervision/lineage.js";
import type { MailboxSnapshot } from "#features/subagent-supervision/messages.js";

describe("subagent supervision lineage", () => {
  it("selects native children and reports only accepted unresolved spawns", () => {
    const mailbox: MailboxSnapshot = {
      failedSpawns: [],
      fence: { reason: "cancelled", sequence: 3 },
      messages: [],
      nextCursor: 5,
      spawned: [
        {
          callId: "local-complete",
          childSessionId: "child-1",
          kind: "spawned",
          sequence: 2,
          version: 1,
        },
      ],
      spawns: [
        { callId: "local-complete", kind: "spawn", sequence: 0, version: 1 },
        { callId: "local-pending", kind: "spawn", sequence: 1, version: 1 },
        { callId: "local-after-fence", kind: "spawn", sequence: 4, version: 1 },
      ],
      turns: [],
    };

    expect(resolveDirectSubagentLineage({ mailbox, parentSessionId: "parent" })).toEqual({
      children: ["child-1"],
      unresolved: ["parent:local-pending"],
    });
  });

  it("treats a failed action as a resolved spawn without a child", () => {
    expect(
      resolveDirectSubagentLineage({
        mailbox: {
          failedSpawns: [
            { callId: "failed", kind: "spawn-failed", sequence: 1, version: 1 },
          ],
          fence: { reason: "cancelled", sequence: 1 },
          messages: [],
          nextCursor: 2,
          spawned: [],
          spawns: [{ callId: "failed", kind: "spawn", sequence: 0, version: 1 }],
          turns: [],
        },
        parentSessionId: "parent",
      }),
    ).toEqual({ children: [], unresolved: [] });
  });

  it("discovers a persisted child before the parent emits subagent.called", () => {
    expect(
      resolveDirectSubagentLineage({
        mailbox: {
          failedSpawns: [],
          fence: { reason: "cancelled", sequence: 2 },
          messages: [],
          nextCursor: 3,
          spawned: [
            {
              callId: "started",
              childSessionId: "child-before-event",
              kind: "spawned",
              sequence: 1,
              version: 1,
            },
          ],
          spawns: [{ callId: "started", kind: "spawn", sequence: 0, version: 1 }],
          turns: [],
        },
        parentSessionId: "parent",
      }),
    ).toEqual({ children: ["child-before-event"], unresolved: [] });
  });
});
