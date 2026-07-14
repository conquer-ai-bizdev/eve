import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  releaseRequestParticipants,
  releaseSessionTree,
  type ReleaseTreeResult,
} from "#execution/release-participants.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ReleaseReason } from "#public/definitions/hook.js";

const log = createLogger("execution.release");

/** Propagates one provider-neutral release boundary without changing the run result. */
export async function releaseParticipantsStep(input: {
  readonly reason: ReleaseReason;
  readonly scope: "request" | "session";
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId?: string;
}): Promise<ReleaseTreeResult> {
  "use step";

  try {
    const ctx = await deserializeContext(input.serializedContext);
    const bundle = ctx.require(BundleKey);
    const abortSignal = AbortSignal.timeout(30_000);

    if (input.scope === "request") {
      if (input.turnId === undefined) {
        throw new Error("A request release requires turnId");
      }
      return await releaseRequestParticipants({
        abortSignal,
        bundle,
        reason: input.reason,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
    }

    return await releaseSessionTree({
      abortSignal,
      bundle,
      cancelRoot: false,
      reason: input.reason,
      sessionId: input.sessionId,
    });
  } catch (error) {
    logError(log, "participant release failed", error, {
      reason: input.reason,
      scope: input.scope,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    return { sessions: [] };
  }
}
