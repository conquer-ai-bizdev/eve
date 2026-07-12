import type { PreparedWorkflowRunStart } from "#execution/workflow-runtime.js";
import { start } from "#internal/workflow/runtime.js";

/** Starts one prepared child as its own durable coordinator step. */
export async function startPreparedSubagentRunStep(
  prepared: PreparedWorkflowRunStart,
): Promise<string> {
  "use step";
  const workflow = { workflowId: prepared.workflowId };
  const run = prepared.useLatestDeployment
    ? await start(workflow, [prepared.input], {
        ...prepared.options,
        deploymentId: "latest",
      })
    : await start(workflow, [prepared.input], prepared.options);
  return run.runId;
}
