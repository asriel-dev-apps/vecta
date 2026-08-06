/**
 * Document titles, in one place.
 *
 * Measured 2026-07-31: every route except `/projects` served an EMPTY `<title>`,
 * because `routes/projects.tsx` was the only module exporting `meta`. A tab with
 * no title is indistinguishable from every other tab with no title, and this app
 * is one a user keeps several of — one per project screen.
 *
 * `<Meta />` renders the meta of the DEEPEST matching route that exports one, so
 * `root.tsx` supplies the fallback and a leaf overrides it. Measured against a
 * running `react-router dev` on 2026-08-05, reading the served HTML:
 *
 *   * `/login`            → `<title>サインイン | VECTA</title>`, exactly one `<title>`.
 *   * an unmatched path   → `<title>プロジェクト管理 | VECTA</title>`.
 *
 * The second is the control: it is the root's own title, so it shows the fallback
 * really is reached rather than the leaf's happening to be right.
 *
 * Routes that never put a title in front of anyone export none, and the list of
 * which those are is enforced in `test/document-title.test.ts` rather than here —
 * `auth.callback.tsx` is why. It LOOKS redirect-only and is not: a refused
 * sign-in renders a notice screen (measured, 400 with the page), and it spent one
 * commit inheriting the root fallback, so a failed sign-in read "プロジェクト管理".
 */

/** The product half of every title. One constant so a rename is one edit. */
const SUFFIX = "VECTA";

/** A screen that is not inside a project: `サインイン | VECTA`. */
export function appTitle(screen: string): string {
  return `${screen} | ${SUFFIX}`;
}

/**
 * A screen inside a project: `WBS · 案件A | VECTA`.
 *
 * The project name is second because the SCREEN is what distinguishes two tabs of
 * the same project, and a browser tab truncates from the right.
 *
 * `name` is REQUIRED, and an earlier version of this file was wrong to make it
 * optional "for when the error boundary renders". Measured 2026-08-05, by making
 * `/login`'s loader throw against a running dev server: the served title became
 * the ROOT's (`プロジェクト管理 | VECTA`), not the leaf's — so a leaf's `meta`
 * does not run at all when its loader fails. `<Meta />` iterates
 * `matches.slice(0, errorIdx + 1)` keyed on the route that OWNS the boundary, and
 * `root.tsx` is the only module here exporting `ErrorBoundary`.
 *
 * That also means the type system will say so if it ever changes: react-router
 * types `loaderData` as `T["loaderData"] | (HasErrorBoundary<T> extends true ?
 * undefined : never)`, so the day a leaf gains its own `ErrorBoundary`, its
 * `meta` starts receiving `undefined` and stops compiling against this signature.
 */
export function projectTitle(screen: string, name: string): string {
  return name === "" ? appTitle(screen) : appTitle(`${screen} · ${name}`);
}
