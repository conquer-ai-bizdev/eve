import { createHash } from "node:crypto";

/** Authored tool identity used to derive a retry-stable operation id. */
export interface ToolOperationIdentity {
  readonly input: unknown;
  readonly name: string;
}

/**
 * Names one logical authored tool invocation across Workflow step retries.
 *
 * Provider tool-call ids may change when a crashed model step is replayed.
 * Session, turn, model-step index, tool name, and canonical input do not.
 * Identical calls in one model step intentionally share an idempotency boundary;
 * the same call in a later model step is a new operation.
 */
export function resolveToolOperationId(input: {
  readonly fallbackCallId: string;
  readonly identity?: ToolOperationIdentity;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}): string {
  if (input.identity === undefined) {
    return `${input.turnId}:${input.fallbackCallId}`;
  }

  const signature = canonicalize({
    input: input.identity.input,
    name: input.identity.name,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  });
  const digest = createHash("sha256").update(signature).digest("hex").slice(0, 24);
  return `${input.turnId}:${digest}`;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));

  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}
