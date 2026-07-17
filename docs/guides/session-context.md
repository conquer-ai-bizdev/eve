---
title: "Session Context"
description: "Runtime helpers: ctx.session, ctx.getSandbox, ctx.getSkill, and defineState."
---

eve exposes runtime state through the `ctx` parameter passed to tool `execute`, hook handlers, channel event handlers, and connection auth/header resolvers:

- `ctx.agent`: compiler-owned identity of the local agent node executing the callback
- `ctx.getAgent(nodeId)`: look up another local node by its stored compiled id
- `ctx.session`: session metadata, turn, auth, and parent lineage
- `ctx.getSandbox()`: live sandbox handle for the current agent
- `ctx.getSkill(identifier)`: handle for a named skill visible to the current agent
- `defineState(name, initial)`: typed durable state with `get()` and `update()` (imported from `eve/context`)

These APIs work only inside active authored runtime execution, including tools, channel event handlers, and authored hooks. They throw when called outside a managed context.

## `ctx.agent` and `ctx.getAgent(nodeId)`

`ctx.agent` identifies the root or declared subagent running the callback:

```ts
const current = ctx.agent;
// { nodeId: "subagents/researcher", name: "researcher", behaviorRevision: "..." }

const producer = ctx.getAgent(storedProducerNodeId);
if (producer?.behaviorRevision !== storedProducerRevision) {
  // The stored artifact was produced by an older compiled behavior.
}
```

`nodeId` is the id stored in the compiled graph. The root id is `__root__`.
`getAgent` returns `undefined` when the id is not part of the current local graph;
remote agents are separate deployments and are not returned.

`behaviorRevision` is a SHA-256 identity generated independently for each local
node. It covers the node's normalized compiled definition, instructions, tool
schemas, materialized skill and workspace bytes, direct subagent descriptors,
the eve runtime version, and bundled authored modules with statically imported
repo-local dependencies and assets. It also includes canonical dependency
metadata from the app and workspace package manifests plus the nearest
package-manager lockfile. Absolute checkout roots and other agent nodes'
internal behavior are excluded.

The revision is conservative content identity, not a semantic-equivalence or
security proof. Runtime values such as environment variables and secrets are
not inputs. A dependency metadata or lockfile change invalidates every local
node, even when only one node imports the changed package. External package
subpaths are represented by logical specifiers, not checkout paths. Without a
lockfile, or when `node_modules` is changed manually without updating package
metadata or the lockfile, installed package byte changes are not detected.
Files loaded at runtime through `fs` or `new URL(..., import.meta.url)` are not
covered unless they are also imported statically.

## `ctx.session`

`ctx.session` exposes durable runtime metadata about the current execution.

```ts title="agent/tools/who_called_me.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return the active session metadata.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      turnSequence: ctx.session.turn.sequence,
      currentCaller: ctx.session.auth.current?.principalId,
      initiator: ctx.session.auth.initiator?.principalId,
      parentSessionId: ctx.session.parent?.sessionId,
      parentCallId: ctx.session.parent?.callId,
    };
  },
});
```

Public session fields:

- `auth.current`
- `auth.initiator`
- `id`
- `turn.id`
- `turn.sequence`
- optional `parent`

Behavior:

- `auth.current` is the caller for the active inbound turn.
- `auth.initiator` is the caller that started the durable session.
- Unprotected agents expose both as `null`.
- Top-level schedule sessions expose the framework app principal (`principalId: "eve:app"`, `principalType: "runtime"`).
- `parent` is present for child subagent sessions and includes the parent `callId`, `sessionId`, `rootSessionId`, and `turn`.

## `ctx.getSandbox()`

`ctx.getSandbox()` returns a live handle for the current agent's sandbox.

```ts
const sandbox = await ctx.getSandbox();
const result = await sandbox.run({ command: "npm test" });
```

Behavior:

- It takes no arguments. Each agent has exactly one sandbox.
- It is async because eve binds or restores sandbox state lazily.
- It only works when sandbox access is attached to the active runtime path.
- Visibility is node-local. A subagent sees its own sandbox, not the parent's.

`SandboxSession` also exposes `resolvePath(path)`, which returns the live backend-native path for a logical `/workspace/...` location. Use it when authored code needs that path before passing it to shell code or a child process.

See [Sandbox](../sandbox) for lifecycle details.

## `ctx.getSkill(identifier)`

`ctx.getSkill(identifier)` returns a handle for a named skill visible to the current agent.

```ts
const skill = ctx.getSkill("research");
const notes = await skill.file("references/checklist.md").text();
```

Behavior:

- It is synchronous. File content is read lazily from the active sandbox.
- It only works when sandbox access is attached to the active runtime path.
- `identifier` is the path-derived skill id.
- Visibility follows the current agent's sandbox.
- A missing skill surfaces when a file accessor reads a missing sandbox path.
- The returned handle exposes `name` and `file(relativePath)`.

See [Skills](../skills) for the full authoring model.

## Custom state with `defineState`

Use `defineState` when your agent needs durable typed state that tools, hooks, and channel handlers can share. State survives workflow step boundaries. Declare the handle at module scope so every importer shares it:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

interface BudgetState {
  readonly count: number;
  readonly cap: number;
}

export const budget = defineState<BudgetState>("myapp.budget", () => ({
  count: 0,
  cap: 25,
}));
```

`get()` reads the current value (returning `initial()` on first access), and `update(fn)` applies a function to it. Both throw outside a managed scope. See [State](./state) for the full read/write model and examples from tools and hooks.

## Where these APIs work

Safe places:

- inside `defineTool(...).execute(input, ctx)`
- inside connection `auth: (ctx) => provider` and `headers: (ctx) => values` resolvers
- inside authored callbacks eve runs inside the runtime
- after asynchronous boundaries inside the same authored execution chain

Unsafe places:

- top-level module evaluation
- build scripts
- discovery-time code paths

If you call them outside an active eve runtime context, they throw immediately with a message explaining the required scope.

## How it works

The framework sets up a context container before invoking authored code:

1. The runtime populates durable seed values (auth, session id, compiled bundle).
2. Before each step, the framework derives step-local values (session metadata, sandbox access, skill access) from the durable state.
3. Authored code runs inside the managed scope, so `ctx` and `defineState` accessors resolve automatically.
4. After the step, the framework commits mutable state (for example sandbox changes) back to the durable session.

The framework manages this lifecycle. Authored code only uses `ctx` and the public accessors.

## What to read next

- [State](./state)
- [Sessions, runs & streaming](../concepts/sessions-runs-and-streaming)
- [Subagents](../subagents)
- [Skills](../skills)
