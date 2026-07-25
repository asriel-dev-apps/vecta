import { describe, expect, it } from "vitest";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";

// ADR 0012 Step 4d — the `shouldRevalidate` predicate hardening/verification pass.
// The predicate is the SINGLE mechanism (no fetcher-submit `defaultShouldRevalidate`
// option) and each queue-drained POST returns the same result shapes, so the
// predicate is already correct for the queue; these tests PIN its truth table:
//   success known-kind    → false      (skip the re-settle; optimistic state stands)
//   success unknown-kind   → default    (never suppress a foreign action's re-read)
//   VERSION_CONFLICT       → true       (override RR's status>=400 default of false)
//   FORBIDDEN/NOT_FOUND/INVALID → default (stay suppressed by the >=400 default —
//                                          local rollback, no read needed)
//   actionResult undefined (navigation) → default (never suppress legit nav re-reads)

// Only the two fields the predicate reads matter; the rest of RR's args are unused.
function args(
  actionResult: unknown,
  defaultShouldRevalidate: boolean,
): ShouldRevalidateFunctionArgs {
  return { actionResult, defaultShouldRevalidate } as unknown as ShouldRevalidateFunctionArgs;
}

const SELF_SAVE_KINDS = ["wbs-save", "masters-save", "members-save", "templates-save"] as const;

describe("skipRevalidationOnSelfSave — the queue-hardened truth table", () => {
  it("returns false for every successful self-save kind (skip the no-op re-settle)", () => {
    for (const kind of SELF_SAVE_KINDS) {
      // `defaultShouldRevalidate` is true after a 2xx action; the predicate must
      // still override it to false so a per-cell save does not fan out a re-read.
      expect(skipRevalidationOnSelfSave(args({ ok: true, kind, revision: "8" }, true))).toBe(false);
    }
  });

  it("returns the default for a successful result of an UNKNOWN kind (no bare ok:true suppression)", () => {
    // A foreign action's `{ ok: true }` on an active ancestor must NOT suppress that
    // loader's legitimate revalidation.
    expect(skipRevalidationOnSelfSave(args({ ok: true, kind: "some-other-save", revision: "8" }, true))).toBe(true);
    expect(skipRevalidationOnSelfSave(args({ ok: true }, true))).toBe(true);
    expect(skipRevalidationOnSelfSave(args({ ok: true, kind: "some-other-save" }, false))).toBe(false);
  });

  it("returns true on VERSION_CONFLICT, overriding RR's status>=400 default of false", () => {
    // The 409 result: RR defaults `shouldRevalidate` to false; the predicate must
    // force true so the loader re-runs and the client can adopt the fresh state.
    expect(
      skipRevalidationOnSelfSave(args({ ok: false, code: "VERSION_CONFLICT", actualRevision: "9" }, false)),
    ).toBe(true);
  });

  it("leaves FORBIDDEN / NOT_FOUND / INVALID suppressed by the >=400 default (local rollback, no read)", () => {
    for (const code of ["FORBIDDEN", "NOT_FOUND", "INVALID"] as const) {
      // status>=400 → RR default false; the predicate returns the default (false),
      // so no read is triggered — the client rolls back locally.
      expect(skipRevalidationOnSelfSave(args({ ok: false, code }, false))).toBe(false);
    }
  });

  it("returns the default when there is no action result (a navigation revalidation)", () => {
    // No fetcher submission: never suppress a legitimate navigation re-read.
    expect(skipRevalidationOnSelfSave(args(undefined, true))).toBe(true);
    expect(skipRevalidationOnSelfSave(args(null, true))).toBe(true);
    expect(skipRevalidationOnSelfSave(args(undefined, false))).toBe(false);
  });
});
