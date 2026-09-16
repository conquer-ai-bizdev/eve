import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

/** Forwards a local task-owned child's progress update to its active parent hook. */
export async function forwardLocalTaskUpdateStep(input: {
  readonly parentContinuationToken: string;
  readonly update: TaskInboundUpdate;
}): Promise<"delivered" | "unreachable"> {
  "use step";

  try {
    await resumeHook(input.parentContinuationToken, input.update);
    return "delivered";
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return "unreachable";
    throw error;
  }
}
