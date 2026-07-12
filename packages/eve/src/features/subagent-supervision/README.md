# Subagent Supervision

## Why It Exists

Stock Eve 0.22.5 waits for native task-mode children and exposes no authored
API for observing, messaging, waiting on, or cancelling a descendant. Its
continuation token wakes the current hook and is not an ordered mailbox.

This feature adds one versioned public descendant controller while keeping
Workflow objects, run attributes, storage names, and continuation credentials
private to Eve.

## Public Contract

`ToolContext.subagents` authorizes a durable descendant and returns a handle
with snapshot, wait, send, and recursive cancel operations. Public definitions
are re-exported through `eve/tools`. Capability revision 1 is exported as
`SUBAGENT_SUPERVISION_CAPABILITY`.

Snapshot events are a documented, model-safe projection of Eve's public
session-stream protocol. They preserve public turn, action, message, lifecycle,
and waiting semantics while excluding reasoning, authorization challenges,
provider metadata, attachments, and other data the parent model must not see.
The control package consumes this contract directly; it does not duplicate the
event definitions or inspect Workflow storage.

## Invariants

- Every operation rechecks ancestor lineage.
- Snapshots read one fixed session-stream tail or cursor window. Long histories
  return the newest bounded window with `omittedBeforeIndex`; event positions
  stay absolute so model-facing timeline IDs remain stable across inspections.
  The control package joins public action lifecycle events by durable call ID.
- Mailbox cancellation polling resumes from an absolute stream cursor; stop
  lineage uses dedicated spawn records rather than conversation history.
- One deterministic coordinator token owns each background spawn call. The
  complete spawn input is passed when that coordinator starts, so ownership
  does not depend on hook-registration timing.
- Message IDs derive from an explicit idempotency key.
- Wait IDs distinguish later intentional waits from replay of one deadline.
- Mailbox records persist before the child is woken.
- Receipts persist before resulting input is processed.
- Recursive cancellation traverses durable mailbox lineage and reports every
  affected descendant.
- A cancellation fence aborts the active descendant turn and kills detached
  sandbox commands before the turn can publish another result.
- A foreground-child wait receives the same fence through its durable turn
  inbox and acknowledges before the parent session is cancelled.
- Foreground delegation remains the default.

## Integration Seams

- `context/build-base-tool-context.ts`: installs the controller.
- `public/definitions/tool.ts`: declares the authored context capability.
- `public/tools/index.ts`: exports public types and capability revision.
- `runtime/subagents/registry.ts`: accepts explicit background delegation.
- `execution/subagent-tool.ts`: selects child run mode.
- `execution/dispatch-runtime-actions-step.ts`: fences spawn races and returns
  background child handles.
- `execution/subagent-adapter.ts` and
  `execution/delegated-parent-notification.ts`: keep background children from
  using foreground parent callbacks.
- `execution/workflow-entry.ts`, `execution/turn-control-receiver.ts`, and
  `execution/turn-dispatch.ts`: drain durable mailbox records at turn boundaries.
- `execution/workflow-steps.ts` and `execution/close-session-stream-step.ts`:
  keep conversation streams reusable across turns and close them at terminal
  session completion; descendant turns also observe cancellation fences.
- `execution/sandbox/bindings/vercel.ts` and
  `execution/sandbox/multiplexed-command.ts`: carry the descendant abort signal
  to Vercel's detached command and call its kill operation.
- `internal/workflow-bundle/builder.ts`: registers feature-owned durable steps
  and workflows.

## Upgrade

Rebase the feature commits onto the selected upstream Eve revision, review the
integration seams above, run the complete Eve regression and feature contract
tests, then rerun deployed adversarial verification. Preserve the public
contract and invariants rather than an obsolete internal mechanism.
