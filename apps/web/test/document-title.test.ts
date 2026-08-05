import { describe, expect, it } from "vitest";
import { meta as rootMeta } from "~/root";
import { meta as loginMeta } from "~/routes/login";
import { meta as projectsMeta } from "~/routes/projects";
import { meta as wbsMeta } from "~/routes/project.wbs";
import { meta as dashboardMeta } from "~/routes/project.dashboard";
import { meta as mastersMeta } from "~/routes/project.masters";
import { meta as membersMeta } from "~/routes/project.members";
import { meta as templatesMeta } from "~/routes/project.templates";
import { appTitle, projectTitle } from "~/shell/document-title";

/**
 * Measured 2026-07-31: every route except `/projects` served an EMPTY `<title>`,
 * because `routes/projects.tsx` was the only module exporting `meta`. These pin
 * the fix at the level a unit test can reach — the `meta` function's return
 * value. That `<Meta />` then renders the DEEPEST such route is React Router's
 * behaviour, not ours, and is verified against the served HTML after deploy.
 */

/** `meta` is typed per-route by typegen; the tests only need the loader shape. */
type MetaArgs = { readonly loaderData: { readonly stateView: { readonly name: string } } };
const withName = (name: string) => ({ loaderData: { stateView: { name } } }) as MetaArgs;

const titleOf = (descriptors: readonly unknown[]): string | undefined => {
  const first = descriptors[0];
  return typeof first === "object" && first !== null && "title" in first
    ? (first as { title: string }).title
    : undefined;
};

describe("document titles", () => {
  it("gives every screen a non-empty, distinct title", () => {
    const titles = [
      titleOf(rootMeta()),
      titleOf(loginMeta()),
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
    // indistinguishable — eight identical non-empty titles would be no better.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("puts the screen before the project, and the product last", () => {
    expect(titleOf(wbsMeta(withName("案件A") as never))).toBe("WBS · 案件A | VECTA");
    expect(titleOf(dashboardMeta(withName("案件A") as never))).toBe(
      "EVM ダッシュボード · 案件A | VECTA",
    );
    expect(titleOf(loginMeta())).toBe("サインイン | VECTA");
  });

  it("omits the project rather than printing a placeholder when the name is absent", () => {
    // A leaf route's `meta` runs with no loader data when its loader threw and the
    // error boundary is rendering. `WBS · undefined` would be worse than `WBS`.
    expect(projectTitle("WBS", undefined)).toBe("WBS | VECTA");
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
