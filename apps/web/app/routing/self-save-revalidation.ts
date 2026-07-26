import type { ShouldRevalidateFunctionArgs } from "react-router";
import { ASSISTANT_PROPOSAL_KIND } from "~/assistant/proposal-contract";

/**
 * Lives in `app/routing/` and not `app/server/` because it is CLIENT code:
 * `shouldRevalidate` runs in the browser, and the bundle proved it — this module
 * ships as `build/client/assets/self-save-revalidation-*.js`. It sat under
 * `app/server/` (which the boundary eslint rule exempts from its own check, so
 * nothing flagged it) until this change touched it, which was the recorded trigger
 * to move it.
 *
 * ADR 0012 Step 4b/4c — revalidation economy AND conflict recovery for every
 * project write path (WBS grid + the master/member/template routes).
 *
 * Every commit is a command = one action POST, and React Router revalidates every
 * active loader after every action by default — a full workspace re-read per
 * commit. The optimistic pipeline already advanced the client state, so a
 * SUCCESSFUL self-save needs no re-read (the ADR's no-re-settle win; component
 * `useState` survives revalidation). This predicate therefore returns `false` for
 * any of our own successful self-saves.
 *
 * The recovery cases must FORCE a re-run. RR 8.2.0 defaults `shouldRevalidate` to
 * `false` for any action result with `status >= 400` (router.js: `shouldSkip-
 * Revalidation = actionStatus && actionStatus >= 400`), and our conflict result is
 * `data(..., { status: 409 })`. Returning `defaultShouldRevalidate` there would
 * yield `false` → the loader never re-runs → the adopt effect never fires → the
 * rejected optimistic edit stays on screen forever (a silent divergence). So a
 * result that requires resync (`VERSION_CONFLICT`, which also carries the P1-2
 * partial-commit case) returns `true` explicitly: the route's `shouldRevalidate`
 * is still consulted when the default is `false` (router.js `shouldRevalidateLoader`
 * calls the route predicate first), and returning `true` forces the re-run.
 *
 * The success case is keyed on the SET of self-save `kind` discriminants
 * (`wbs-save | masters-save | members-save | templates-save`), never a bare
 * `ok === true`, so a future sibling action returning its own `{ ok: true }` on an
 * active ancestor can never suppress a loader's revalidation. Sibling leaf routes
 * (wbs / masters / members / templates) are never simultaneously active, so there
 * is no cross-route suppression to guard beyond that.
 *
 * `actionResult` (the action's returned payload) is the RR 8.2.0 field; it is
 * present on every active route's `shouldRevalidate` after a fetcher submission.
 * Shared verbatim by each write route and every active ancestor, so one commit
 * never fans out into an extra workspace reload.
 */
// ADR 0012 Step 4d — verification pass. The queue-not-block change adds NO new
// result shapes: every queue-drained POST returns the same `{ ok, kind, revision }`
// / `{ ok: false, code }` shapes as a single 4b save, so this predicate is already
// correct for the queue and its logic is UNCHANGED. It is the SINGLE revalidation
// mechanism (the fetcher-submit `defaultShouldRevalidate` option is deliberately
// unused). The pinned truth table (see self-save-revalidation.test.ts):
//   success + known self-save kind        → false   (skip the no-op re-settle)
//   success + unknown kind                 → default (never suppress a foreign re-read)
//   { ok:false, code:"VERSION_CONFLICT" }  → true    (override RR's status>=400 false)
//   { ok:false, code: FORBIDDEN|NOT_FOUND|INVALID } → default (>=400 ⇒ false: local
//                                            rollback, no read needed)
//   actionResult null/undefined (a navigation, not a fetcher submit) → default
//                                            (never suppress a legit nav re-read)
const SELF_SAVE_KINDS: ReadonlySet<string> = new Set([
  "wbs-save",
  "masters-save",
  "members-save",
  "templates-save",
]);

/**
 * ADR 0013 — actions that are READ-ONLY by construction. A proposal is generated
 * without touching the database, so the revision cannot have moved and a re-read
 * would buy nothing but two Neon round trips per keystroke-sized request. Kept as
 * a separate set from {@link SELF_SAVE_KINDS} so the reason each kind skips
 * revalidation stays legible: one skipped because the client already applied the
 * change, this one because there was no change.
 */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set([ASSISTANT_PROPOSAL_KIND]);

export function skipRevalidationOnSelfSave({
  actionResult,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (actionResult !== null && typeof actionResult === "object") {
    const result = actionResult as { ok?: unknown; kind?: unknown; code?: unknown };
    // Our own successful self-save — the optimistic state is already correct, so
    // skip the re-settle. Keyed on the discriminant SET, never a bare `{ ok: true }`.
    if (result.ok === true && typeof result.kind === "string" && SELF_SAVE_KINDS.has(result.kind)) {
      return false;
    }
    // A read-only action: nothing changed, so nothing needs re-reading.
    if (result.ok === true && typeof result.kind === "string" && READ_ONLY_KINDS.has(result.kind)) {
      return false;
    }
    // A conflict / partial-commit REQUIRES resync: force the loader to re-run so
    // the client can adopt the fresh state view + revision (overriding RR's
    // status>=400 default of `false`).
    if (result.ok === false && result.code === "VERSION_CONFLICT") {
      return true;
    }
  }
  return defaultShouldRevalidate;
}
