/**
 * Closed-contract dispatch surface between session-mutating step
 * bodies (latest deployment) and the durable driver workflow (pinned
 * to whichever deployment called `start()`).
 *
 * The driver matches on `kind` and follows a fixed playbook per arm.
 * Adding a new arm is breaking (pinned drivers can't dispatch an
 * unknown `kind`); adding optional fields inside an existing arm is
 * forward-compatible because the driver passes the action through by
 * reference and devalue preserves unknown POJO fields. Do not
 * destructure-and-rebuild a `NextDriverAction` — full destructuring
 * strips unknown fields.
 */
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { ReleaseReason } from "#public/definitions/hook.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Release boundary observed at the end of one completed or failed turn. */
export interface TurnReleaseBoundary {
  readonly reason: Extract<ReleaseReason, "completed" | "failed">;
  readonly turnId: string;
}

/** Discriminated union the driver workflow body dispatches on. */
export type NextDriverAction =
  | {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly release?: TurnReleaseBoundary;
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
      /** Session-total token usage spent by the completed session. */
      readonly usage?: TokenUsage;
    }
  | {
      readonly kind: "park";
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
      readonly authorizationNames?: readonly string[];
      readonly release?: TurnReleaseBoundary;
    }
  | {
      readonly kind: "dispatch-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    }
  | {
      readonly kind: "dispatch-workflow-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    };
