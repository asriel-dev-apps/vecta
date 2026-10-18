/* global window, document, performance, requestAnimationFrame, setTimeout, MutationObserver -- page.evaluate callbacks run in the browser */
// Shared by measure.mjs and grid-scroll.spec.ts: server identity, page opening,
// and the real-input edit probe.
import { EDIT } from "./expected.mjs";

export const PORT = 4177;
export const BASE = `http://127.0.0.1:${PORT}`;
export const FIXTURE_ID = "vecta-perf-v1";
const ROW_H = 30;
const V_LEFT = 1728;

export async function assertServerIdentity(base = BASE) {
  const response = await fetch(`${base}/__perf-identity`);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.fixture !== FIXTURE_ID) {
    throw new Error(`${base} is not the perf fixture server (got ${response.status})`);
  }
}

/** Opens the perf page and waits until real rows exist; fails if the fixture is not the requested one. */
export async function openPerfPage(context, base, cols, rows = 5000) {
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    window.__firstRowMs = new Promise((resolve) => {
      const ready = () => document.querySelector?.(".grid-row--child") != null;
      const arm = () => {
        if (ready()) return resolve(performance.now());
        const root = document.documentElement;
        if (root === null) return void setTimeout(arm, 0);
        const observer = new MutationObserver(() => {
          if (!ready()) return;
          observer.disconnect();
          resolve(performance.now());
        });
        observer.observe(root, { childList: true, subtree: true });
      };
      arm();
    });
  });
  await page.goto(`${base}/?n=${rows}&cols=${cols}`, { waitUntil: "commit" });
  const firstRowMs = await page.evaluate(() => window.__firstRowMs);
  await page.locator(".grid-row--child").first().waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const meta = await page.evaluate(() => {
    const api = window.__PERF__;
    return api === undefined
      ? null
      : { fixtureId: api.fixtureId, rows: api.rows, cols: api.cols, taskCount: api.taskCount, firstDate: api.firstDate, lastDate: api.lastDate, renderStartMs: api.renderStartMs };
  });
  if (meta === null || meta.fixtureId !== FIXTURE_ID || meta.rows !== rows || meta.cols !== cols || meta.taskCount !== rows) {
    throw new Error(`wrong fixture on the page: ${JSON.stringify(meta)}`);
  }
  return { page, firstRowMs, renderMs: firstRowMs - meta.renderStartMs, meta, errors };
}

/**
 * Real-input edit of the sentinel cell. Returns { ms, failures[] }; ms is
 * Enter -> derived hours cell AND BAC both show their literal expected values.
 */
export async function runEdit(page, cols) {
  const want = EDIT[cols];
  const failures = [];
  const rowId = await page.evaluate((index) => window.__PERF__.taskId(index), EDIT.rowIndex);
  await page.evaluate(([top, left]) => window.__PERF__.scrollTo(top, left), [EDIT.rowIndex * ROW_H - 300, V_LEFT]);
  const cell = page.locator(`[data-daily-row="${rowId}"][data-daily-date="${EDIT.date}"]`);
  await cell.waitFor({ state: "visible" });
  const read = () =>
    page.evaluate(
      ([id]) => {
        const metric = [...document.querySelectorAll('[data-testid="rollup"] .rollup-metric')].find((element) =>
          element.querySelector(".rollup-metric-label")?.textContent?.includes("BAC"),
        );
        return {
          bac: metric?.querySelector(".rollup-metric-value")?.textContent ?? null,
          hours: document.querySelector(`[data-row-id="${id}"] [data-col="plannedEffortHours"]`)?.textContent ?? null,
        };
      },
      [rowId],
    );
  const cellText = () => cell.locator(".daily-cell-value").textContent();
  const before = await read();
  if ((await cellText()) !== EDIT.cellBefore) failures.push(`cell before: "${await cellText()}" expected "${EDIT.cellBefore}"`);
  if (before.bac !== want.bacBefore) failures.push(`BAC before: "${before.bac}" expected "${want.bacBefore}"`);
  if (before.hours !== want.rowHoursBefore) failures.push(`row hours before: "${before.hours}" expected "${want.rowHoursBefore}"`);
  await cell.dblclick();
  const editor = page.locator("input.daily-cell-editor");
  await editor.waitFor({ state: "visible" });
  await editor.fill(EDIT.typedHours);
  await page.evaluate(
    ([id, bacAfter, hoursAfter]) => {
      window.__editMs = undefined;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Enter") return;
          const start = performance.now();
          const done = () => {
            const metric = [...document.querySelectorAll('[data-testid="rollup"] .rollup-metric')].find((element) =>
              element.querySelector(".rollup-metric-label")?.textContent?.includes("BAC"),
            );
            const bac = metric?.querySelector(".rollup-metric-value")?.textContent;
            const hours = document.querySelector(`[data-row-id="${id}"] [data-col="plannedEffortHours"]`)?.textContent;
            if (bac === bacAfter && hours === hoursAfter) return void (window.__editMs = performance.now() - start);
            if (performance.now() - start > 10_000) return void (window.__editMs = -1);
            requestAnimationFrame(done);
          };
          requestAnimationFrame(done);
        },
        { capture: true, once: true },
      );
    },
    [rowId, want.bacAfter, want.rowHoursAfter],
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__editMs !== undefined, null, { timeout: 15_000 });
  const ms = await page.evaluate(() => window.__editMs);
  const after = await read();
  if ((await cellText()) !== EDIT.cellAfter) failures.push(`cell after: "${await cellText()}" expected "${EDIT.cellAfter}"`);
  if (after.bac !== want.bacAfter) failures.push(`BAC after: "${after.bac}" expected "${want.bacAfter}"`);
  if (after.hours !== want.rowHoursAfter) failures.push(`row hours after: "${after.hours}" expected "${want.rowHoursAfter}"`);
  return { ms, failures, before, after };
}
