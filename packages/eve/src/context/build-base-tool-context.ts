import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { createSubagentController } from "#features/subagent-supervision/controller.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { SubagentController } from "#public/definitions/subagent-control.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";
import {
  resolveToolOperationId,
  type ToolOperationIdentity,
} from "#features/subagent-supervision/tool-operation-id.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Base context shared by tool executors. */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly callId: string;
  readonly operationId: string;
  readonly subagents: SubagentController;
};

/** Builds the base context for one tool execution. */
export function buildBaseToolContext(
  options: Pick<ToolExecuteOptions, "abortSignal" | "toolCallId">,
  identity?: ToolOperationIdentity,
): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const bundle = contextStorage.getStore()?.get(BundleKey);
  const modelStepIndex =
    (
      callbackContext.session.turn as typeof callbackContext.session.turn & {
        readonly modelStepIndex?: number;
      }
    ).modelStepIndex ?? 0;
  const signal = options.abortSignal ?? new AbortController().signal;
  const operationId = resolveToolOperationId({
    fallbackCallId: options.toolCallId,
    identity,
    sessionId: callbackContext.session.id,
    stepIndex: modelStepIndex,
    turnId: callbackContext.session.turn.id,
  });

  return {
    ...callbackContext,
    abortSignal: signal,
    callId: options.toolCallId,
    operationId,
    getSandbox: async () => bindSandboxAbortSignal(await callbackContext.getSandbox(), signal),
    subagents: createSubagentController({
      abortSignal: signal,
      callerSessionId: callbackContext.session.id,
      compiledArtifactsSource: bundle?.compiledArtifactsSource,
    }),
  };
}
