import { describe, expect, it } from "vitest";

import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";

describe("coalesceDeliverPayloads", () => {
  it("preserves queued messages in arrival order", () => {
    expect(coalesceDeliverPayloads([{ message: "ALPHA" }, { message: "BETA" }])).toEqual({
      message: "ALPHA\n\nBETA",
    });
  });

  it("keeps ordered turn fields while newer adapter fields win", () => {
    expect(
      coalesceDeliverPayloads([
        { context: ["first"], interaction: "old", message: "ALPHA" },
        { context: ["second"], interaction: "new", message: "BETA" },
      ]),
    ).toEqual({
      context: ["first", "second"],
      interaction: "new",
      message: "ALPHA\n\nBETA",
    });
  });
});
