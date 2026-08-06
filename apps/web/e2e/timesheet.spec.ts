import { expect, test } from "@playwright/test";
import { sessionCookieHeader } from "./session";

/**
 * Timesheet import on the real screen (Design 0011, verified per Design 0008 §T7).
 *
 * The two-step gate is the thing worth exercising in a browser, because it is the
 * only part of this feature whose correctness lives in the DOM rather than in a
 * pure function: the import REPLACES whole `(date, member)` partitions, so it can
 * delete rows the file never mentions, and the partition count is the only place
 * that blast radius is visible. A review already found the gate not holding — a
 * second file left the first file's preview on screen and re-opened the button —
 * which is exactly the class of defect a unit test on the parser cannot see.
 *
 * As the standard requires, this asserts a user-visible OUTCOME and not only a
 * screenshot, and pairs it with the authorization control.
 *
 * **This spec writes to the staging database.** It imports one row for one
 * person-day on one leaf task, which is a partition nothing else uses. Re-running
 * it is idempotent by design (Design 0011 §5.1), so it does not accumulate.
 */

const PROJECT_ID = process.env.E2E_PROJECT_ID ?? "";
const PRINCIPAL_ID = process.env.E2E_PRINCIPAL_ID ?? "";

// The import's own round trip can exceed Playwright's 30 s default on a
// 216-task project (see the measurement below), so this file gets a longer
// budget. It is a statement about the write path, not about flakiness.
test.describe.configure({ timeout: 180_000 });

test.describe("timesheet import", () => {
  test.skip(
    PROJECT_ID === "" || PRINCIPAL_ID === "",
    "set E2E_PROJECT_ID and E2E_PRINCIPAL_ID (a seeded staging project and a HUMAN principal)",
  );

  test("CONTROL: without a session the screen is not reachable", async ({ page, baseURL }) => {
    await page.context().clearCookies();
    await page.context().setExtraHTTPHeaders({});
    const response = await page.goto(`${baseURL ?? ""}/projects/${PROJECT_ID}/timesheet`);
    expect(page.url()).toContain("/login");
    expect(response?.status()).toBeLessThan(400);
  });

  test("refuses a bad file with every line, and imports a good one behind the preview", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL ?? "";
    await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookieHeader(PRINCIPAL_ID) });
    await page.goto(`${base}/projects/${PROJECT_ID}/timesheet`);
    await expect(page.getByTestId("timesheet-screen")).toBeVisible();

    // The screen must state how much of AC actually carries a date, or an as-of
    // date on the dashboard looks more meaningful than it is.
    await expect(page.getByTestId("timesheet-coverage")).toBeVisible();

    // The header the screen itself publishes — read from the page rather than
    // hard-coded, so a change to the contract cannot leave this spec passing
    // against a format the product no longer accepts.
    const header = ((await page.getByTestId("timesheet-template").textContent()) ?? "").trim();
    expect(header).toContain("タスクNo");

    // A task number that cannot exist, and a member who does not, on two lines.
    const bad = `${header}\n999999,2026-08-03,No Such Member,1\n999998,2026-08-04,No Such Member,2\n`;
    await page.getByTestId("timesheet-file").setInputFiles({
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bad, "utf8"),
    });
    await page.getByTestId("timesheet-preview").click();

    const issues = page.getByTestId("timesheet-issues");
    await expect(issues).toBeVisible({ timeout: 20_000 });
    // EVERY line, with its number — not the first one. And it must say plainly
    // that nothing was written, which is the whole point of abandoning the file.
    await expect(issues).toContainText("2 行目");
    await expect(issues).toContainText("3 行目");
    await expect(issues).toContainText("1 行も書き込んでいません");
    // A rejected preview must leave the import button shut.
    await expect(page.getByTestId("timesheet-import")).toBeDisabled();

    await page.screenshot({
      path: `e2e/.artifacts/timesheet-rejected-${test.info().project.name}.png`,
    });

    // Now a file the seed can resolve. The member name is read off the members
    // screen so this spec carries no knowledge of the seed beyond "it has one".
    // The task number is NOT read off the grid: the No. column is a virtualised
    // cell with no stable hook, and adding a test id to the grid to serve a test
    // is the tail wagging the dog. `E2E_TIMESHEET_SEQ` names a LEAF task's No.;
    // without it this half is skipped rather than guessed at, because a summary
    // row's number is legitimately refused and would look like a product bug.
    const seq = process.env.E2E_TIMESHEET_SEQ ?? "";
    test.skip(seq === "", "set E2E_TIMESHEET_SEQ to a LEAF task's No. in the seeded project");
    // The WRITE runs in ONE theme only. Measured 2026-08-06: light and dark ran
    // the same import concurrently, serialised on the project row lock the command
    // unit of work takes, and the second one spent 2.6 minutes waiting — a test of
    // lock contention, not of the feature. Light and dark matter for what a page
    // LOOKS like; a POST has no theme.
    test.skip(
      test.info().project.name !== "light",
      "the import is a write; one theme runs it, both themes render the rejection",
    );

    await page.goto(`${base}/projects/${PROJECT_ID}/members`);
    const firstMember = await page.getByLabel("メンバー名").first().inputValue();
    expect(firstMember.trim()).not.toBe("");

    await page.goto(`${base}/projects/${PROJECT_ID}/timesheet`);
    const good = `${header}\n${seq},2026-08-03,${firstMember.trim()},1.5\n`;
    await page.getByTestId("timesheet-file").setInputFiles({
      name: "good.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(good, "utf8"),
    });
    await page.getByTestId("timesheet-preview").click();

    // The count that justifies the gate is on screen BEFORE the button opens.
    await expect(page.getByTestId("timesheet-partition-count")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("timesheet-import")).toBeEnabled();

    // MEASURED 2026-08-06 against staging: the import takes tens of seconds on a
    // 216-task project, and the reason is the write path, not this feature. The
    // command unit of work UPDATEs every task row one statement at a time (two
    // passes, plus a full delete/insert of the dependency table) and staging's
    // database is in another region — so the cost is round trips × tasks, paid by
    // every command. The WBS grid hides it behind a background save queue; an
    // import is a foreground button, so it is the first place a person sees it.
    // The generous budget here is honest about that rather than pretending.
    const startedAt = Date.now();
    await page.getByTestId("timesheet-import").click();
    await expect(page.getByTestId("timesheet-done")).toBeVisible({ timeout: 120_000 });
    test.info().annotations.push({
      type: "measured",
      description: `import round trip: ${Math.round((Date.now() - startedAt) / 1000)}s`,
    });

    await page.screenshot({
      path: `e2e/.artifacts/timesheet-imported-${test.info().project.name}.png`,
    });
  });

  test("the dashboard draws the trend, and says why EV is only a point", async ({
    page,
    baseURL,
  }) => {
    // Feature 3's user-visible outcome. The absent EV line is the claim most
    // likely to be "fixed" later by someone who reads it as missing, so the
    // sentence explaining it is asserted as part of the feature.
    await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookieHeader(PRINCIPAL_ID) });
    await page.goto(`${baseURL ?? ""}/projects/${PROJECT_ID}/dashboard`);

    const trend = page.getByTestId("evm-trend");
    await expect(trend).toBeVisible();
    await expect(trend).toContainText("線になりません");
    await expect(page.getByTestId("evm-trend-pv")).toBeVisible();

    await page.screenshot({ path: `e2e/.artifacts/trend-${test.info().project.name}.png` });
  });
});
