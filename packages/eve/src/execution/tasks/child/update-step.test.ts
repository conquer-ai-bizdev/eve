import { describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { forwardLocalTaskUpdateStep } from "#execution/tasks/child/update-step.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

const update = {
  callId: "call-update",
  kind: "task-update",
  message: "Working",
  updateEpoch: "turn-1",
  updateIndex: 0,
} as const;

describe("forwardLocalTaskUpdateStep", () => {
  it("reports delivery to an active parent hook", async () => {
    vi.mocked(resumeHook).mockResolvedValue({} as never);

    await expect(
      forwardLocalTaskUpdateStep({ parentContinuationToken: "parent-hook", update }),
    ).resolves.toBe("delivered");
    expect(resumeHook).toHaveBeenCalledWith("parent-hook", update);
  });

  it("reports an expired parent hook without failing the resumed child turn", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("parent-hook"));

    await expect(
      forwardLocalTaskUpdateStep({ parentContinuationToken: "parent-hook", update }),
    ).resolves.toBe("unreachable");
  });

  it("propagates unexpected delivery failures", async () => {
    const failure = new Error("workflow storage unavailable");
    vi.mocked(resumeHook).mockRejectedValue(failure);

    await expect(
      forwardLocalTaskUpdateStep({ parentContinuationToken: "parent-hook", update }),
    ).rejects.toBe(failure);
  });
});
