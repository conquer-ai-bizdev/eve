import type { PreparedWorkflowRunStart } from "#execution/workflow-runtime.js";
import { readSubagentControlMailbox } from "#features/subagent-supervision/messages.js";
import type {
  CoordinatedSubagentSpawnInput,
  CoordinatedSubagentSpawnResult,
} from "#features/subagent-supervision/spawn-workflow.js";
import { getRun, start } from "#internal/workflow/runtime.js";

const SPAWN_WORKFLOW_REFERENCE = {
  workflowId: "workflow//eve//coordinatedSubagentSpawnWorkflow",
};

/** Starts or reuses the one durable child owned by a parent action call. */
export async function startCoordinatedSubagent(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly prepared: PreparedWorkflowRunStart;
}): Promise<string> {
  const existing = await spawnedChild(input.parentSessionId, input.callId);
  if (existing !== undefined) return existing;

  const lockToken = await spawnLockToken(input.parentSessionId, input.callId);
  const coordinatorInput: CoordinatedSubagentSpawnInput = { ...input, lockToken };
  const coordinator = await start(SPAWN_WORKFLOW_REFERENCE, [coordinatorInput]);
  return await spawnedResult(
    await getRun<CoordinatedSubagentSpawnResult>(coordinator.runId).returnValue,
  );
}

async function spawnedChild(parentSessionId: string, callId: string): Promise<string | undefined> {
  const mailbox = await readSubagentControlMailbox(parentSessionId, 0);
  return mailbox.spawned.find((spawn) => spawn.callId === callId)?.childSessionId;
}

async function spawnedResult(result: CoordinatedSubagentSpawnResult): Promise<string> {
  if (result.kind === "spawned") return result.childSessionId;
  return await spawnedResult(
    await getRun<CoordinatedSubagentSpawnResult>(result.ownerRunId).returnValue,
  );
}

async function spawnLockToken(parentSessionId: string, callId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${parentSessionId}\0${callId}`),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `eve:subagent-control-spawn:${hash}`;
}
