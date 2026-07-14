/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks subscribe to runtime stream events (under `events:`) and provider-neutral
 * runtime lifecycle boundaries (under `lifecycle:`).
 * See {@link defineHook} for the authoring shape and
 * {@link HookContext} for the runtime context every handler receives.
 */

export {
  type HookContext,
  type HookDefinition,
  type LifecycleHooks,
  type ReleaseContext,
  type ReleaseHook,
  type ReleaseReason,
  type ReleaseSignal,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "#public/definitions/hook.js";

export { type ResourceStatus, recordResourceStatus } from "#public/hooks/resource-status.js";
