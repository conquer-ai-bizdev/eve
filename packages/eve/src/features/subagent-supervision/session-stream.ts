import type { Run } from "#internal/workflow/runtime.js";
import type {
  ChildObservableAction,
  ChildSessionEvent,
  ChildSessionStreamEvent,
} from "#public/definitions/subagent-control.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const EVENT_WINDOW_CHUNKS = 256;
const INSPECTION_WINDOW_CHUNKS = 2_048;

export async function readFiniteEvents(
  run: Run<unknown>,
  requestedStartIndex?: number,
  tailFromStart = false,
): Promise<{
  readonly events: ChildSessionStreamEvent[];
  readonly nextCursor: number;
  readonly omittedBeforeIndex?: number;
}> {
  const earliestIndex = requestedStartIndex ?? 0;
  const tailWindow = requestedStartIndex === undefined || tailFromStart;
  const windowSize = tailWindow ? INSPECTION_WINDOW_CHUNKS : EVENT_WINDOW_CHUNKS;
  let stream = run.getReadable<Uint8Array>({ startIndex: earliestIndex });
  const tailIndex = await stream.getTailIndex();
  const startIndex = tailWindow
    ? Math.max(earliestIndex, tailIndex - windowSize + 1)
    : earliestIndex;
  if (tailIndex < startIndex) {
    await stream.cancel();
    return { events: [], nextCursor: Math.max(0, tailIndex + 1) };
  }
  if (startIndex !== earliestIndex) {
    await stream.cancel();
    stream = run.getReadable<Uint8Array>({ startIndex });
  }

  const reader = stream.getReader();
  const events: ChildSessionStreamEvent[] = [];
  const endIndex = Math.min(tailIndex, startIndex + windowSize - 1);
  try {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const item = await reader.read();
      if (item.done) break;
      for (const [offset, event] of parseEventChunk(item.value).entries()) {
        const value = observableEvent(event);
        if (value !== undefined) {
          events.push({
            ...value,
            ...(event.meta?.at === undefined ? {} : { at: event.meta.at }),
            index,
            ...(offset === 0 ? {} : { offset }),
          });
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  return {
    events,
    nextCursor: endIndex + 1,
    ...(startIndex === 0 ? {} : { omittedBeforeIndex: startIndex }),
  };
}

function parseEventChunk(value: Uint8Array): HandleMessageStreamEvent[] {
  const text = new TextDecoder().decode(value);
  const events: HandleMessageStreamEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (isHandleMessageStreamEvent(parsed)) events.push(parsed);
  }
  return events;
}

function isHandleMessageStreamEvent(value: unknown): value is HandleMessageStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { readonly type?: unknown }).type === "string"
  );
}

function observableEvent(event: HandleMessageStreamEvent): ChildSessionEvent | undefined {
  if (event.type === "reasoning.appended") return undefined;
  if (event.type === "message.received") {
    return { data: { message: event.data.message }, type: event.type };
  }
  if (event.type === "message.completed") {
    return {
      data: {
        finishReason: event.data.finishReason,
        message: event.data.message,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "result.completed") {
    return {
      data: {
        result: event.data.result,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "reasoning.completed" || event.type === "step.started") {
    return {
      data: {
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "step.completed") {
    return {
      data: {
        finishReason: event.data.finishReason,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "step.failed") {
    return {
      data: {
        code: event.data.code,
        message: event.data.message,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "turn.completed") {
    return {
      data: { sequence: event.data.sequence, turnId: event.data.turnId },
      type: event.type,
    };
  }
  if (event.type === "turn.failed") {
    return {
      data: {
        code: event.data.code,
        message: event.data.message,
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "actions.requested") {
    const actions: ChildObservableAction[] = [];
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") {
        actions.push({
          callId: action.callId,
          input: action.input,
          kind: action.kind,
          toolName: action.toolName,
        });
      }
      if (action.kind === "subagent-call") {
        actions.push({
          callId: action.callId,
          input: action.input,
          kind: action.kind,
          subagentName: action.subagentName,
        });
      }
    }
    return { data: { actions }, type: event.type };
  }
  if (event.type === "subagent.called") {
    return {
      data: {
        callId: event.data.callId,
        childSessionId: event.data.childSessionId,
      },
      type: event.type,
    };
  }
  if (event.type === "action.result") {
    return {
      data: {
        ...(event.data.error === undefined
          ? {}
          : {
              error: {
                code: event.data.error.code,
                message: event.data.error.message,
              },
            }),
        result: {
          callId: event.data.result.callId,
          ...(event.data.result.isError === undefined
            ? {}
            : { isError: event.data.result.isError }),
          kind: event.data.result.kind,
          output: event.data.result.output,
        },
        status: event.data.status,
      },
      type: event.type,
    };
  }
  if (event.type === "input.requested") {
    return {
      data: {
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      type: event.type,
    };
  }
  if (event.type === "session.waiting") {
    return { data: { wait: event.data.wait }, type: event.type };
  }
  if (event.type === "session.failed") {
    return {
      data: { code: event.data.code, message: event.data.message },
      type: event.type,
    };
  }
  return { data: { originalType: event.type }, type: "unknown" };
}
