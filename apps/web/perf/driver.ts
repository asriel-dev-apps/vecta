import {
  DAILY_COL_W,
  DAY_OVERSCAN,
  HEADER_H,
  META_WIDTH,
  PINNED_WIDTH,
  ROW_H,
  addDays,
  sweepPositions,
  visibleColumns,
  visibleRows,
  type Position,
  type SweepKind,
} from "./geometry";
import type { PerfFixture } from "./fixture";

// Runs inside the page. The timed sweep and the untimed correctness pass are
// separate functions on purpose: nothing but scrolling happens while frames are
// being measured. The oracle is the fixture INPUT (ids, names, No., dailyPlan);
// it never reads back what the App rendered to decide what is expected.

export interface Check {
  readonly steps: number;
  readonly rowsChecked: number;
  readonly cellsChecked: number;
  readonly nonzeroCellsChecked: number;
  readonly headersChecked: number;
  readonly emptyDayWindows: number;
  readonly zeroNonzeroSteps: number;
  readonly failures: readonly string[];
}

interface Counters {
  rowsChecked: number;
  cellsChecked: number;
  nonzeroCellsChecked: number;
  headersChecked: number;
  emptyDayWindows: number;
  zeroNonzeroSteps: number;
}

export interface Sweep {
  readonly steps: number;
  readonly frameCount: number;
  readonly framesOver50: number;
  readonly p95FrameMs: number;
  readonly worstFrameMs: number;
  readonly longTaskCount: number;
}

export interface PerfApi {
  readonly fixtureId: string;
  readonly rows: number;
  readonly cols: number;
  readonly taskCount: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly bootMs: number;
  readonly renderStartMs: number;
  dims(): { maxTop: number; maxLeft: number; clientHeight: number; clientWidth: number; scrollHeight: number; scrollWidth: number };
  positions(kind: SweepKind): Position[];
  sweep(kind: SweepKind): Promise<Sweep>;
  check(kind: SweepKind): Promise<Check>;
  checkAt(top: number, left: number): Promise<Check>;
  scrollTo(top: number, left: number): Promise<void>;
  isVisible(element: Element): boolean;
  taskId(index: number): string;
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(count);
  });

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="wbs-grid"]');
  if (element === null) throw new Error("missing scroller");
  return element;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function installDriver(
  fixture: PerfFixture,
  info: { fixtureId: string; bootMs: number; renderStartMs: number },
): PerfApi {
  const tasks = fixture.project.tasks;
  const total = tasks.length;
  const dateIndex = new Map<string, number>();
  for (let j = 0; j < fixture.cols; j += 1) dateIndex.set(addDays(fixture.firstDate, j), j);

  const dims = () => {
    const el = scroller();
    return {
      maxTop: el.scrollHeight - el.clientHeight,
      maxLeft: el.scrollWidth - el.clientWidth,
      clientHeight: el.clientHeight,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
    };
  };

  const isVisible = (element: Element): boolean => {
    const el = scroller();
    const box = el.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const isRow = element.hasAttribute("data-row-id");
    const isCell = element.hasAttribute("data-daily-date");
    const isHead = element.classList.contains("head-cell--day");
    const vertical =
      rect.top >= box.top + (isHead ? 0 : HEADER_H) - 0.5 && rect.bottom <= box.top + el.clientHeight + 0.5;
    // A row spans the whole day axis, so only its vertical extent is judged.
    const horizontal =
      isRow || (rect.left >= box.left + (isCell || isHead ? PINNED_WIDTH : 0) - 0.5 && rect.right <= box.left + el.clientWidth + 0.5);
    return vertical && horizontal;
  };

  const checkNow = (failures: string[], counters: Counters): void => {
    const el = scroller();
    const top = el.scrollTop;
    const left = el.scrollLeft;
    const at = `@top=${Math.round(top)},left=${Math.round(left)}`;
    const fail = (message: string) => {
      if (failures.length < 25) failures.push(`${at} ${message}`);
    };
    const box = el.getBoundingClientRect();

    const rowIndexes = visibleRows(top, el.clientHeight, total);
    for (const index of rowIndexes) {
      const task = tasks[index]!;
      const row = el.querySelector<HTMLElement>(`[data-row-id="${task.id}"]`);
      if (row === null) {
        fail(`row ${index} (${task.name}) is not in the DOM`);
        continue;
      }
      counters.rowsChecked += 1;
      const name = row.querySelector('[data-col="name"]')?.textContent ?? "";
      if (!name.includes(task.name)) fail(`row ${index} name "${name}" does not contain "${task.name}"`);
      const no = row.querySelector('[data-col="no"] .row-no')?.textContent ?? "";
      if (no !== String(task.seq).padStart(4, "0")) fail(`row ${index} No. "${no}" expected ${task.seq}`);
      if (Number.parseFloat(row.style.top) !== HEADER_H + index * ROW_H) fail(`row ${index} style.top ${row.style.top}`);
      if (!isVisible(row)) fail(`row ${index} is outside the unobscured viewport`);
    }
    const rendered = el.querySelectorAll<HTMLElement>("[data-row-id]");
    if (rendered.length >= 80) fail(`${rendered.length} rows rendered (virtualization expected < 80)`);
    for (const row of rendered) {
      const index = (Number.parseFloat(row.style.top) - HEADER_H) / ROW_H;
      if (tasks[index]?.id !== row.getAttribute("data-row-id")) fail(`rendered row at top ${row.style.top} has the wrong id`);
    }
    const firstRow = rendered[0];
    const pinned = firstRow?.querySelector(".pinned-group");
    if (pinned !== null && pinned !== undefined && Math.abs(pinned.getBoundingClientRect().left - box.left) > 0.5) {
      fail(`pinned group left ${pinned.getBoundingClientRect().left} != scroller left ${box.left}`);
    }
    if (top > 0 && top >= el.scrollHeight - el.clientHeight - 1) {
      if (el.querySelector(`[data-row-id="${tasks[total - 1]!.id}"]`) === null) fail("last row missing at the bottom");
    }
    if (top > 6 * el.clientHeight && el.querySelector(`[data-row-id="${tasks[0]!.id}"]`) !== null) fail("row 0 still rendered far away");
    if (el.getAttribute("aria-rowcount") !== String(total)) fail(`aria-rowcount ${el.getAttribute("aria-rowcount")} != ${total}`);

    const cols = visibleColumns(left, el.clientWidth, fixture.cols);
    if (cols.length === 0) counters.emptyDayWindows += 1;
    let nonzero = 0;
    for (const j of cols) {
      const date = addDays(fixture.firstDate, j);
      const header = el.querySelector<HTMLElement>(`.head-cell--day[title="${date}"]`);
      if (header === null) {
        fail(`header for ${date} missing`);
        continue;
      }
      counters.headersChecked += 1;
      if (header.textContent !== date.slice(8)) fail(`header ${date} text "${header.textContent}"`);
      if (!isVisible(header)) fail(`header ${date} outside the unobscured viewport`);
    }
    for (const index of rowIndexes) {
      const task = tasks[index]!;
      const row = el.querySelector<HTMLElement>(`[data-row-id="${task.id}"]`);
      if (row === null) continue;
      for (const j of cols) {
        const date = addDays(fixture.firstDate, j);
        const cell = row.querySelector<HTMLElement>(`[data-daily-date="${date}"]`);
        const minutes = task.dailyPlan[date] ?? 0;
        const expected = minutes > 0 ? fmt(minutes / 60) : "";
        if (cell === null) {
          fail(`cell row ${index} ${date} missing`);
          continue;
        }
        counters.cellsChecked += 1;
        if (minutes > 0) {
          nonzero += 1;
          counters.nonzeroCellsChecked += 1;
        }
        const text = cell.querySelector(".daily-cell-value")?.textContent ?? "";
        if (text !== expected) fail(`cell row ${index} ${date} text "${text}" expected "${expected}"`);
        if (!isVisible(cell)) fail(`cell row ${index} ${date} outside the unobscured viewport`);
      }
    }
    if (cols.length > 0 && rowIndexes.length > 0 && nonzero === 0) counters.zeroNonzeroSteps += 1;
    // Stale columns: nothing rendered beyond the window plus overscan.
    // The virtualizer clamps its window to the axis: far left of the day columns it
    // still renders the first columns (up to the overscan), never anything else.
    const clamp = (value: number) => Math.min(fixture.cols - 1, Math.max(0, value));
    const firstCol = clamp(Math.floor((left - META_WIDTH) / DAILY_COL_W));
    const lastCol = clamp(Math.ceil((left + el.clientWidth - META_WIDTH) / DAILY_COL_W));
    const loBound = firstCol - DAY_OVERSCAN - 1;
    const hiBound = lastCol + DAY_OVERSCAN + 1;
    let sawDay = false;
    for (const header of el.querySelectorAll<HTMLElement>(".head-cell--day")) {
      sawDay = true;
      const j = dateIndex.get(header.title);
      if (j === undefined || j < loBound || j > hiBound) fail(`stale header ${header.title} (window ${loBound}..${hiBound})`);
    }
    if (!sawDay) fail("no day header rendered");
    const anyRow = rendered[0];
    if (anyRow !== undefined) {
      for (const cell of anyRow.querySelectorAll<HTMLElement>("[data-daily-date]")) {
        const j = dateIndex.get(cell.getAttribute("data-daily-date") ?? "");
        if (j === undefined || j < loBound || j > hiBound) fail(`stale cell ${cell.getAttribute("data-daily-date")}`);
      }
    }
  };

  const check = async (kind: SweepKind): Promise<Check> => {
    const positions = sweepPositions(kind, dims());
    const failures: string[] = [];
    const counters: Counters = { rowsChecked: 0, cellsChecked: 0, nonzeroCellsChecked: 0, headersChecked: 0, emptyDayWindows: 0, zeroNonzeroSteps: 0 };
    const el = scroller();
    for (const position of positions) {
      el.scrollTop = position.top;
      el.scrollLeft = position.left;
      await frames(2);
      checkNow(failures, counters);
    }
    const requiresNonzero = kind === "V" || kind === "H";
    if (requiresNonzero && counters.zeroNonzeroSteps > 0) failures.push(`${counters.zeroNonzeroSteps} step(s) had day cells in view but no nonzero fixture cell`);
    return { steps: positions.length, ...counters, failures };
  };

  const checkAt = async (top: number, left: number): Promise<Check> => {
    const el = scroller();
    el.scrollTop = top;
    el.scrollLeft = left;
    await frames(2);
    const failures: string[] = [];
    const counters: Counters = { rowsChecked: 0, cellsChecked: 0, nonzeroCellsChecked: 0, headersChecked: 0, emptyDayWindows: 0, zeroNonzeroSteps: 0 };
    checkNow(failures, counters);
    return { steps: 1, ...counters, failures };
  };

  const sweep = async (kind: SweepKind): Promise<Sweep> => {
    const el = scroller();
    const positions = sweepPositions(kind, dims());
    const longtasks: number[] = [];
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longtasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = undefined;
    }
    const gaps: number[] = [];
    let running = true;
    let last = performance.now();
    const onFrame = (timestamp: number) => {
      gaps.push(timestamp - last);
      last = timestamp;
      if (running) requestAnimationFrame(onFrame);
    };
    el.scrollTop = 0;
    el.scrollLeft = 0;
    await frames(2);
    gaps.length = 0;
    last = performance.now();
    requestAnimationFrame(onFrame);
    for (const position of positions) {
      el.scrollTop = position.top;
      el.scrollLeft = position.left;
      await frames(2);
    }
    running = false;
    await frames(1);
    observer?.disconnect();
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      steps: positions.length,
      frameCount: gaps.length,
      framesOver50: gaps.filter((gap) => gap > 50).length,
      p95FrameMs: sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
      worstFrameMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
      longTaskCount: longtasks.length,
    };
  };

  return {
    fixtureId: info.fixtureId,
    rows: fixture.rows,
    cols: fixture.cols,
    taskCount: total,
    firstDate: fixture.firstDate,
    lastDate: fixture.lastDate,
    bootMs: info.bootMs,
    renderStartMs: info.renderStartMs,
    dims,
    positions: (kind) => sweepPositions(kind, dims()),
    sweep,
    check,
    checkAt,
    scrollTo: async (top, left) => {
      const el = scroller();
      el.scrollTop = top;
      el.scrollLeft = left;
      await frames(2);
    },
    isVisible,
    taskId: (index) => tasks[index]!.id,
  };
}
