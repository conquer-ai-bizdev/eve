import { setEveAttributes } from "#runtime/attributes/emit.js";

export type ResourceStatus = "cleanup-failed" | "deleted" | "none";

/** Records provider-confirmed terminal resource state on the active run. */
export async function recordResourceStatus(input: {
  readonly sandbox: ResourceStatus;
  readonly snapshot: ResourceStatus;
}): Promise<void> {
  await setEveAttributes({
    "$eve.sandbox_status": input.sandbox,
    "$eve.snapshot_status": input.snapshot,
  });
}
