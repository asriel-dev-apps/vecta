import { describe, expect, it } from "vitest";
import type { ProjectCommand } from "@vecta/application";
import { emptyQueue, reduceQueue, type QueueState } from "~/wbs/save-queue";

// ADR 0012 Step 4d — the PURE two-slot save-queue machine, exercised over its full
// transition table with a plain string snapshot (`S = string`). This pins the
// correctness invariants the component wiring relies on: submit-only-when-idle
// (dispatch is produced by exactly the edit@idle and settle-success-drain
// transitions), the `pending.length > 0 ⇒ inFlight !== null` invariant, and a
// FIFO of gestures where each settle dispatches only the head.

// Distinct commands whose identity we can assert by `taskId` (any command shape
// works — the machine treats commands as opaque wire payloads).
const cmd = (taskId: string): ProjectCommand => ({ type: "task.update", taskId, changes: {} });

const invariantHolds = <S>(queue: QueueState<S>): boolean =>
  queue.pending.length === 0 || queue.inFlight !== null;

describe("save-queue — pure transition machine", () => {
  it("edit @ idle: opens the in-flight save and dispatches with the confirmed revision", () => {
    const t = reduceQueue(emptyQueue<string>(), {
      type: "edit",
      snapshot: "S0",
      commands: [cmd("a")],
      confirmedRevision: "7",
    });
    expect(t.queue.inFlight).toEqual({ snapshot: "S0" });
    expect(t.queue.pending).toEqual([]);
    expect(t.dispatch).toEqual({ commands: [cmd("a")], expectedRevision: "7" });
    expect(t.rollback).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("edit @ in-flight (no pending): parks the batch, snapshots ITS pre-apply state, NO dispatch", () => {
    const inFlight: QueueState<string> = { inFlight: { snapshot: "S0" }, pending: [] };
    const t = reduceQueue(inFlight, {
      type: "edit",
      snapshot: "S1",
      commands: [cmd("b")],
      confirmedRevision: "7",
    });
    // inFlight boundary is untouched; pending holds this gesture + its own snapshot.
    expect(t.queue.inFlight).toEqual({ snapshot: "S0" });
    expect(t.queue.pending).toEqual([{ commands: [cmd("b")], snapshot: "S1" }]);
    expect(t.dispatch).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("edit @ in-flight (pending present): appends a separate gesture that keeps ITS own snapshot", () => {
    const withPending: QueueState<string> = {
      inFlight: { snapshot: "S0" },
      pending: [{ commands: [cmd("b")], snapshot: "S1" }],
    };
    const t = reduceQueue(withPending, {
      type: "edit",
      snapshot: "S2",
      commands: [cmd("c")],
      confirmedRevision: "7",
    });
    // FIFO, and c is not folded into b. Each gesture keeps the state before itself.
    expect(t.queue.pending).toEqual([
      { commands: [cmd("b")], snapshot: "S1" },
      { commands: [cmd("c")], snapshot: "S2" },
    ]);
    expect(t.dispatch).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("settle-success (no pending): goes idle, NO dispatch", () => {
    const inFlight: QueueState<string> = { inFlight: { snapshot: "S0" }, pending: [] };
    const t = reduceQueue(inFlight, { type: "settle-success", revision: "8" });
    expect(t.queue).toEqual(emptyQueue());
    expect(t.dispatch).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("settle-success (with pending): dispatches only the head, with the settled revision", () => {
    const withPending: QueueState<string> = {
      inFlight: { snapshot: "S0" },
      pending: [
        { commands: [cmd("b")], snapshot: "S1" },
        { commands: [cmd("c")], snapshot: "S2" },
      ],
    };
    const first = reduceQueue(withPending, { type: "settle-success", revision: "8" });
    // The head goes out alone. Its snapshot becomes the in-flight boundary.
    // The tail stays parked for the next settle.
    expect(first.dispatch).toEqual({ commands: [cmd("b")], expectedRevision: "8" });
    expect(first.queue.inFlight).toEqual({ snapshot: "S1" });
    expect(first.queue.pending).toEqual([{ commands: [cmd("c")], snapshot: "S2" }]);
    expect(invariantHolds(first.queue)).toBe(true);

    const second = reduceQueue(first.queue, { type: "settle-success", revision: "9" });
    expect(second.dispatch).toEqual({ commands: [cmd("c")], expectedRevision: "9" });
    expect(second.queue.inFlight).toEqual({ snapshot: "S2" });
    expect(second.queue.pending).toEqual([]);
    expect(invariantHolds(second.queue)).toBe(true);
  });

  it("settle-conflict: clears BOTH slots, no dispatch, no rollback", () => {
    const withPending: QueueState<string> = {
      inFlight: { snapshot: "S0" },
      pending: [{ commands: [cmd("b")], snapshot: "S1" }],
    };
    const t = reduceQueue(withPending, { type: "settle-conflict" });
    expect(t.queue).toEqual(emptyQueue());
    expect(t.dispatch).toBeUndefined();
    expect(t.rollback).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("settle-failure: rolls back to inFlight.snapshot (discarding pending), clears both slots, NO dispatch", () => {
    const withPending: QueueState<string> = {
      inFlight: { snapshot: "S0" },
      pending: [
        { commands: [cmd("b")], snapshot: "S1" },
        { commands: [cmd("c")], snapshot: "S2" },
      ],
    };
    const t = reduceQueue(withPending, { type: "settle-failure" });
    // Rollback target is the confirmed boundary S0, NOT the pending snapshot S1.
    expect(t.rollback).toBe("S0");
    expect(t.queue).toEqual(emptyQueue());
    expect(t.dispatch).toBeUndefined();
    expect(invariantHolds(t.queue)).toBe(true);
  });

  it("dispatch originates from exactly two transitions (submit-only-when-idle invariant)", () => {
    // edit@idle → dispatch; edit@in-flight → none; settle-success-drain → dispatch;
    // settle-success-terminal / conflict / failure → none. This is the structural
    // guarantee that no submission can fire while a save is in flight.
    const idle = emptyQueue<string>();
    const inFlight: QueueState<string> = { inFlight: { snapshot: "S0" }, pending: [] };
    const drained: QueueState<string> = {
      inFlight: { snapshot: "S0" },
      pending: [{ commands: [cmd("b")], snapshot: "S1" }],
    };
    const editIdle = reduceQueue(idle, { type: "edit", snapshot: "S0", commands: [cmd("a")], confirmedRevision: "7" });
    const editBusy = reduceQueue(inFlight, { type: "edit", snapshot: "S1", commands: [cmd("b")], confirmedRevision: "7" });
    expect(editIdle.dispatch).toBeDefined();
    expect(editBusy.dispatch).toBeUndefined();
    expect(reduceQueue(drained, { type: "settle-success", revision: "8" }).dispatch).toBeDefined();
    expect(reduceQueue(inFlight, { type: "settle-success", revision: "8" }).dispatch).toBeUndefined();
    expect(reduceQueue(drained, { type: "settle-conflict" }).dispatch).toBeUndefined();
    expect(reduceQueue(drained, { type: "settle-failure" }).dispatch).toBeUndefined();
  });

  it("does not mutate the input queue (returns fresh state)", () => {
    const before: QueueState<string> = { inFlight: { snapshot: "S0" }, pending: [] };
    const snapshot = JSON.parse(JSON.stringify(before));
    reduceQueue(before, { type: "edit", snapshot: "S1", commands: [cmd("b")], confirmedRevision: "7" });
    expect(before).toEqual(snapshot);
  });
});
