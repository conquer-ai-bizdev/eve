import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAcknowledgedSubagentTurn,
  cancelSubagentWorkflowRun,
} from "#features/subagent-supervision/cancellation-runtime.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { readSubagentCancellationMailbox } from "#features/subagent-supervision/messages.js";

vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: vi.fn(), resumeHook: vi.fn() }));
vi.mock("#features/subagent-supervision/messages.js", () => ({
  readSubagentCancellationMailbox: vi.fn(),
}));

describe("subagent cancellation runtime", () => {
  const createEvent = vi.fn();
  const getRun = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorld).mockResolvedValue({
      events: { create: createEvent },
      runs: { get: getRun },
      specVersion: 1,
    } as never);
  });

  it("cancels an active turn only after its post-fence acknowledgement", async () => {
    getRun.mockResolvedValueOnce({ status: "running" }).mockResolvedValueOnce({ status: "running" });
    createEvent.mockImplementation(async () => {
      getRun.mockResolvedValue({ status: "cancelled" });
    });
    vi.mocked(readSubagentCancellationMailbox).mockResolvedValue({
      acknowledgements: [
        {
          sequence: 3,
          turnId: "turn-1",
        },
      ],
      nextCursor: 4,
    });

    await cancelAcknowledgedSubagentTurn({
      abortSignal: new AbortController().signal,
      ancestorSessionId: "ancestor",
      fenceSequence: 2,
      sessionId: "child",
      turn: { turnId: "turn-1", turnRunId: "turn-run" },
    });

    expect(createEvent).toHaveBeenCalledWith("turn-run", {
      eventData: { cancelReason: "Stopped by ancestor ancestor" },
      eventType: "run_cancelled",
      specVersion: 1,
    });
    expect(resumeHook).toHaveBeenCalledWith("turn-1:inbox", {
      kind: "subagent-control-cancelled",
    });
  });

  it("does not cancel an already terminal turn", async () => {
    getRun.mockResolvedValue({ status: "completed" });

    await cancelAcknowledgedSubagentTurn({
      abortSignal: new AbortController().signal,
      ancestorSessionId: "ancestor",
      fenceSequence: 2,
      sessionId: "child",
      turn: { turnId: "turn-1", turnRunId: "turn-run" },
    });

    expect(readSubagentCancellationMailbox).not.toHaveBeenCalled();
    expect(resumeHook).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("emits the tool-step-safe Workflow cancellation event", async () => {
    await cancelSubagentWorkflowRun("run", "ancestor");

    expect(createEvent).toHaveBeenCalledWith("run", {
      eventData: { cancelReason: "Stopped by ancestor ancestor" },
      eventType: "run_cancelled",
      specVersion: 1,
    });
  });
});
