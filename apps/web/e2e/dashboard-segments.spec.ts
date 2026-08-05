import { expect, test } from "@playwright/test";
import { sessionCookieHeader } from "./session";

/**
 * The dashboard's segments and units (Design 0014 feature 5, Design 0010 feature 4),
 * verified per Design 0008 §T7.
 *
 * What a browser adds over the unit tests: that the controls are REACHABLE and
 * that switching them re-renders the same table rather than a broken one. The
 * arithmetic is pinned in `packages/application/test/`; nothing here re-checks it.
 *
 * The money half is conditional on a rate existing in the seeded project, and
 * that is deliberate. Rates are commercially sensitive data whose presence is an
 * operational decision, so this spec REPORTS which half it ran instead of
 * seeding money into staging to make itself pass — a test that manufactures its
 * own precondition stops being evidence about the product.
 */

const PROJECT_ID = process.env.E2E_PROJECT_ID ?? "";
const PRINCIPAL_ID = process.env.E2E_PRINCIPAL_ID ?? "";

test.describe("EVM dashboard — segments and units", () => {
  test.skip(
    PROJECT_ID === "" || PRINCIPAL_ID === "",
    "set E2E_PROJECT_ID and E2E_PRINCIPAL_ID (a seeded staging project and a HUMAN principal)",
  );

  test("switches to the change segment and keeps the same table", async ({ page, baseURL }) => {
    await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookieHeader(PRINCIPAL_ID) });
    await page.goto(`${baseURL ?? ""}/projects/${PROJECT_ID}/dashboard`);

    const rows = () => page.locator("[data-testid^='evm-row-']");
    await expect(page.getByTestId("evm-segment-task")).toBeVisible();
    await page.getByTestId("evm-segment-task").click();
    const byParent = await rows().count();
    expect(byParent).toBeGreaterThan(1); // the total row plus at least one parent

    await page.getByTestId("evm-segment-change").click();
    const byChange = await rows().count();
    // Same table, and no more rows than 親タスク別 — same-named parents merge, and
    // nothing can appear that was not already a first-level ancestor.
    expect(byChange).toBeGreaterThan(0);
    expect(byChange).toBeLessThanOrEqual(byParent);
    // The header follows the segment, so a screenshot is unambiguous about which
    // one it shows.
    await expect(page.locator(".app-subtitle")).toContainText("変更");

    await page.screenshot({
      path: `e2e/.artifacts/dashboard-by-change-${test.info().project.name}.png`,
    });
  });

  test("shows money only when a rate exists, and says what it leaves out", async ({
    page,
    baseURL,
  }) => {
    await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookieHeader(PRINCIPAL_ID) });
    await page.goto(`${baseURL ?? ""}/projects/${PROJECT_ID}/dashboard`);
    await expect(page.getByTestId("evm-row-__total__")).toBeVisible();

    const toggle = page.getByTestId("evm-unit-money");
    if ((await toggle.count()) === 0) {
      // No rate recorded anywhere in the project, so there is nothing to show and
      // the control is correctly absent. That IS the assertion for this state —
      // a toggle that switched to a table of em dashes would be worse than none.
      await expect(page.getByTestId("evm-unit-days")).toHaveCount(0);
      test.info().annotations.push({
        type: "skipped-half",
        description: "no cost rate in the seeded project; the money half did not run",
      });
      return;
    }

    await toggle.click();
    // The caveat that makes the amounts readable: money is derived, and leaves
    // with no rate are excluded rather than counted as zero.
    await expect(page.getByTestId("evm-money-note")).toBeVisible();
    await expect(page.getByTestId("evm-row-__total__")).toBeVisible();

    await page.screenshot({
      path: `e2e/.artifacts/dashboard-money-${test.info().project.name}.png`,
    });
  });
});
