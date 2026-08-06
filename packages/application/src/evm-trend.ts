import {
  calculateBaselineEvm,
  calculateEffortEvm,
  effortHoursToDays,
  type BaselineTaskInput,
} from "@vecta/domain";
import { datedActualsByDate } from "./dated-actuals.js";
import { leafTaskIds, type ProjectState } from "./project-state.js";

/**
 * The EVM trend series (Design 0013).
 *
 * ## What is drawn, and what is deliberately not
 *
 * Two cumulative curves and one point:
 *
 *   * **PV(t)** — the approved baseline's daily plot, accumulated. Without a
 *     baseline it falls back to the current plan and says so, exactly as the
 *     dashboard strip does (Design 0009 §6).
 *   * **AC(t)** — the dated actuals, accumulated (Design 0011).
 *   * **EV** — ONE point, at the as-of date.
 *
 * **EV has no curve and will not be given a fabricated one.** The user's
 * 2026-08-06 answer put progress outside the timesheet import — one row is task ×
 * date × person × effort, with no progress column — so there is no progress
 * history anywhere in the product. A daily EVM snapshot could manufacture one
 * from today forward, but every date before the day it was switched on would stay
 * blank and could never be filled, so the mechanism would be built for a past it
 * cannot reach. The decision reverses the moment progress history becomes an
 * input; until then, not drawing the line is the honest option, and it matches
 * how the per-row mini S-curve already reads (`design/0007` §7.4).
 *
 * ## The one genuinely awkward part: undated actuals
 *
 * `AC(t)` is defined (Design 0011 §4) as the dated rows up to `t` PLUS the stored
 * W of every task that has no dated rows. That second term does not depend on `t`.
 * Adding it to the CURVE would raise the whole line by a constant from day one,
 * so a project that has logged nothing in January still shows January spend, and
 * the shape — which is the only reason to draw a curve at all — is destroyed.
 *
 * So the curve carries the dated term only, and the constant is returned
 * separately as {@link EvmTrendSeries.undatedActualDays} for the screen to state
 * next to it. The METRICS keep using both terms, because that is what Design 0011
 * defined AC to be. The two therefore disagree on purpose, and the screen has to
 * say so rather than let a reader discover it by subtracting.
 */

/** One point of a cumulative series, in person-days. */
export interface EvmTrendPoint {
  readonly date: string;
  /** Cumulative person-days up to and including `date`. */
  readonly value: number;
}

export interface EvmTrendSeries {
  /** Cumulative planned value. Empty when nothing is plotted at all. */
  readonly pv: readonly EvmTrendPoint[];
  /** Cumulative dated actuals. Empty when nothing has been imported. */
  readonly ac: readonly EvmTrendPoint[];
  /** Earned value at {@link EvmTrendSeries.statusDate}, person-days. One point, not a series. */
  readonly ev: number;
  readonly statusDate: string;
  /** Where PV came from — the screen must name it, an unlabelled PV cannot be read. */
  readonly pvSource: "baseline" | "current";
  /**
   * Person-days of actual effort that carry NO date, and so are absent from the
   * AC curve while still counting toward the AC metric (see the module note).
   */
  readonly undatedActualDays: number;
  /** First / last date either curve has a point on; `null` when both are empty. */
  readonly start: string | null;
  readonly end: string | null;
}

export interface EvmTrendOptions {
  readonly statusDate: string;
  /** The frozen plan, when one has been published. */
  readonly baselineTasks?: readonly BaselineTaskInput[];
}

/** Accumulate a sparse `date → minutes` map into a cumulative person-day series. */
function toCumulativeSeries(minutesByDate: ReadonlyMap<string, number>): EvmTrendPoint[] {
  const series: EvmTrendPoint[] = [];
  let cumulative = 0;
  for (const date of [...minutesByDate.keys()].sort()) {
    cumulative += minutesByDate.get(date) ?? 0;
    series.push({ date, value: effortHoursToDays(cumulative / 60) });
  }
  return series;
}

function addMinutes(target: Map<string, number>, date: string, minutes: number): void {
  // Zero-valued entries exist in both maps and carry nothing. Letting one through
  // would widen the axis and add a flat step, which reads as a day of no progress
  // rather than as a day nobody planned.
  if (minutes <= 0) return;
  target.set(date, (target.get(date) ?? 0) + minutes);
}

export function projectEvmTrend(
  project: ProjectState,
  options: EvmTrendOptions,
): EvmTrendSeries {
  const { statusDate, baselineTasks } = options;
  const leaves = leafTaskIds(project.tasks);
  const leafTasks = project.tasks.filter((task) => leaves.has(task.id));
  const hasBaseline = baselineTasks !== undefined && baselineTasks.length > 0;

  const plannedMinutes = new Map<string, number>();
  if (hasBaseline) {
    // Baseline rows are already leaves only — the publish path freezes no summary
    // rows — so there is no filter to repeat here and no chance of the two
    // disagreeing about what a leaf is.
    for (const task of baselineTasks) {
      for (const [date, minutes] of Object.entries(task.dailyPlan)) {
        addMinutes(plannedMinutes, date, minutes);
      }
    }
  } else {
    for (const task of leafTasks) {
      for (const [date, minutes] of Object.entries(task.dailyPlan)) {
        addMinutes(plannedMinutes, date, minutes);
      }
    }
  }

  const actualMinutes = new Map<string, number>();
  let undatedMinutes = 0;
  for (const task of leafTasks) {
    const byDate = datedActualsByDate(task.datedActuals);
    const dates = Object.keys(byDate);
    if (dates.length === 0) {
      undatedMinutes += task.actualEffortMinutes;
      continue;
    }
    for (const date of dates) addMinutes(actualMinutes, date, byDate[date] ?? 0);
  }

  // EV at the as-of date. Baseline-scoped when a baseline exists, for the same
  // reason the dashboard strip is (Design 0009 §9): mixing a baseline PV with a
  // current-plan EV would let merely adding work improve the comparison.
  const ev = hasBaseline
    ? calculateBaselineEvm({
        statusDate,
        baselineTasks,
        progressByTaskId: Object.fromEntries(
          project.tasks.map((task) => [task.id, task.progressBasisPoints]),
        ),
      }).ev
    : calculateEffortEvm({
        statusDate,
        tasks: leafTasks.map((task) => ({
          id: task.id,
          plannedEffortMinutes: task.plannedEffortMinutes,
          progressBasisPoints: task.progressBasisPoints,
          actualEffortMinutes: task.actualEffortMinutes,
          dailyPlan: task.dailyPlan,
          datedActualsByDate: datedActualsByDate(task.datedActuals),
        })),
      }).rollup.ev;

  const pv = toCumulativeSeries(plannedMinutes);
  const ac = toCumulativeSeries(actualMinutes);
  const dates = [...pv, ...ac].map((point) => point.date).sort();

  return {
    pv,
    ac,
    ev,
    statusDate,
    pvSource: hasBaseline ? "baseline" : "current",
    undatedActualDays: effortHoursToDays(undatedMinutes / 60),
    start: dates[0] ?? null,
    end: dates[dates.length - 1] ?? null,
  };
}
