import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deserializeContext: vi.fn(),
  releaseRequestParticipants: vi.fn(),
  releaseSessionTree: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: mocks.deserializeContext,
}));
vi.mock("#execution/release-participants.js", () => ({
  releaseRequestParticipants: mocks.releaseRequestParticipants,
  releaseSessionTree: mocks.releaseSessionTree,
}));

import { releaseParticipantsStep } from "./release-participants-step.js";

describe("releaseParticipantsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deserializeContext.mockResolvedValue({
      require: vi.fn(() => ({ nodeId: undefined })),
    });
  });

  it("dispatches a request release with the durable turn identity", async () => {
    mocks.releaseRequestParticipants.mockResolvedValue({ sessions: [] });

    await expect(
      releaseParticipantsStep({
        reason: "completed",
        scope: "request",
        serializedContext: { durable: true },
        sessionId: "root-session",
        turnId: "turn_0",
      }),
    ).resolves.toEqual({ sessions: [] });

    expect(mocks.releaseRequestParticipants).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "completed",
        sessionId: "root-session",
        turnId: "turn_0",
      }),
    );
  });

  it("absorbs a release failure so it cannot replace the business result", async () => {
    mocks.releaseSessionTree.mockRejectedValue(new Error("cleanup propagation failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      releaseParticipantsStep({
        reason: "failed",
        scope: "session",
        serializedContext: { durable: true },
        sessionId: "root-session",
      }),
    ).resolves.toEqual({ sessions: [] });

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
