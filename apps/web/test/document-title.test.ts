import { describe, expect, it } from "vitest";
import { meta as rootMeta } from "~/root";
import { meta as loginMeta } from "~/routes/login";
import { meta as callbackMeta } from "~/routes/auth.callback";
import { meta as projectsMeta } from "~/routes/projects";
import { meta as wbsMeta } from "~/routes/project.wbs";
import { meta as dashboardMeta } from "~/routes/project.dashboard";
import { meta as mastersMeta } from "~/routes/project.masters";
import { meta as membersMeta } from "~/routes/project.members";
import { meta as templatesMeta } from "~/routes/project.templates";
import { appTitle, projectTitle } from "~/shell/document-title";

/**
 * Measured 2026-07-31: every route except `/projects` served an EMPTY `<title>`,
 * because `routes/projects.tsx` was the only module exporting `meta`.
 *
 * These pin two different things. The first test is STRUCTURAL — it reads the
 * routes directory, so the next route added fails it until somebody gives it a
 * title or records why it needs none. The rest pin the `meta` functions' return
 * values.
 *
 * What is NOT here is `<Meta />` rendering the deepest route: that belongs to
 * React Router, so it was measured against a running dev server instead
 * (2026-08-05, `/login` and an unmatched path — see `app/shell/document-title.ts`).
 */

/** `meta` is typed per-route by typegen; the tests only need the loader shape. */
type MetaArgs = { readonly loaderData: { readonly stateView: { readonly name: string } } };
const withName = (name: string) => ({ loaderData: { stateView: { name } } }) as MetaArgs;

/**
 * The title descriptor, wherever it sits. Reading index 0 would report a title
 * that IS present but not first as absent — a real misdiagnosis, since `meta`
 * returns a list and nothing fixes the order.
 */
const titleOf = (descriptors: readonly unknown[]): string | undefined => {
  const found = descriptors.find(
    (d): d is { title: string } => typeof d === "object" && d !== null && "title" in d,
  );
  return found?.title;
};

/**
 * Routes that legitimately export no `meta`, each with the reason it never puts a
 * title in front of anyone. The list is the point: the enumeration test below
 * reads the routes directory, so a route added later fails here until somebody
 * either gives it a title or writes down why it does not need one.
 *
 * Every entry is measured, not assumed — `logout` answers 302 with zero `<title>`
 * tags, `project.assistant` answers 302 to a GET (it is action-only), and `index`
 * / `project.index` throw a redirect from their loader.
 */
const NO_TITLE_NEEDED: Record<string, string> = {
  "index.tsx": "loader throws a redirect to /projects; never renders",
  "project.index.tsx": "loader throws a redirect; never renders",
  "logout.tsx": "302 only, measured to emit zero <title> tags",
  "project.assistant.tsx": "action-only (ADR 0013); a GET is a 302",
  "protected.tsx": "pathless layout — never the deepest match",
  "project.tsx": "project layout — never the deepest match",
};

describe("document titles", () => {
  it("leaves no route without a title, or without a recorded reason", async () => {
    // `auth.callback.tsx` is why this is an enumeration rather than a list of
    // imports: it LOOKS redirect-only, and it is not — a refused sign-in renders
    // a notice screen (measured: 400 with the page). It inherited the root
    // fallback, so a failed sign-in read "プロジェクト管理" — the one thing the
    // person in front of it had just failed to reach.
    const modules = import.meta.glob("../app/routes/*.tsx");
    const paths = Object.keys(modules).map((path) => path.split("/").pop() ?? path);
    expect(paths.length, "the glob read no route modules").toBeGreaterThan(10);

    const missing: string[] = [];
    for (const [path, load] of Object.entries(modules)) {
      const file = path.split("/").pop() ?? path;
      if (file in NO_TITLE_NEEDED) continue;
      const module = (await load()) as { meta?: unknown };
      if (typeof module.meta !== "function") missing.push(file);
    }
    expect(missing, "route(s) with neither a title nor a recorded reason").toEqual([]);
  });

  it("gives every screen a non-empty, distinct title", () => {
    const titles = [
      titleOf(rootMeta()),
      titleOf(loginMeta()),
      titleOf(callbackMeta()),
      titleOf(projectsMeta()),
      titleOf(wbsMeta(withName("案件A") as never)),
      titleOf(dashboardMeta(withName("案件A") as never)),
      titleOf(mastersMeta(withName("案件A") as never)),
      titleOf(membersMeta(withName("案件A") as never)),
      titleOf(templatesMeta(withName("案件A") as never)),
    ];
    for (const title of titles) {
      expect(title, "a screen served an empty title").toBeTruthy();
    }
    // Distinct, because the defect being fixed is that tabs were
    // indistinguishable — nine identical non-empty titles would be no better.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("puts the screen before the project, and the product last — on EVERY project screen", () => {
    // Exact strings for all five, not just two. Measured: with only truthy+distinct
    // assertions, pointing `project.masters` at a DIFFERENT loader field
    // (`stateView.currency` instead of `.name`) left the suite green — the title
    // silently degraded to the no-name form and stayed truthy and distinct. The
    // `as never` cast the typegen'd signature needs cannot catch that either.
    const cases: readonly [string, (args: never) => readonly unknown[]][] = [
      ["WBS · 案件A | VECTA", wbsMeta],
      ["EVM ダッシュボード · 案件A | VECTA", dashboardMeta],
      ["マスタ · 案件A | VECTA", mastersMeta],
      ["メンバー · 案件A | VECTA", membersMeta],
      ["テンプレート · 案件A | VECTA", templatesMeta],
    ];
    for (const [expected, meta] of cases) {
      expect(titleOf(meta(withName("案件A") as never))).toBe(expected);
    }
    expect(titleOf(loginMeta())).toBe("サインイン | VECTA");
    expect(titleOf(callbackMeta())).toBe("サインインの確認 | VECTA");
    expect(titleOf(projectsMeta())).toBe("プロジェクト | VECTA");
    expect(titleOf(rootMeta())).toBe("プロジェクト管理 | VECTA");
  });

  it("omits the separator rather than printing an empty segment for an unnamed project", () => {
    // `name` is REQUIRED — the earlier optional parameter was justified by an
    // error-boundary case that does not exist (measured: a leaf's `meta` does not
    // run when its loader throws; the root's title is served instead). An empty
    // string is still reachable through the data, and `WBS ·  | VECTA` would be
    // worse than `WBS | VECTA`.
    expect(projectTitle("WBS", "")).toBe("WBS | VECTA");
    expect(appTitle("サインイン")).toBe("サインイン | VECTA");
  });

  it("CONTROL: a screen name really does reach the title", () => {
    // Without this the assertions above could all pass on a helper that returned
    // a constant.
    expect(projectTitle("WBS", "一意な案件名")).toContain("一意な案件名");
    expect(projectTitle("固有スクリーン", "案件A")).toContain("固有スクリーン");
  });
});
