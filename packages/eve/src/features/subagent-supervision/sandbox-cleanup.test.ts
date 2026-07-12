import { describe, expect, it, vi } from "vitest";

import { cleanupCancelledSubagentSandbox } from "#features/subagent-supervision/sandbox-cleanup.js";

describe("cleanupCancelledSubagentSandbox", () => {
  it("does nothing outside hosted Vercel execution", async () => {
    const loadSandboxModule = vi.fn();
    await cleanupCancelledSubagentSandbox("child", { hosted: false, loadSandboxModule });
    expect(loadSandboxModule).not.toHaveBeenCalled();
  });

  it("deletes only the session sandbox and its created snapshots", async () => {
    const liveDelete = vi.fn(async () => undefined);
    const snapshotDelete = vi.fn(async () => undefined);
    const live = {
      delete: liveDelete,
      listSnapshots: vi.fn(async () => ({
        toArray: async () => [
          { id: "created-snapshot", status: "created" },
          { id: "pending-snapshot", status: "pending" },
        ],
      })),
    };
    const Sandbox = {
      get: vi.fn(async () => live),
      list: vi.fn(async () => ({
        toArray: async () => [
          { name: "session-sandbox", tags: { sessionId: "child" } },
          { name: "foreign-sandbox", tags: { sessionId: "foreign" } },
          { name: "eve-sbx-tpl-template", tags: { sessionId: "child" } },
        ],
      })),
    };
    const Snapshot = { get: vi.fn(async () => ({ delete: snapshotDelete })) };

    await cleanupCancelledSubagentSandbox("child", {
      hosted: true,
      loadSandboxModule: async () => ({ Sandbox, Snapshot }) as never,
    });

    expect(Sandbox.list).toHaveBeenCalledWith({ limit: 50, tags: { sessionId: "child" } });
    expect(Sandbox.get).toHaveBeenCalledWith({ name: "session-sandbox", resume: false });
    expect(liveDelete).toHaveBeenCalledOnce();
    expect(Snapshot.get).toHaveBeenCalledWith({ snapshotId: "created-snapshot" });
    expect(snapshotDelete).toHaveBeenCalledOnce();
  });
});
