import { expect, test } from "@playwright/test";
import { sessionCookieHeader } from "./session";

/**
 * Baseline freezing on the real screen (Design 0009, verified per Design 0008 §T7).
 *
 * Two things are asserted, and the standard requires both:
 *
 *   1. **A user-visible outcome of the feature.** A screenshot alone is not a
 *      check — nobody diffs it, and a page that rendered the wrong number looks
 *      exactly like one that rendered the right one.
 *   2. **The authorization control.** Without the cookie the same URL must answer
 *      a redirect to `/login`. That distinguishes "the screen worked" from "the
 *      test never authenticated and read a login page it mistook for the app".
 *      It checks AUTHORIZATION though, not the feature, which is why (1) is also
 *      required rather than instead.
 *
 * The data is staging's synthetic seed. The real spreadsheet never enters a test.
 */

const PROJECT_ID = process.env.E2E_PROJECT_ID ?? "";
const PRINCIPAL_ID = process.env.E2E_PRINCIPAL_ID ?? "";

test.describe("EVM dashboard — baseline", () => {
  test.skip(
    PROJECT_ID === "" || PRINCIPAL_ID === "",
    "set E2E_PROJECT_ID and E2E_PRINCIPAL_ID (a seeded staging project and a HUMAN principal)",
  );

  test("CONTROL: without a session the dashboard is not reachable", async ({ page, baseURL }) => {
    await page.context().clearCookies();
    await page.context().setExtraHTTPHeaders({});
    const response = await page.goto(`${baseURL ?? ""}/projects/${PROJECT_ID}/dashboard`);
    // The app answers a document denial with a redirect to /login (ASVS M3): the
    // final URL is the evidence, since the redirect is followed.
    expect(page.url()).toContain("/login");
    expect(response?.status()).toBeLessThan(400);
  });

  test("names where PV came from, and can freeze the plan", async ({ page, baseURL }) => {
    const base = baseURL ?? "";
    await page.context().setExtraHTTPHeaders({
      Cookie: await sessionCookieHeader(PRINCIPAL_ID),
    });
    await page.goto(`${base}/projects/${PROJECT_ID}/dashboard`);

    // (1) the feature's user-visible outcome. Before publishing, the screen must
    // SAY the numbers are against an unfrozen plan — the state production is in.
    const source = page.getByTestId("evm-baseline-source");
    await expect(source).toBeVisible();
    const before = (await source.textContent()) ?? "";
    expect(before).toMatch(/現在計画|ベースライン v\d+/u);

    await page.screenshot({ path: `e2e/.artifacts/baseline-before-${test.info().project.name}.png` });

    // Publishing is a plan decision, so it is only exercised when the screen says
    // the plan is not frozen yet. Re-running the suite must not keep publishing.
    if (before.includes("現在計画")) {
      const acknowledge = page.getByTestId("evm-acknowledge-unplotted");
      if (await acknowledge.isVisible().catch(() => false)) {
        // The count is rendered beside it; ticking without reading is exactly the
        // habit the design refuses to build, so assert the number is on screen.
        await expect(page.getByTestId("evm-unplotted-count")).toBeVisible();
        await acknowledge.check();
      }
      await page.getByTestId("evm-publish-baseline").click();
      await expect(source).toContainText("ベースライン v", { timeout: 20_000 });
      // And the metrics it unlocks are real, not placeholders.
      await expect(page.getByTestId("baseline-bac")).not.toHaveText("—");
    }

    await page.screenshot({ path: `e2e/.artifacts/baseline-after-${test.info().project.name}.png` });
  });
});
