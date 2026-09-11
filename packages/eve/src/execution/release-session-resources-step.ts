import { getAdapterKind as kindOf } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContinuationTokenKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { derivePendingState } from "#execution/pending-turn-state.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ReleaseReason } from "#public/definitions/hook.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

const log = createLogger("execution.release-session-resources");

export async function releaseSessionResourcesStep(input: {
  readonly reason: ReleaseReason;
  readonly requireSettledCohort?: boolean;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<DurableSessionState | undefined> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  if (bundle.hookRegistry.releases.length === 0) return;
  const adapter = ctx.get(ChannelKey);
  const kind = adapter === undefined ? undefined : kindOf(adapter);
  const durable = await readDurableSession(input.sessionState);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable,
    turnAgent: effectiveAgent.turnAgent,
  });
  const pending = derivePendingState(session);
  if (
    input.requireSettledCohort === true &&
    (getSessionTaskIndex(session.state).some((task) => task.terminalView === undefined) ||
      pending.hasPendingAuthorization ||
      pending.hasPendingInputBatch)
  )
    return;

  const scoped = await withContextScope(ctx, session, async (enriched) => {
    const hookCtx = {
      ...buildCallbackContext(),
      agent: { name: bundle.turnAgent.id, nodeId: bundle.nodeId },
      channel: { continuationToken: ctx.get(ContinuationTokenKey), kind },
    };
    for (const release of bundle.hookRegistry.releases) {
      try {
        await release({ reason: input.reason }, hookCtx);
      } catch (error) {
        logError(log, "lifecycle release hook failed", error);
      }
    }
    return { result: undefined, session: enriched };
  });
  return createDurableSessionState({ session: scoped.session });
}
