---
title: "Hooks"
description: "Subscribe to runtime events and resource-release boundaries from agent/hooks/."
---

Hooks are eve's authored extension points for runtime stream events and resource-release boundaries. A hook runs side effects such as audit logging, metrics and alerting, persisting sessions and messages, or releasing external resources. Reach for one to observe or react to agent lifecycle without writing a tool, a context provider (a value made available across a step), or a channel adapter handler (a handler defined on a channel's adapter; see [Channels](../channels)).

## Define a hook

```ts title="agent/hooks/audit.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      console.info("session started", { sessionId: ctx.session.id });
    },
    async "message.completed"(event) {
      console.info("model finished", { length: event.data.message?.length ?? 0 });
    },
  },
});
```

The slug is the path-relative basename. `agent/hooks/audit.ts` becomes `"audit"`, and `agent/hooks/auth/load-profile.ts` becomes `"auth/load-profile"`.

`defineHook`, `HookDefinition`, and `HookContext` live on `eve/hooks`.

A hook file declares stream-event subscribers under the `events` map, keyed by event type, with `*` matching every event. Subscribe to any event in the runtime stream vocabulary documented in [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming), including `session.started`, `turn.completed`, `message.completed`, and `action.result`. Handlers are observe-only. They cannot inject model context. To contribute runtime model messages, use `defineDynamic` and `defineInstructions` in `agent/instructions/`.

## Release resources after execution

Declare `lifecycle.release` when an agent owns external resources that must be released after its work finishes:

```ts title="agent/hooks/release-resources.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  lifecycle: {
    async release(signal, ctx) {
      await releaseResourcesOwnedBy(ctx.session.id);
      console.info("resources released", {
        reason: signal.reason,
        sessionId: ctx.session.id,
      });
    },
  },
});
```

The signal reason is `completed`, `failed`, or `cancelled`. The context contains only stable agent, channel, and session identity:

```ts
interface ReleaseContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string };
  readonly session: { readonly id: string };
}
```

For a completed or failed root request, eve releases the descendants created by that request from deepest to shallowest, then calls the root agent's release handler. A waiting descendant remains available while the root request is active. Descendants from an earlier request are not released by a later request.

When a session finishes or is cancelled, eve fences the session tree against new descendant work, stops its active descendants, and calls the applicable release handler for each session from deepest to shallowest. Operator cancellation uses the same lifecycle boundary.

The handler owns the cleanup behavior. eve does not assume a resource provider or resource type. Make the handler idempotent because durable execution may replay it. A handler failure is logged and does not change the agent's response or terminal run result; a fallback cleanup process should retry resources that remain.

## Hook structure and context

Every stream-event handler receives the same `HookContext`:

```ts
interface HookContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string; readonly continuationToken?: string };
  readonly session: { readonly id: string };
}
```

### Narrowing tool results

`toolResultFrom` narrows an `action.result` event to a specific authored tool or MCP connection and returns typed output. Import it from `eve/tools`:

```ts
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import getWeather from "../tools/get-weather";
import linear from "../connections/linear";

export default defineHook({
  events: {
    "action.result"(event) {
      // Authored tool: output is typed as the tool's return type
      const weather = toolResultFrom(event.data.result, getWeather);
      if (weather) {
        console.log(weather.output.temperature);
      }

      // MCP connection: output is unknown, toolName is qualified
      const linearResult = toolResultFrom(event.data.result, linear);
      if (linearResult) {
        console.log(linearResult.connectionToolName, linearResult.output);
      }
    },
  },
});
```

Returns `undefined` when the result doesn't match, or when `isError` is `true`. For authored tools the return includes `{ output, toolName, callId }` with `output` typed as the tool's `TOutput`. For connections it includes `{ output, toolName, connectionToolName, callId }` with `output` as `unknown`.

This works for a mounted extension's tools too — import the tool from the extension's `./tools` export and pass it. `toolResultFrom` matches the namespaced result (`crm__search`) because it keys off the tool definition, not the name:

```ts
import { search } from "@acme/crm/tools";

// inside "action.result":
const crmSearch = toolResultFrom(event.data.result, search); // typed; matches crm__search
```

## Execution order

When a stream event fires, three things happen in order:

1. Emit. The channel adapter handler runs, then the event is written to the durable stream.
2. Hooks. Stream-event hooks fire (typed handlers first, then the `*` wildcard). Return values are ignored.
3. Dynamic tool resolvers. Resolvers subscribed to the event type run and update the tool set.

Hooks always run after the event is durably recorded, so if a hook throws, the stream stays consistent.

## What happens when a hook throws

A thrown handler propagates through the emit composer and surfaces as `turn.failed`. If a hook subscribed to a failure-cascade event also throws, it escalates to `session.failed`. For belt-and-suspenders semantics inside a hook, wrap the body in `try`/`catch`. eve treats a thrown hook as a real failure.

## Subagent isolation

Subagents may carry their own `agent/hooks/` directory. Subagent hooks fire only inside the subagent scope. Parent-agent hooks do not fire for subagent turns, and subagent hooks see only the subagent's own context.

Release handlers follow the same isolation. A descendant's release boundary uses the hook registry and identity of that descendant agent, not the parent agent's registry.

## Hook vs tool vs provider

| Need                                              | Use                                            |
| ------------------------------------------------- | ---------------------------------------------- |
| Observe runtime events (audit, metrics, alerting) | `events.<type>` (or a channel adapter handler) |
| Release resources after agent work                | `lifecycle.release`                            |
| Provide structured input to the model on demand   | a tool                                         |
| Make a value available across the entire step     | a context provider                             |
| Subscribe to platform-specific events             | a channel adapter handler                      |

Stream-event hooks and channel adapter event handlers are structurally identical. Choose the channel adapter handler when you are authoring adapter-specific behavior, and choose `events.*` when you are authoring agent-level behavior that should fire across every channel. Both fire when both are registered.

## What to read next

- [Tools](../tools)
- [Context control](../concepts/context-control)
- [Session context](../reference/typescript-api)
- [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming)
