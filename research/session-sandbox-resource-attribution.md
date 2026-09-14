---
issue: TBD
status: in-progress
last_updated: "2026-09-14"
---

# Session sandbox resource attribution

## Decision

eve records exact provider resources opened for a durable session on that
session's Workflow run. Root and subagent session runs start with
`$eve.resource_tracking=1`. A sandbox backend reports session resources through
a provider-neutral callback; the Vercel backend reports the physical sandbox
name and session-owned persistence snapshot IDs as `$eve.sandbox_*` and
`$eve.snapshot_*` attributes.

Reusable template snapshots and author-provided source snapshots are not
session-owned and are never attributed to the run. Attribution is best-effort
observability metadata and does not change lifecycle success or cleanup.

The operator surface can read the exact attributes for a specified run. It
does not list runs, infer ownership, or expose encrypted run data.

## Observable contract

- A tracked run with no sandbox reference never opened a sandbox.
- A sandbox reference is the exact backend ID to inspect or clean up.
- A snapshot reference is the exact session-owned persistence snapshot ID.
- Provider absence after direct lookup means the recorded resource was
  deleted; unrelated lookup failures remain unknown.

## Proof

Unit coverage verifies run markers, provider-neutral reporting, Vercel sandbox
and snapshot reporting, source/template exclusion, fail-soft metadata writes,
and exact operator reads.
