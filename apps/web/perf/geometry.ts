// Grid geometry the perf harness relies on. These mirror constants private to
// app/wbs/wbs-app.tsx (ROW_H, HEADER_H, DAILY_COL_W, PINNED/META widths); the
// Playwright spec cross-checks them against the real DOM, so drift fails loudly.

export const ROW_H = 30;
export const HEADER_H = 68;
export const DAILY_COL_W = 48;
export const PINNED_WIDTH = 536;
export const META_WIDTH = 2264;
export const VIEW_WIDTH = 1440;
export const VIEW_HEIGHT = 900;
export const DAY_OVERSCAN = 6;

export const AXIS_START = "2026-01-05";
/** scrollLeft that puts the first day column right at the pinned edge. */
export const V_LEFT = META_WIDTH - PINNED_WIDTH;
export const V_STEP = 750;
export const H_STEP = 360;
/** scrollTop of the horizontal sweeps (row index 2,400). */
export const H_TOP = 2400 * ROW_H;
/** Leaf row stamped for the edit probe, and its day column (2026-01-15). */
export const EDIT_ROW = 2501;
export const EDIT_COL = 10;
export const EDIT_MINUTES_BEFORE = 120;
export const EDIT_HOURS_TYPED = "20";
export const STAMP_COLS = [6, 7, 8, 9, 10] as const;

export type SweepKind = "V45c" | "V" | "H" | "D";

export interface Position {
  readonly top: number;
  readonly left: number;
}

function bounce(value: number, max: number): number {
  if (max <= 0) return 0;
  const period = max * 2;
  const wrapped = value % period;
  return wrapped <= max ? wrapped : period - wrapped;
}

/** Scroll positions of a sweep, clamped to the scrollable range; the last one is the far end. */
export function sweepPositions(
  kind: SweepKind,
  dims: { readonly maxTop: number; readonly maxLeft: number; readonly clientHeight: number },
): Position[] {
  const out: Position[] = [];
  if (kind === "V45c" || kind === "V") {
    const step = kind === "V45c" ? Math.max(1, dims.clientHeight) : V_STEP;
    const left = kind === "V45c" ? 0 : Math.min(V_LEFT, dims.maxLeft);
    for (let top = 0; top < dims.maxTop; top += step) out.push({ top, left });
    out.push({ top: dims.maxTop, left });
    return out;
  }
  if (kind === "H") {
    const top = Math.min(H_TOP, dims.maxTop);
    for (let left = 0; left < dims.maxLeft; left += H_STEP) out.push({ top, left });
    out.push({ top, left: dims.maxLeft });
    return out;
  }
  const steps = Math.ceil(dims.maxTop / V_STEP);
  for (let k = 0; k <= steps; k += 1) {
    out.push({
      top: Math.min(dims.maxTop, k * V_STEP),
      left: bounce(k * H_STEP, dims.maxLeft),
    });
  }
  return out;
}

export function addDays(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

/** Day-column indexes fully inside the unobscured band for a scrollLeft. */
export function visibleColumns(left: number, clientWidth: number, cols: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < cols; j += 1) {
    const start = META_WIDTH + j * DAILY_COL_W;
    if (start >= left + PINNED_WIDTH && start + DAILY_COL_W <= left + clientWidth) out.push(j);
  }
  return out;
}

/** Row indexes fully inside the area below the sticky header for a scrollTop. */
export function visibleRows(top: number, clientHeight: number, rowCount: number): number[] {
  const first = Math.max(0, Math.ceil(top / ROW_H));
  const last = Math.min(rowCount - 1, Math.floor((top + clientHeight - HEADER_H - ROW_H) / ROW_H));
  const out: number[] = [];
  for (let i = first; i <= last; i += 1) out.push(i);
  return out;
}
