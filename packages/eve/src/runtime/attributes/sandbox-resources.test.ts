import { beforeEach, describe, expect, it, vi } from "vitest";

const experimentalSetAttributes = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { experimentalSetAttributes } }),
}));

import {
  recordSandboxResourceReference,
  sandboxResourceAttributes,
} from "#runtime/attributes/sandbox-resources.js";

describe("sandbox resource attributes", () => {
  beforeEach(() => experimentalSetAttributes.mockReset());

  it("builds provider-neutral sandbox and snapshot references", () => {
    expect(
      sandboxResourceAttributes({ id: "eve-session", provider: "vercel", type: "sandbox" }),
    ).toEqual({
      "$eve.resource_tracking": "1",
      "$eve.sandbox_id": "eve-session",
      "$eve.sandbox_provider": "vercel",
    });
    expect(
      sandboxResourceAttributes({ id: "snap_123", provider: "vercel", type: "snapshot" }),
    ).toEqual({
      "$eve.resource_tracking": "1",
      "$eve.snapshot_id": "snap_123",
      "$eve.snapshot_provider": "vercel",
    });
  });

  it("writes the reference to the explicit owning run", async () => {
    await recordSandboxResourceReference("wrun_owner", {
      id: "sandbox-name",
      provider: "vercel",
      type: "sandbox",
    });

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      "wrun_owner",
      [
        { key: "$eve.resource_tracking", value: "1" },
        { key: "$eve.sandbox_id", value: "sandbox-name" },
        { key: "$eve.sandbox_provider", value: "vercel" },
      ],
      { allowReservedAttributes: true },
    );
  });
});
