import { expect, test, type Page } from "@playwright/test";
import { BASE, assertServerIdentity, openPerfPage, runEdit } from "./drive.mjs";
import { EDIT } from "./expected.mjs";
import { DAILY_COL_W, META_WIDTH, PINNED_WIDTH, ROW_H } from "./geometry";
import type { Check } from "./driver";

test.beforeAll(async () => {
  await assertServerIdentity(BASE);
});

async function open(page: Page, cols: number): Promise<Page> {
  return (await openPerfPage(page.context(), BASE, cols)).page;
}

for (const [cols, kinds] of [
  [45, ["V45c", "V", "H"]],
  [500, ["V", "H", "D"]],
] as const) {
  for (const kind of kinds) {
    test(`${kind} at ${cols} columns: every destination row, header and cell is drawn with the fixture's values`, async ({ page }) => {
      const p = await open(page, cols);
      const check: Check = await p.evaluate((k) => window.__PERF__!.check(k), kind);
      expect(check.failures).toEqual([]);
      expect(check.rowsChecked).toBeGreaterThan(check.steps);
      if (kind === "V" || kind === "H") {
        expect(check.nonzeroCellsChecked).toBeGreaterThan(check.steps);
        expect(check.headersChecked).toBeGreaterThan(0);
      }
    });
  }
}

test("geometry constants match the real DOM", async ({ page }) => {
  const current = await open(page, 45);
  await current.evaluate(() => window.__PERF__!.scrollTo(0, 1728));
  const geometry = await current.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row-id]")];
    const cell = rows[0]!.querySelector<HTMLElement>("[data-daily-date]")!;
    return {
      pinned: rows[0]!.querySelector<HTMLElement>(".pinned-group")!.offsetWidth,
      rowGap: Number.parseFloat(rows[1]!.style.top) - Number.parseFloat(rows[0]!.style.top),
      firstRowTop: Number.parseFloat(rows[0]!.style.top),
      cellWidth: cell.offsetWidth,
      firstCellLeft: Number.parseFloat(cell.style.left),
      clientWidth: document.querySelector<HTMLElement>('[data-testid="wbs-grid"]')!.clientWidth,
      firstDate: document.querySelector<HTMLElement>(".head-cell--day")!.title,
    };
  });
  expect(geometry).toMatchObject({
    pinned: PINNED_WIDTH,
    rowGap: ROW_H,
    firstRowTop: 68,
    cellWidth: DAILY_COL_W,
    firstCellLeft: META_WIDTH,
    firstDate: "2026-01-05",
  });
});

test("the hidden-cell control: an overscan cell under the pinned region is rendered but not visible", async ({ page }) => {
  const current = await open(page, 500);
  await current.evaluate(() => window.__PERF__!.scrollTo(30_000, 6000));
  const result = await current.evaluate(() => {
    const api = window.__PERF__!;
    const box = document.querySelector<HTMLElement>('[data-testid="wbs-grid"]')!.getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>("[data-row-id]")].find((candidate) => api.isVisible(candidate))!;
    const cells = [...row.querySelectorAll<HTMLElement>("[data-daily-date]")];
    const hidden = cells.find((cell) => cell.getBoundingClientRect().right <= box.left + 536);
    const shown = cells.find((cell) => cell.getBoundingClientRect().left >= box.left + 536 + 100 && cell.getBoundingClientRect().right <= box.right - 100);
    return {
      hiddenRendered: hidden !== undefined,
      hiddenVisible: hidden === undefined ? null : api.isVisible(hidden),
      shownVisible: shown === undefined ? null : api.isVisible(shown),
    };
  });
  expect(result).toEqual({ hiddenRendered: true, hiddenVisible: false, shownVisible: true });
});

test("rows: the last row of a 5,000-row grid is the 4,999th with its literal name", async ({ page }) => {
  const current = await open(page, 45);
  await current.evaluate(() => window.__PERF__!.scrollTo(1e9, 0));
  await expect(current.locator('[data-testid="wbs-grid"]')).toHaveAttribute("aria-rowcount", "5000");
  await expect(current.locator('[data-row-id] [data-col="name"]').last()).toContainText("Subtask 834.1");
  await expect(current.locator('[data-row-id] [data-col="no"] .row-no').last()).toHaveText("5000");
});

for (const cols of [45, 500] as const) {
  test(`edit at ${cols} columns: the cell, the row hours and BAC show the literal expected numbers`, async ({ page }) => {
    const current = await open(page, cols);
    const edit = await runEdit(current, cols);
    expect(edit.failures).toEqual([]);
    expect(edit.after).toEqual({ bac: EDIT[cols].bacAfter, hours: EDIT[cols].rowHoursAfter });
    expect(edit.ms).toBeGreaterThan(0);
  });
}
