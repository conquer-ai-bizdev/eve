---
issue: TBD
status: implemented
last_updated: "2026-09-13"
---

# Provided argument omission

## Decision

Allow a connection `toolCall.providedArguments` value or resolver to return
`undefined`. The configured key remains hidden from the model-facing schema and
is removed from the outgoing tool input.

This covers remote schemas that expose optional filters which the application
must forbid rather than replace with `null`, an empty string, or a fabricated
sentinel. JSON values retain their existing override behavior.

## Proof

Unit coverage verifies that the key is absent from both the discovered schema
and the remote MCP execution input. Authored-definition coverage verifies that
static `undefined` is accepted while other non-JSON static values remain
rejected.
