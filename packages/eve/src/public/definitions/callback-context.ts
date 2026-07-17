import type { SkillHandle } from "#execution/skills/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";
import type { AgentIdentity } from "#context/agent-identity.js";

export type { SessionAuth, SessionParent, SessionTurn };
export type { AgentIdentity };

/**
 * Shared runtime context available to all authored callbacks that run
 * inside the ALS-scoped harness step (tools, hooks, channel events).
 *
 * Non-ALS callbacks (schedule `run`, sandbox `bootstrap`/`onSession`,
 * instrumentation `setup`) do not receive this context. They get
 * domain-specific arguments instead.
 */
export interface SessionContext {
  /** Identity of the local agent node executing the callback. */
  readonly agent: AgentIdentity;

  /**
   * Active session metadata. Mirrors the `Session` type but exposes the
   * identifier as `id` here, where `Session` names it `sessionId`.
   */
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };

  /**
   * Resolves the session's sandbox. Throws when no sandbox is available
   * in the current authored runtime context.
   */
  getSandbox(): Promise<SandboxSession>;

  /**
   * Returns a {@link SkillHandle} for the named authored skill.
   */
  getSkill(identifier: string): SkillHandle;

  /**
   * Returns a local agent node by its stored compiled id, or `undefined` when
   * that id is not part of the current deployment's graph.
   */
  getAgent(nodeId: string): AgentIdentity | undefined;
}
