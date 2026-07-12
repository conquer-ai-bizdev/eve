import { createHook } from "#compiled/@workflow/core/index.js";

import type { PreparedWorkflowRunStart } from "#execution/workflow-runtime.js";
import { recordSpawnedSubagentStep } from "#features/subagent-supervision/record-spawn-step.js";
import { startPreparedSubagentRunStep } from "#features/subagent-supervision/start-prepared-run-step.js";

export interface CoordinatedSubagentSpawnInput {
  readonly callId: string;
  readonly lockToken: string;
  readonly parentSessionId: string;
  readonly prepared: PreparedWorkflowRunStart;
}

export type CoordinatedSubagentSpawnResult =
  | { readonly childSessionId: string; readonly kind: "spawned" }
  | { readonly kind: "conflict"; readonly ownerRunId: string };

/** Owns one parent call and persists its child identity before completion. */
export async function coordinatedSubagentSpawnWorkflow(
  input: CoordinatedSubagentSpawnInput,
): Promise<CoordinatedSubagentSpawnResult> {
  "use workflow";

  using lock = createHook({ token: input.lockToken });
  let conflict: { readonly runId: string } | null;
  try {
    conflict = await lock.getConflict();
  } catch (error) {
    const ownerRunId = conflictingRunId(error);
    if (ownerRunId !== undefined) return { kind: "conflict", ownerRunId };
    throw error;
  }
  if (conflict !== null) return { kind: "conflict", ownerRunId: conflict.runId };

  const childSessionId = await startPreparedSubagentRunStep(input.prepared);
  await recordSpawnedSubagentStep(input.parentSessionId, input.callId, childSessionId);
  return { childSessionId, kind: "spawned" };
}

function conflictingRunId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { readonly conflictingRunId?: unknown; readonly name?: unknown };
  return candidate.name === "HookConflictError" && typeof candidate.conflictingRunId === "string"
    ? candidate.conflictingRunId
    : undefined;
}
