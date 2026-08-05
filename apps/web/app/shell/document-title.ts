/**
 * Document titles, in one place.
 *
 * Measured 2026-07-31: every route except `/projects` served an EMPTY `<title>`,
 * because `routes/projects.tsx` was the only module exporting `meta`. A tab with
 * no title is indistinguishable from every other tab with no title, and this app
 * is one a user keeps several of — one per project screen.
 *
 * `<Meta />` renders the meta of the DEEPEST matching route that exports one, so
 * `root.tsx` supplies the fallback and a leaf overrides it. Routes that only
 * redirect (`routes/index.tsx`, `project.index.tsx`, `logout.tsx`) deliberately
 * export none: they never render, and giving them a title would only be dead code.
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
 * `name` is optional on purpose. A leaf route's `meta` runs with `data`
 * `undefined` when its loader threw — the error boundary is rendering — and a
 * title reading `WBS · undefined` would be worse than one reading `WBS`.
 */
export function projectTitle(screen: string, name: string | undefined): string {
  return name === undefined || name === "" ? appTitle(screen) : appTitle(`${screen} · ${name}`);
}
