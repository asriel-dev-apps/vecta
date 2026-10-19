/* global window, document, performance, requestAnimationFrame, setTimeout, MutationObserver -- page.evaluate callbacks run in the browser */
// Shared by measure.mjs and grid-scroll.spec.ts: server identity, page opening,
// and the real-input edit probe.
import { chromium } from "@playwright/test";
import { EDIT } from "./expected.mjs";
import { LANES, NOTCHES, START_LEFT, START_ROW } from "./gate.mjs";

export const PORT = Number(process.env.PERF_PORT ?? 4177);
export const BASE = `http://127.0.0.1:${PORT}`;
export const FIXTURE_ID = "vecta-perf-v1";
const ROW_H = 30;
const V_LEFT = START_LEFT;

/** Returns the build hash the server reports; throws if the port is not the perf fixture server. */
export async function assertServerIdentity(base = BASE) {
  const response = await fetch(`${base}/__perf-identity`);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.fixture !== FIXTURE_ID || typeof body.build !== "string") {
    throw new Error(`${base} is not the perf fixture server (got ${response.status})`);
  }
  return body.build;
}

/** Real wheel input only works unanimated with smooth scrolling off; smoothing is a proof-only toggle. */
export async function launchBrowser({ smooth = false } = {}) {
  const args = smooth ? [] : ["--disable-smooth-scrolling"];
  for (const options of [{ channel: "chrome", headless: true, args }, { headless: true, args }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // try the next channel
    }
  }
  throw new Error("no browser could be launched");
}

/** Renderer main-thread time (ms) so far: CDP Performance TaskDuration of this page. */
export async function taskTimer(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  return {
    now: async () => (await client.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value * 1000,
    detach: () => client.detach(),
  };
}

const GRID = '[data-testid="wbs-grid"]';
const raf2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** An empty scroller with the grid's scrollable size, the control for the wheel lanes. */
export async function openControlPage(context, dims) {
  const page = await context.newPage();
  await page.setContent(
    `<div id="s" style="width:${dims.clientWidth}px;height:${dims.clientHeight}px;overflow:auto"><div style="width:${dims.scrollWidth}px;height:${dims.scrollHeight}px"></div></div>`,
  );
  return page;
}

/**
 * The wheel procedure of a primary lane: go to row START_ROW, put the mouse over
 * the scroller, send NOTCHES real wheel inputs of the lane's delta. Shared by the
 * gate (timed), the destination replay (observe after each notch) and the spec.
 * selector: the scroller; move:false skips the mouse move (proof only);
 * control: no observe, "direct" assigns the scroll offset instead of a wheel (proof only).
 * Returns the per-notch work time (ms) and the scroll offsets read from the DOM.
 */
export async function wheelRun(page, laneId, { selector = GRID, move = true, timed = true, observe = false, direct = false } = {}) {
  const { dx, dy } = LANES[laneId].wheel;
  const read = () => page.evaluate((s) => ({ top: document.querySelector(s).scrollTop, left: document.querySelector(s).scrollLeft }), selector);
  const place = async () => {
    await page.evaluate(
      ([s, top, left]) => {
        const el = document.querySelector(s);
        el.scrollTop = top;
        el.scrollLeft = left;
        window.__wheels = 0;
      },
      [selector, START_ROW * ROW_H, START_LEFT],
    );
    await page.evaluate(raf2);
  };
  await page.evaluate((s) => document.querySelector(s).addEventListener("wheel", () => (window.__wheels += 1), { passive: true }), selector);
  await place();
  if (move) {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  }
  // The first wheel input of a fresh page costs ~40-50 ms of browser input setup on an empty
  // scroller too (measured); one down/up pair outside the window, then back to the start.
  if (!direct) {
    await page.mouse.wheel(dx, dy);
    await page.evaluate(raf2);
    await page.mouse.wheel(-dx, -dy);
    await page.evaluate(raf2);
    await place();
  }
  const timer = timed ? await taskTimer(page) : null;
  const start = await read();
  const stepMs = [];
  const failures = [];
  for (let notch = 0; notch < NOTCHES; notch += 1) {
    const before = timer === null ? 0 : await timer.now();
    if (direct) await page.evaluate(([s, x, y]) => { document.querySelector(s).scrollBy(x, y); }, [selector, dx, dy]);
    else await page.mouse.wheel(dx, dy);
    await page.evaluate(raf2);
    if (timer !== null) stepMs.push((await timer.now()) - before);
    if (observe) {
      const check = await page.evaluate(() => window.__PERF__.observe());
      for (const message of check.failures) if (failures.length < 25) failures.push(`notch ${notch + 1} ${message}`);
      if (failures.length < 25 && check.rowsChecked === 0) failures.push(`notch ${notch + 1}: no row was checked`);
      // vertical lanes stay on the stamped day columns: a nonzero fixture cell must be in view
      if (failures.length < 25 && dx === 0 && check.nonzeroCellsChecked === 0) failures.push(`notch ${notch + 1}: no nonzero fixture cell in view`);
    }
  }
  const end = await read();
  await timer?.detach();
  return { stepMs, start, end, wheelEvents: await page.evaluate(() => window.__wheels), failures };
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
