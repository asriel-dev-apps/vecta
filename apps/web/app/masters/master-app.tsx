import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import { emptyQueue, reduceQueue, type QueueState } from "~/wbs/save-queue";

// ADR 0012 Step 4c/4d — the master screens' client save pipeline, mirroring
// `WbsApp` connected mode with the grid removed (masters carry NO derived values,
// so there is no `projectWbsGrid` recompute — the optimistic store is the project
// state alone). It owns: optimistic `applyProjectCommand`, the queue-not-block save
// queue (Step 4d: edits during an in-flight save are coalesced + drained, not
// dropped), the rollback to the confirmed boundary on a rejected save, the
// `role="alert"` notice, a per-route confirmed revision (seeded from the loader,
// advanced on each success), and the VERSION_CONFLICT → 409 → revalidate →
// adopt-from-loader effect (no remount). There is NO post-save reload — the
// sanctioned instant-save delta (the SPA's `reload()` + its "could not refresh"
// string die here by design). The pure queue machine is shared with `WbsApp`
// (`~/wbs/save-queue`); only that pure module is shared, not the two pipelines.
//
// It is deliberately router-free (no `useFetcher`): the route wrapper (`MasterRoute`)
// owns the fetcher + dispatch seam and feeds `onExecute`/`saveInFlight`/`saveResult`
// in, exactly as `ProjectWbs` feeds `WbsApp`. That keeps this component renderable
// in an in-memory test harness with a spy `onExecute` and no router, the same shape
// the 4b connected tests use.
//
// Which panels mount is a render prop (`children`), so the ONE pipeline hosts the
// masters (工程/プロダクト), members, and templates routes without harmonizing the
// panels themselves.

type SaveState = "saved" | "saving" | "error";

/**
 * The action outcome the route derives from its `useFetcher` and feeds back
 * (mirrors `WbsApp`'s `SaveActionResult`). The success `kind` is one of the
 * master self-save discriminants; revisions cross as strings.
 */
export type MasterSaveResult =
  | { readonly ok: true; readonly kind: "masters-save" | "members-save" | "templates-save"; readonly revision: string }
  | { readonly ok: false; readonly code: "VERSION_CONFLICT"; readonly actualRevision: string }
  | { readonly ok: false; readonly code: "FORBIDDEN" }
  | { readonly ok: false; readonly code: "NOT_FOUND" }
  | { readonly ok: false; readonly code: "INVALID"; readonly message?: string };

/** The state the render prop needs to mount + wire its panels. */
export interface MasterRenderContext {
  readonly project: ProjectState;
  readonly editable: boolean;
  readonly executeCommand: (command: ProjectCommand) => boolean;
}

export interface MasterAppProps {
  /** The role-scoped project state view from the route loader (server-rendered). */
  readonly initialState: ProjectState;
  /** The loader's revision; the confirmed revision is seeded from it. */
  readonly initialRevision: string;
  /** The tier-2 `app-header` subtitle (per-route faithful split of the SPA's). */
  readonly subtitle: string;
  /** Dispatch seam: forward the applied command batch with the CONFIRMED revision. */
  readonly onExecute: (commands: readonly ProjectCommand[], expectedRevision: string) => void;
  /** Is a save in flight? The route passes `fetcher.state !== "idle"`. */
  readonly saveInFlight: boolean;
  /** The latest action outcome (`fetcher.data`); processed on the settle edge. */
  readonly saveResult?: MasterSaveResult | undefined;
  /** The panels to mount, given the current project + editability + dispatch. */
  readonly children: (ctx: MasterRenderContext) => ReactNode;
}

export function MasterApp({
  initialState,
  initialRevision,
  subtitle,
  onExecute,
  saveInFlight,
  saveResult,
  children,
}: MasterAppProps) {
  const [project, setProject] = useState<ProjectState>(initialState);
  // Loaded (data seeded from the loader) so the screen starts editable; moves
  // through "saving"/"error" off the fetcher, back to "saved" on success/adopt.
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // The confirmed server revision (ADR 0012 Step 4b obligation 1): seeded from the
  // loader, advanced from each successful action result, reset by the conflict
  // adopt effect. Dispatch passes THIS — not the static `initialRevision` prop —
  // so batch 2+ carries the up-to-date revision (else a spurious VERSION_CONFLICT).
  const [confirmedRevision, setConfirmedRevision] = useState(initialRevision);
  const [notice, setNotice] = useState<string | null>(null);
  // Queue-not-block (ADR 0012 Step 4d, ADR §7): the two-slot save queue replaces
  // the `saving.current` + `rollbackSnapshot` refs. `inFlight.snapshot` is the last
  // confirmed boundary (the rollback target); `pending` coalesces edits accepted
  // while a save is in flight into ONE wire batch, drained on settle. The snapshot
  // is the project state alone (masters have no grid). Held in a ref, read/written
  // synchronously in the settle effect + on each edit.
  const queueRef = useRef<QueueState<ProjectState>>(emptyQueue());
  // The LAST `saveResult` object the settle effect consumed. A settle is detected by
  // result-object IDENTITY (each response decodes to a fresh object), NOT an
  // in-flight→idle edge: RR 8.2.0 wraps router state updates in `startTransition`, so
  // the "submitting" render can collapse and the edge is never observed (the P1
  // wedge). Identity settles exactly once even then, and a lingering `fetcher.data`
  // (same object) is never reprocessed.
  const lastProcessedResult = useRef<MasterSaveResult | undefined>(undefined);
  // The latest `onExecute` captured for the settle effect's DRAIN dispatch, so that
  // effect can submit the coalesced pending batch without listing the route's
  // per-render fetcher callback in its deps. The edit path calls `onExecute` direct.
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  // The loader revision this component has reconciled with. Successful saves skip
  // revalidation (`shouldRevalidate`), so `initialRevision` only changes when a
  // conflict-triggered revalidation delivers fresh loader data — the adopt signal.
  const adoptedLoaderRevision = useRef(initialRevision);

  // Queue-not-block (Step 4d): editing is allowed WHILE a save is in flight — the
  // edit is queued, not dropped — so "saving" is editable now (the inputs no longer
  // flash disabled per save). "error" stays locked until the conflict resync/adopt.
  const editable = saveState === "saved" || saveState === "saving";

  // Optimistic apply → dispatch, mirroring 4b's `executeCommands` but without a
  // derived-column recompute (masters carry no derived values). The
  // `applyProjectCommand` runs first inside a try: a domain rejection (e.g.
  // deleting a 工程 still referenced by a task) becomes a notice + no-op and never
  // reaches the server — exactly the SPA's behaviour.
  //
  // P2-4 — this MUST stay the SINGLE per-gesture entry point. It reads the closure
  // `project` (the pre-apply snapshot) and `setProject`s the result; two calls in one
  // tick would both read the SAME stale `project`, so the second would overwrite the
  // first's optimistic apply (the first edit lost). Never add a second call path.
  const executeCommand = useCallback(
    (command: ProjectCommand): boolean => {
      // P2-1 — a rejected save LOCKS the screen ("error") until the conflict resync/
      // adopt lands. A command dispatched across that settle→adopt gap carries the
      // stale (pre-conflict) revision and would 409 again, dropping the typed edit;
      // block it (mirrors the `editable` gate the panels use, false in "error").
      if (saveState === "error") return false;
      let candidate: ProjectState;
      try {
        candidate = applyProjectCommand(project, command);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
        return false;
      }
      // Feed the batch (of one) through the save queue: edit@idle dispatches with
      // the confirmed revision; edit@in-flight QUEUES it (coalesced, NO dispatch)
      // instead of dropping it — the queue-not-block delta. `project` is the
      // pre-apply snapshot (the confirmed rollback boundary).
      const transition = reduceQueue(queueRef.current, {
        type: "edit",
        snapshot: project,
        commands: [command],
        confirmedRevision,
      });
      queueRef.current = transition.queue;
      setSaveState("saving");
      if (transition.dispatch !== undefined) {
        // edit@idle: on the wire now. Its settle is detected by the fresh result
        // object it will produce — no edge/flag to reset.
        onExecute(transition.dispatch.commands, transition.dispatch.expectedRevision);
      }
      setProject(candidate);
      setNotice(null);
      return true;
    },
    [confirmedRevision, onExecute, project, saveState],
  );

  // Process the save outcome on the fetcher's in-flight→settled edge. At most one
  // save is ever on the wire (the queue submits only when idle), so the just-settled
  // `saveResult` is unambiguously the in-flight batch's outcome. `reduceQueue`
  // computes the next slots + effect; dispatch happens HERE (drain) and in the
  // edit@idle path — the ONLY two submit sites:
  //   • success  → advance the confirmed revision from the SETTLED result. If a
  //                coalesced batch is pending, DRAIN it (dispatch with that same
  //                settled revision, badge stays "saving"); else badge "saved". NO
  //                reload/re-settle (the optimistic state is already correct).
  //   • conflict → clear BOTH slots (queued edits dropped), no rollback. The
  //                fetcher's own revalidation reloads the loader (409 forces
  //                `shouldRevalidate` true); the adopt effect reconciles. Badge
  //                "error" (the screen locks until resync).
  //   • else     → roll back state to `inFlight.snapshot` (discarding pending too),
  //                clear both slots, badge "error", notice.
  useEffect(() => {
    // Detect a settle by result-object IDENTITY, not an in-flight→idle edge: RR
    // 8.2.0 wraps router state updates in `startTransition`, so the "submitting"
    // render can collapse and the edge is never observed (the P1 wedge). Each
    // response decodes to a fresh `saveResult`, so a value we have not yet consumed —
    // while the fetcher is idle and a save is in flight in the queue — IS the settle.
    // During the "loading"/revalidation phase `saveInFlight` is still true, so we
    // correctly wait for idle. A lingering `fetcher.data` keeps the SAME identity, so
    // it is never reprocessed (exactly-once).
    if (
      saveInFlight === true ||
      saveResult === undefined ||
      saveResult === lastProcessedResult.current ||
      queueRef.current.inFlight === null
    ) {
      return;
    }
    // Mark this result consumed FIRST, so a re-render carrying the same object cannot
    // reprocess it.
    lastProcessedResult.current = saveResult;
    const result = saveResult;
    if (result?.ok === true) {
      setConfirmedRevision(result.revision);
      const transition = reduceQueue(queueRef.current, { type: "settle-success", revision: result.revision });
      queueRef.current = transition.queue;
      setNotice(null);
      if (transition.dispatch !== undefined) {
        // Drain the coalesced pending batch (a save is again on the wire, badge
        // stays "saving"); the drained batch settles with its OWN fresh result
        // object, so the identity check re-arms for it.
        onExecuteRef.current(transition.dispatch.commands, transition.dispatch.expectedRevision);
      } else {
        setSaveState("saved");
      }
    } else if (result?.ok === false && result.code === "VERSION_CONFLICT") {
      // The server is ahead — a true conflict or a partial commit. Both mean the
      // server committed state the client's pre-batch snapshot no longer matches,
      // so we do NOT roll back: the loader-revision effect adopts the fresh state
      // after the forced revalidation.
      queueRef.current = reduceQueue(queueRef.current, { type: "settle-conflict" }).queue;
      setSaveState("error");
    } else {
      const transition = reduceQueue(queueRef.current, { type: "settle-failure" });
      queueRef.current = transition.queue;
      if (transition.rollback !== undefined) setProject(transition.rollback);
      setSaveState("error");
      setNotice(
        result?.ok === false && result.code === "INVALID" && result.message !== undefined
          ? result.message
          : "The edit could not be saved",
      );
    }
  }, [saveInFlight, saveResult]);

  // Conflict resync (replaces the SPA's `reload()`). A successful self-save skips
  // revalidation, so `initialRevision` (the loader value) only changes when a
  // VERSION_CONFLICT triggered a revalidation that delivered fresh data. On that
  // change, ADOPT the fresh state view + revision into component state — no
  // remount (the DOM node persists; focus/selection survive). The badge returns to
  // "saved": the fresh data is shown, the rejected edit is not, and editing resumes.
  useEffect(() => {
    if (initialRevision === adoptedLoaderRevision.current) return;
    // Defer while a save is still in flight: adopting mid-save would clobber the
    // in-flight edit. The outcome effect (declared first, flushed first) clears the
    // queue's `inFlight` on settle, so a real conflict resync still adopts.
    // P2-3 — a DEFERRED adopt re-arms only when this effect re-runs, and its deps
    // (`initialRevision`/`initialState`/`confirmedRevision`) only change mid-save via
    // `confirmedRevision` (advanced by the outcome effect on a drain-success). It
    // relies on nothing ELSE triggering a revalidation mid-save on this route — true
    // today: `shouldRevalidate` skips self-saves, so the only loader re-run that
    // overlaps a save is the conflict one, which clears `inFlight` in the same commit.
    if (queueRef.current.inFlight !== null) return;
    adoptedLoaderRevision.current = initialRevision;
    // A benign catch-up revalidation (the loader merely caught up to the revision
    // we already confirmed) is NOT a conflict: reconcile the ref, keep state.
    if (initialRevision === confirmedRevision) return;
    setProject(initialState);
    setConfirmedRevision(initialRevision);
    setSaveState("saved");
    setNotice(
      `This project changed elsewhere and was reloaded at revision ${initialRevision}. Your edit was not saved.`,
    );
  }, [initialRevision, initialState, confirmedRevision]);

  return (
    <div className="app-shell master-shell">
      <header className="app-header">
        <p className="app-subtitle">{subtitle}</p>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>
      {notice !== null && (
        <div className="master-notice" role="alert" data-testid="master-notice">{notice}</div>
      )}
      <div className="master-body" data-testid="master-screen">
        {children({ project, editable, executeCommand })}
      </div>
    </div>
  );
}
