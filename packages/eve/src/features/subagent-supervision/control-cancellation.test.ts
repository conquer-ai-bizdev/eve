import { beforeEach, describe, expect, it, vi } from "vitest";

import { watchSubagentControlCancellation } from "#features/subagent-supervision/control-cancellation.js";
import {
  acknowledgeCancelledSubagentTurn,
  readSubagentCancellationMailbox,
} from "#features/subagent-supervision/messages.js";

vi.mock("#features/subagent-supervision/messages.js", () => ({
  acknowledgeCancelledSubagentTurn: vi.fn(),
  readSubagentCancellationMailbox: vi.fn(),
}));

describe("watchSubagentControlCancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts when the mailbox is fenced as cancelled", async () => {
    vi.mocked(readSubagentCancellationMailbox).mockResolvedValue({
      acknowledgements: [],
      fence: { reason: "cancelled", sequence: 0 },
      nextCursor: 1,
    });

    const watch = watchSubagentControlCancellation("child-session", "turn-1");
    await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
    expect(watch.signal.reason).toMatchObject({ name: "TurnCancelledError" });
    await watch.dispose();
    expect(acknowledgeCancelledSubagentTurn).toHaveBeenCalledWith("child-session", "turn-1");
  });

  it("stops polling when disposed", async () => {
    vi.mocked(readSubagentCancellationMailbox).mockResolvedValue({
      acknowledgements: [],
      nextCursor: 0,
    });

    const watch = watchSubagentControlCancellation("child-session", "turn-2");
    await vi.waitFor(() => expect(readSubagentCancellationMailbox).toHaveBeenCalled());
    await watch.dispose();
    expect(watch.signal.aborted).toBe(false);
    expect(acknowledgeCancelledSubagentTurn).not.toHaveBeenCalled();
  });
});
