import { describe, expect, it } from "vitest";

import {
  acknowledgeCancelledSubagentTurn,
  appendSubagentControlMessage,
  fenceSubagentControlMailbox,
  readSubagentControlMailbox,
  recordFailedSubagentSpawn,
  reserveSubagentTurn,
  reserveSubagentSpawn,
} from "#features/subagent-supervision/messages.js";
import { startCoordinatedSubagent } from "#features/subagent-supervision/coordinated-spawn.js";
import { createSubagentController } from "#features/subagent-supervision/controller.js";
import type { DeliverSubagentControlMessageResult } from "#features/subagent-supervision/deliver-message-workflow.js";
import { controlMessageId } from "#features/subagent-supervision/message-format.js";
import { terminalSubagentControlWorkflow } from "#internal/testing/subagent-supervision-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";

describe("subagent control mailbox", () => {
  it("treats an absent mailbox as an empty terminal drain", async () => {
    const token = "http:subagent-control:empty-terminal-drain";
    const run = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      await resumeHook(token, { kind: "deliver", payloads: [] });
      await expect(run.returnValue).resolves.toEqual([]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("uses stream order as the receipt sequence and reuses an idempotency key", async () => {
    const token = "http:subagent-control:ordered-mailbox";
    const idempotencyKey = "one-message";
    const messageId = controlMessageId(idempotencyKey);
    const run = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      const first = await appendSubagentControlMessage(run.runId, {
        attemptId: "attempt-first",
        idempotencyKey,
        kind: "message",
        message: "FIRST",
        messageId,
        version: 1,
      });
      const duplicate = await appendSubagentControlMessage(run.runId, {
        attemptId: "attempt-duplicate",
        idempotencyKey,
        kind: "message",
        message: "IGNORED",
        messageId,
        version: 1,
      });

      expect(first).toEqual({
        receipt: {
          accepted: true,
          idempotencyKey,
          messageId,
          sequence: 0,
          state: "queued",
        },
        wakeOwner: true,
      });
      expect(duplicate).toEqual({ receipt: first.receipt, wakeOwner: false });

      await resumeHook(token, { kind: "deliver", payloads: [] });
      await expect(run.returnValue).resolves.toEqual(["FIRST"]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("coordinates concurrent durable deliveries through one append and wake", async () => {
    const token = "http:subagent-control:coordinated-delivery";
    const child = await start(terminalSubagentControlWorkflow, [{ token }]);
    const input = {
      childSessionId: child.runId,
      continuationToken: token,
      idempotencyKey: "coordinated-message",
      lockToken: "eve:subagent-control-delivery:coordinated-message",
      message: "COORDINATED_ONCE",
      messageId: controlMessageId("coordinated-message"),
    };

    try {
      await waitForHook({ runId: child.runId }, { token });
      const coordinators = await Promise.all([
        start({ workflowId: "workflow//eve//deliverSubagentControlMessageWorkflow" }, [input]),
        start({ workflowId: "workflow//eve//deliverSubagentControlMessageWorkflow" }, [input]),
      ]);
      const receipts = await Promise.all(
        coordinators.map(async (coordinator) => {
          const result = await getRun<DeliverSubagentControlMessageResult>(coordinator.runId)
            .returnValue;
          if (result.kind === "delivered") return result;
          return await getRun<DeliverSubagentControlMessageResult>(result.ownerRunId).returnValue;
        }),
      );

      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0]).toMatchObject({ kind: "delivered" });
      await expect(child.returnValue).resolves.toEqual(["COORDINATED_ONCE"]);
    } finally {
      const status = await child.status;
      if (status === "pending" || status === "running") await child.cancel();
    }
  });

  it("reuses the persisted child identity for a replayed spawn call", async () => {
    const parentToken = "http:subagent-control:spawn-parent";
    const childToken = "http:subagent-control:spawn-child";
    const callId = "spawn-call";
    const parent = await start(terminalSubagentControlWorkflow, [{ token: parentToken }]);

    try {
      await waitForHook({ runId: parent.runId }, { token: parentToken });
      await reserveSubagentSpawn(parent.runId, callId);
      const prepared = {
        input: { token: childToken },
        options: {},
        useLatestDeployment: false,
        workflowId:
          "workflow//./src/internal/testing/subagent-supervision-workflow//terminalSubagentControlWorkflow",
      } as never;

      const [first, concurrent] = await Promise.all([
        startCoordinatedSubagent({ callId, parentSessionId: parent.runId, prepared }),
        startCoordinatedSubagent({ callId, parentSessionId: parent.runId, prepared }),
      ]);
      const replay = await startCoordinatedSubagent({
        callId,
        parentSessionId: parent.runId,
        prepared,
      });

      expect(first).toBe(concurrent);
      expect(replay).toBe(first);
      const mailbox = await readSubagentControlMailbox(parent.runId, 0);
      expect(mailbox.spawned).toEqual([
        expect.objectContaining({ callId, childSessionId: first, kind: "spawned" }),
      ]);

      await waitForHook({ runId: first }, { token: childToken });
      await resumeHook(childToken, { kind: "deliver", payloads: [] });
      await expect(getRun(first).returnValue).resolves.toEqual([]);
      await resumeHook(parentToken, { kind: "deliver", payloads: [] });
      await expect(parent.returnValue).resolves.toEqual([]);
    } finally {
      const status = await parent.status;
      if (status === "pending" || status === "running") await parent.cancel();
    }
  });

  it("records a failed spawn reservation without conversation-event lookup", async () => {
    const token = "http:subagent-control:failed-spawn";
    const callId = "failed-spawn-call";
    const parent = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: parent.runId }, { token });
      await reserveSubagentSpawn(parent.runId, callId);
      await recordFailedSubagentSpawn(parent.runId, callId);
      await recordFailedSubagentSpawn(parent.runId, callId);

      const mailbox = await readSubagentControlMailbox(parent.runId, 0);
      expect(mailbox.failedSpawns).toEqual([
        expect.objectContaining({ callId, kind: "spawn-failed" }),
      ]);

      await resumeHook(token, { kind: "deliver", payloads: [] });
      await expect(parent.returnValue).resolves.toEqual([]);
    } finally {
      const status = await parent.status;
      if (status === "pending" || status === "running") await parent.cancel();
    }
  });

  it("cancels a running descendant through the tool-step-safe world event", async () => {
    const parentToken = "http:subagent-control:cancel-parent";
    const childToken = "http:subagent-control:cancel-child";
    const parent = await start(terminalSubagentControlWorkflow, [{ token: parentToken }]);
    const child = await start(terminalSubagentControlWorkflow, [{ token: childToken }], {
      allowReservedAttributes: true,
      attributes: {
        "$eve.parent": parent.runId,
        "$eve.parent_call": "cancel-call",
        "$eve.root": parent.runId,
        "$eve.subagent": "worker",
      },
    });

    try {
      await Promise.all([
        waitForHook({ runId: parent.runId }, { token: parentToken }),
        waitForHook({ runId: child.runId }, { token: childToken }),
      ]);
      const control = createSubagentController({
        abortSignal: new AbortController().signal,
        callerSessionId: parent.runId,
      });
      const handle = await control.get(child.runId);

      await expect(handle.snapshot({ after: "cursor:v1:zz" })).rejects.toThrow(
        "beyond the current child stream tail",
      );

      await expect(handle.cancel({ recursive: true })).resolves.toEqual({
        sessions: [
          {
            childSessionId: child.runId,
            statusAfter: "cancelled",
            statusBefore: "running",
          },
        ],
      });
      await expect(child.status).resolves.toBe("cancelled");
    } finally {
      const statuses = await Promise.all([parent.status, child.status]);
      if (statuses[0] === "pending" || statuses[0] === "running") await parent.cancel();
      if (statuses[1] === "pending" || statuses[1] === "running") await child.cancel();
    }
  });

  it("drops queued messages when cancellation fences the child", async () => {
    const token = "http:subagent-control:cancelled-queue";
    const run = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      await appendSubagentControlMessage(run.runId, {
        attemptId: "attempt-before-cancel",
        idempotencyKey: "before-cancel",
        kind: "message",
        message: "MUST_NOT_RUN",
        messageId: controlMessageId("before-cancel"),
        version: 1,
      });
      await fenceSubagentControlMailbox(run.runId, "cancelled");
      await resumeHook(token, { kind: "deliver", payloads: [] });

      await expect(run.returnValue).resolves.toEqual([]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("orders a fence against later messages", async () => {
    const token = "http:subagent-control:fenced-mailbox";
    const run = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      await fenceSubagentControlMailbox(run.runId, "cancelled");
      await expect(
        appendSubagentControlMessage(run.runId, {
          attemptId: "attempt-late",
          idempotencyKey: "late",
          kind: "message",
          message: "TOO_LATE",
          messageId: controlMessageId("late"),
          version: 1,
        }),
      ).rejects.toThrow(`Cannot send to fenced child ${run.runId}`);

      const mailbox = await readSubagentControlMailbox(run.runId, 0);
      expect(mailbox.fence).toEqual({ reason: "cancelled", sequence: 0 });
      expect(mailbox.messages).toEqual([]);
      expect(mailbox.spawned).toEqual([]);
      expect(mailbox.spawns).toEqual([]);
      expect(mailbox.turns).toEqual([]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("records one cancellation acknowledgement after the fence", async () => {
    const token = "http:subagent-control:cancellation-acknowledgement";
    const run = await start(terminalSubagentControlWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      await reserveSubagentTurn(run.runId, "turn-ack");
      await fenceSubagentControlMailbox(run.runId, "cancelled");
      await acknowledgeCancelledSubagentTurn(run.runId, "turn-ack");
      await acknowledgeCancelledSubagentTurn(run.runId, "turn-ack");

      const mailbox = await readSubagentControlMailbox(run.runId, 0);
      const acknowledgements = mailbox.turns.filter(
        (turn) => turn.kind === "turn-cancellation-acknowledged",
      );
      expect(acknowledgements).toEqual([
        expect.objectContaining({
          kind: "turn-cancellation-acknowledged",
          turnId: "turn-ack",
        }),
      ]);
      expect(acknowledgements[0]!.sequence).toBeGreaterThan(mailbox.fence!.sequence);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });
});
