import { beforeEach, describe, expect, it, vi } from "vitest";

const setEveAttributes = vi.fn();

vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes }));

describe("recordResourceStatus", () => {
  beforeEach(() => setEveAttributes.mockReset());

  it("records framework-owned sandbox and snapshot statuses", async () => {
    const { recordResourceStatus } = await import("#public/hooks/resource-status.js");

    await recordResourceStatus({ sandbox: "deleted", snapshot: "deleted" });

    expect(setEveAttributes).toHaveBeenCalledWith({
      "$eve.sandbox_status": "deleted",
      "$eve.snapshot_status": "deleted",
    });
  });
});
