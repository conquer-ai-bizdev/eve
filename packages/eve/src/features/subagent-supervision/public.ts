export type ChildLifecycleStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type ChildCursor = string;

export type ChildObservableAction =
  | {
      readonly callId: string;
      readonly input: unknown;
      readonly kind: "tool-call";
      readonly toolName: string;
    }
  | {
      readonly callId: string;
      readonly input: unknown;
      readonly kind: "subagent-call";
      readonly subagentName: string;
    };

export type ChildSessionEvent =
  | {
      readonly data: { readonly message: string };
      readonly type: "message.received";
    }
  | {
      readonly data: {
        readonly finishReason: string;
        readonly message: string | null;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "message.completed";
    }
  | {
      readonly data: {
        readonly result: unknown;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "result.completed";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "reasoning.completed";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "step.started";
    }
  | {
      readonly data: {
        readonly finishReason: string;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "step.completed";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly message: string;
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "step.failed";
    }
  | {
      readonly data: { readonly sequence: number; readonly turnId: string };
      readonly type: "turn.completed";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly message: string;
        readonly sequence: number;
        readonly turnId: string;
      };
      readonly type: "turn.failed";
    }
  | {
      readonly data: {
        readonly actions: readonly ChildObservableAction[];
      };
      readonly type: "actions.requested";
    }
  | {
      readonly data: {
        readonly callId: string;
        readonly childSessionId: string;
      };
      readonly type: "subagent.called";
    }
  | {
      readonly data: {
        readonly error?: { readonly code: string; readonly message: string };
        readonly result: {
          readonly callId: string;
          readonly isError?: boolean;
          readonly kind: string;
          readonly output: unknown;
        };
        readonly status: "completed" | "failed" | "rejected";
      };
      readonly type: "action.result";
    }
  | {
      readonly data: {
        readonly sequence: number;
        readonly stepIndex: number;
        readonly turnId: string;
      };
      readonly type: "input.requested";
    }
  | {
      readonly data: { readonly wait: "next-user-message" };
      readonly type: "session.waiting";
    }
  | {
      readonly data: {
        readonly code: string;
        readonly message: string;
      };
      readonly type: "session.failed";
    }
  | {
      readonly data: { readonly originalType: string };
      readonly type: "unknown";
    };

export type ChildEventType = ChildSessionEvent["type"];

/** One model-safe public session event with its absolute stream position. */
export type ChildSessionStreamEvent = ChildSessionEvent & {
  /** Durable timestamp copied from the public Eve session stream. */
  readonly at?: string;
  readonly index: number;
};

export interface ChildError {
  readonly code: string;
  readonly message: string;
}

export interface ChildSnapshot {
  /** Version of this model-safe session-stream projection. */
  readonly schemaVersion: 1;
  readonly agent: {
    readonly id: string;
    readonly name?: string;
  };
  readonly childSessionId: string;
  readonly events: readonly ChildSessionStreamEvent[];
  /** Opaque cursor immediately after the fixed stream window returned here. */
  readonly nextCursor: ChildCursor;
  readonly status: ChildLifecycleStatus;
  readonly terminal?:
    | { readonly outcome: "completed"; readonly output: unknown }
    | { readonly outcome: "failed"; readonly error: ChildError }
    | { readonly outcome: "cancelled"; readonly error?: ChildError };
  readonly waiting?: {
    readonly reason: "next-user-message";
  };
}

export interface ChildWaitResult {
  readonly reason: "cancelled" | "event" | "lifecycle" | "terminal" | "timeout";
  readonly snapshot: ChildSnapshot;
  readonly timedOut: boolean;
}

export interface ChildDeliveryReceipt {
  readonly accepted: boolean;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly state: "queued";
}

export interface ChildCancelSessionResult {
  readonly childSessionId: string;
  readonly statusAfter: ChildLifecycleStatus;
  readonly statusBefore: ChildLifecycleStatus;
}

export interface ChildCancelResult {
  readonly sessions: readonly ChildCancelSessionResult[];
}

export interface ChildSessionHandle {
  snapshot(options?: { readonly after?: ChildCursor }): Promise<ChildSnapshot>;
  wait(options: {
    readonly after: ChildCursor;
    readonly eventTypes?: readonly ChildEventType[];
    readonly idempotencyKey: string;
    readonly timeoutMs: number;
  }): Promise<ChildWaitResult>;
  send(input: {
    readonly idempotencyKey: string;
    readonly message: string;
  }): Promise<ChildDeliveryReceipt>;
  cancel(options: { readonly recursive: true }): Promise<ChildCancelResult>;
}

export interface SubagentController {
  get(childSessionId: string): Promise<ChildSessionHandle>;
}
