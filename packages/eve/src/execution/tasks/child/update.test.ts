import { beforeEach, describe, expect, it, vi } from "vitest";

import { forwardLocalTaskUpdateStep } from "#execution/tasks/child/update-step.js";
import { deliverTaskUpdate } from "#execution/tasks/child/update.js";

vi.mock("#execution/tasks/child/update-step.js", () => ({
  forwardLocalTaskUpdateStep: vi.fn(),
}));

const update = {
  callId: "call-update",
  kind: "task-update",
  message: "Working",
  updateEpoch: "turn-1",
  updateIndex: 0,
} as const;
const adapter = {
  kind: "subagent",
  state: {
    callId: "call-agent",
    parentContinuationToken: "parent-hook",
    parentSessionId: "parent-session",
    subagentName: "account-sync",
    taskId: "task-1",
  },
} as const;

describe("deliverTaskUpdate", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the task id when the active parent accepts the update", async () => {
    vi.mocked(forwardLocalTaskUpdateStep).mockResolvedValue("delivered");

    await expect(deliverTaskUpdate({ adapter, callback: undefined, update })).resolves.toBe(
      "task-1",
    );
  });

  it("returns no task id when a directly resumed child has no live task owner", async () => {
    vi.mocked(forwardLocalTaskUpdateStep).mockResolvedValue("unreachable");

    await expect(
      deliverTaskUpdate({ adapter, callback: undefined, update }),
    ).resolves.toBeUndefined();
  });
});
