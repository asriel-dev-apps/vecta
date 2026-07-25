import type { ProjectCommand } from "@vecta/application";

// ADR 0012 Step 4d — the queue-not-block write-path state machine (ADR §7),
// factored as a PURE module so both the wbs and masters pipelines share ONE
// verified core (unit-tested against its full transition table below), with no
// React or router imports.
//
// WHY a hand-rolled queue and not a second `useFetcher`: in the installed
// react-router@8.2.0 a `fetcher.submit` issued while the fetcher is mid-flight is
// CANCEL-AND-REPLACE, not queue — `router.js` `fetch()` calls `abortFetcher(key)`
// before starting the new submission. The aborted client POST may already have
// reached the Worker, whose action still COMMITS, so the client never observes
// that batch's `{ ok, revision }`, `confirmedRevision` desyncs from the server,
// and every later save spuriously conflicts. The queue is therefore a CORRECTNESS
// invariant, not UX: the fetcher submit is issued ONLY when the fetcher is idle.
// One fetcher + this manual queue is the only shape that upholds it (multiple
// fetchers would fire parallel POSTs that cannot chain `expectedRevision`).
//
// Two slots, with coalescing:
//   inFlight : the save currently on the wire. Its `snapshot` is the last
//              CONFIRMED boundary — the rollback target if the save is rejected.
//   pending  : edits accepted WHILE a save was in flight, coalesced in FIFO
//              gesture order into ONE wire batch, dispatched when inFlight settles.
//   invariant: pending !== null  ⇒  inFlight !== null.

/** The two-slot queue, generic over the host's optimistic snapshot type `S`. */
export interface QueueState<S> {
  readonly inFlight: { readonly snapshot: S } | null;
  readonly pending: {
    readonly commands: readonly ProjectCommand[];
    readonly snapshot: S;
  } | null;
}

/** The empty (idle) queue: nothing in flight, nothing pending. */
export function emptyQueue<S>(): QueueState<S> {
  return { inFlight: null, pending: null };
}

/**
 * The events the machine reacts to (each maps 1:1 to a §7 transition):
 *   • edit           — one gesture's optimistic batch, ALREADY applied to the
 *                      host's `useState`. `snapshot` is the state BEFORE it.
 *   • settle-success — the in-flight save committed at `revision`.
 *   • settle-conflict — the in-flight save was a VERSION_CONFLICT (incl. the P1-2
 *                      partial-commit mapping).
 *   • settle-failure — the in-flight save failed (FORBIDDEN / NOT_FOUND / INVALID;
 *                      nothing committed).
 */
export type QueueEvent<S> =
  | {
      readonly type: "edit";
      readonly snapshot: S;
      readonly commands: readonly ProjectCommand[];
      readonly confirmedRevision: string;
    }
  | { readonly type: "settle-success"; readonly revision: string }
  | { readonly type: "settle-conflict" }
  | { readonly type: "settle-failure" };

/**
 * A transition's result: the next queue plus the (at most one) side effect the
 * host component must perform.
 *   • `dispatch` is the ONLY channel through which a batch reaches the fetcher. It
 *     is produced by exactly two transitions — the edit@idle path and a
 *     settle-success DRAIN — so a submission can never originate anywhere else
 *     (making a double-apply-after-adopt structurally impossible: the conflict and
 *     failure transitions clear `pending` and never dispatch).
 *   • `rollback` is produced only by settle-failure.
 * Both are omitted (not `undefined`) when absent, per `exactOptionalPropertyTypes`.
 */
export interface QueueTransition<S> {
  readonly queue: QueueState<S>;
  readonly dispatch?: {
    readonly commands: readonly ProjectCommand[];
    readonly expectedRevision: string;
  };
  readonly rollback?: S;
}

/**
 * The single transition function. Pure: `(queue, event) → { queue, dispatch?,
 * rollback? }`; it never touches React state or the fetcher — the host applies
 * the returned effect.
 */
export function reduceQueue<S>(queue: QueueState<S>, event: QueueEvent<S>): QueueTransition<S> {
  switch (event.type) {
    case "edit": {
      // edit @ idle — open a new in-flight save: snapshot the confirmed boundary
      // and dispatch `(commands, confirmedRevision)`.
      if (queue.inFlight === null) {
        return {
          queue: { inFlight: { snapshot: event.snapshot }, pending: null },
          dispatch: { commands: event.commands, expectedRevision: event.confirmedRevision },
        };
      }
      // edit @ in-flight — never submit (the correctness invariant). Park the
      // batch as `pending`; the first pending edit snapshots ITS pre-apply state
      // (the drain's future rollback boundary), and later edits APPEND their wire
      // commands in FIFO gesture order while KEEPING that first snapshot. Each
      // gesture's optimistic derivation already happened at its own enqueue, so
      // the concatenation is never re-derived (ADR §0 convergence).
      // KNOWN Step-4 limitation (tracked separately, not fixed here): under
      // sustained heavy reorders behind a slow save this coalesced buffer can grow
      // past the 1,000-command batch cap, so the drain would 422 → rollback erases
      // the queue. No chunking is done here by design.
      const pending =
        queue.pending === null
          ? { commands: event.commands, snapshot: event.snapshot }
          : {
              commands: [...queue.pending.commands, ...event.commands],
              snapshot: queue.pending.snapshot,
            };
      return { queue: { inFlight: queue.inFlight, pending } };
    }
    case "settle-success": {
      // The host advances its confirmed revision to `event.revision` (read from
      // the SETTLED result, never its stale `confirmedRevision` state var). If a
      // coalesced batch is pending, DRAIN it: dispatch `(pending.commands,
      // revision)` — using this same settled revision — and promote its snapshot
      // to the new in-flight boundary. Otherwise the queue goes idle.
      if (queue.pending !== null) {
        return {
          queue: { inFlight: { snapshot: queue.pending.snapshot }, pending: null },
          dispatch: { commands: queue.pending.commands, expectedRevision: event.revision },
        };
      }
      return { queue: emptyQueue<S>() };
    }
    case "settle-conflict": {
      // Clear BOTH slots and do NOT roll back: the server committed state the
      // pre-batch snapshot no longer matches, so the host's forced revalidation +
      // adopt effect reconcile instead. Queued edits are dropped (accepted, §7).
      return { queue: emptyQueue<S>() };
    }
    case "settle-failure": {
      // Roll back to `inFlight.snapshot` (the last confirmed boundary) and clear
      // BOTH slots. The rollback correctly discards any pending edits too — they
      // were applied after the boundary and may depend on the failed batch, so
      // they are NOT replayed onto the restored state.
      return {
        queue: emptyQueue<S>(),
        ...(queue.inFlight !== null ? { rollback: queue.inFlight.snapshot } : {}),
      };
    }
  }
}
