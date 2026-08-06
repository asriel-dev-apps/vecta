// Effort-first EVM. Task-level effort is person-hours, stored as integer
// person-minutes; project aggregates are person-days = person-hours / 8. No
// rounding. Division by zero yields "-"; the planned-progress ratio yields 0.

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 8;

/** A ratio that is "-" when its denominator is zero. */
export type EffortRatio = number | "-";

export type TaskStatus = "NOT_STARTED" | "IN_PROGRESS" | "DONE";

export interface EffortTaskInput {
  readonly id: string;
  /** L — planned estimate, person-minutes. */
  readonly plannedEffortMinutes: number;
  /** T — progress in basis points (0–10000); T = value / 10000. */
  readonly progressBasisPoints: number;
  /** W — expended effort, person-minutes. */
  readonly actualEffortMinutes: number;
  /** Daily planned-value plot: sparse ISO-date → person-minutes map. */
  readonly dailyPlan: Readonly<Record<string, number>>;
  /**
   * Dated expended effort: sparse ISO-date → person-minutes (Design 0011).
   *
   * When this map has ANY entry, W is read from it as of the status date and
   * {@link EffortTaskInput.actualEffortMinutes} is ignored — the import keeps the
   * two in agreement at the file's last date, and the dated rows are the ones
   * that carry a time axis. When it is empty or absent, W is the stored current
   * value exactly as before, which is why importing nothing moves no number.
   *
   * This is the mirror of `dailyPlan`: one gives the plan a time axis, the other
   * gives the actuals one. AC was the metric that had none — measured 2026-08-05,
   * three status dates over one fixture left AC at 0.625 and CPI a constant 0.8.
   */
  readonly datedActualsByDate?: Readonly<Record<string, number>>;
  /**
   * Whether this task is a leaf — a task no other task names as its parent.
   * Only leaves contribute to the project rollup; non-leaf summary rows (`false`)
   * aggregate their children and would otherwise double-count. Absent means leaf,
   * so a flat task list rolls up unchanged.
   */
  readonly isLeaf?: boolean;
}

export interface EffortInput {
  readonly statusDate: string;
  readonly tasks: readonly EffortTaskInput[];
}

export interface EffortTaskMetrics {
  readonly id: string;
  /** T — actual progress fraction (0–1). */
  readonly progress: number;
  /** K — planned effort, person-days = L / 8. */
  readonly plannedEffortDays: number;
  /** M — planned effort, person-hours = Σ daily. */
  readonly plannedEffortHours: number;
  /** N — planned earned to date, person-hours = Σ daily ≤ status date. */
  readonly plannedEarnedHours: number;
  /** O — planned progress = N / M, div0 → 0. */
  readonly plannedProgress: number;
  /** P — planned start = first non-zero daily date, else null. */
  readonly plannedStart: string | null;
  /** Q — planned finish = last non-zero daily date, else null. */
  readonly plannedFinish: string | null;
  /** U — status derived from T. */
  readonly status: TaskStatus;
  /** V — actual earned effort (EV), person-hours = M × T. */
  readonly earnedEffortHours: number;
  /** W — actual expended effort (AC), person-hours. */
  readonly actualEffortHours: number;
  /** X — cost variance (CV), person-hours = V − W. */
  readonly costVarianceHours: number;
}

export interface EffortRollup {
  /** BAC — Σ (task M / 8), person-days. */
  readonly bac: number;
  /** PV — Σ (task N / 8), person-days. */
  readonly pv: number;
  /** EV — Σ (task (M × T) / 8), person-days. */
  readonly ev: number;
  /** AC — Σ (task W / 8), person-days. */
  readonly ac: number;
  /** SV = EV − PV. */
  readonly sv: number;
  /** CV = EV − AC. */
  readonly cv: number;
  /** SPI = EV / PV, div0 → "-". */
  readonly spi: EffortRatio;
  /** CPI = EV / AC, div0 → "-". */
  readonly cpi: EffortRatio;
}

export interface EffortResult {
  readonly tasks: readonly EffortTaskMetrics[];
  readonly rollup: EffortRollup;
}

/**
 * Forecast at the current cost performance — the EVM "typical" case, in effort.
 * EAC = BAC / CPI and ETC = EAC − AC, both person-days.
 *
 * Expressed as BAC × AC / EV rather than BAC / CPI so the caller need not carry a
 * ratio that may be `"-"`; the two are the same quantity. It is deliberately the
 * BAC/CPI variant and not `AC + (BAC − EV)`: every input is a column the same row
 * already shows, so a reader can verify the forecast against the row itself.
 *
 * Undefined — `"-"` — in exactly the two cases where the division has no value:
 * `ac === 0` is where CPI itself is `"-"`, and `ev === 0` with effort already
 * spent makes CPI zero, so BAC / CPI is a division by zero. Returning `"-"` for
 * both keeps an infinity out of the column.
 */
export interface EffortForecast {
  /** EAC — estimate at completion, person-days. */
  readonly eac: EffortRatio;
  /** ETC — estimate to complete, person-days = EAC − AC. */
  readonly etc: EffortRatio;
}

export function effortForecast(bac: number, ev: number, ac: number): EffortForecast {
  if (ac === 0 || ev === 0) return { eac: "-", etc: "-" };
  const eac = (bac * ac) / ev;
  return { eac, etc: eac - ac };
}

function minutesToHours(minutes: number): number {
  return minutes / MINUTES_PER_HOUR;
}

function hoursToDays(hours: number): number {
  return hours / HOURS_PER_DAY;
}

/**
 * Person-hours → person-days, the one conversion the aggregates use. Exported so
 * a caller that rolls up {@link EffortTaskMetrics} itself (the EVM dashboard sums
 * leaf metrics per parent task and per member) reaches the same person-day scale
 * through this module rather than repeating the 8.
 */
export function effortHoursToDays(hours: number): number {
  return hoursToDays(hours);
}

/** U — status derived from T (basis points). */
export function taskStatus(progressBasisPoints: number): TaskStatus {
  if (progressBasisPoints <= 0) return "NOT_STARTED";
  if (progressBasisPoints >= 10_000) return "DONE";
  return "IN_PROGRESS";
}

function ratio(numerator: number, denominator: number): EffortRatio {
  return denominator === 0 ? "-" : numerator / denominator;
}

export function calculateTaskEffort(
  task: EffortTaskInput,
  statusDate: string,
): EffortTaskMetrics {
  const progress = task.progressBasisPoints / 10_000;

  let plannedMinutes = 0;
  let earnedMinutes = 0;
  let plannedStart: string | null = null;
  let plannedFinish: string | null = null;
  for (const [date, value] of Object.entries(task.dailyPlan)) {
    plannedMinutes += value;
    if (date <= statusDate) earnedMinutes += value;
    if (value > 0) {
      if (plannedStart === null || date < plannedStart) plannedStart = date;
      if (plannedFinish === null || date > plannedFinish) plannedFinish = date;
    }
  }

  // W as of the status date. A task with dated actuals is read from them; a task
  // without keeps the single stored figure, which has no time axis and therefore
  // cannot be filtered by one. Both branches are needed: production has no dated
  // actuals at all, and its numbers must not move when this arrives.
  let datedMinutes = 0;
  let hasDatedActuals = false;
  for (const [date, value] of Object.entries(task.datedActualsByDate ?? {})) {
    hasDatedActuals = true;
    if (date <= statusDate) datedMinutes += value;
  }

  const plannedEffortHours = minutesToHours(plannedMinutes); // M
  const plannedEarnedHours = minutesToHours(earnedMinutes); // N
  const actualEffortHours = minutesToHours(
    hasDatedActuals ? datedMinutes : task.actualEffortMinutes,
  ); // W
  const earnedEffortHours = plannedEffortHours * progress; // V = M × T

  return {
    id: task.id,
    progress,
    plannedEffortDays: hoursToDays(minutesToHours(task.plannedEffortMinutes)), // K = L / 8
    plannedEffortHours,
    plannedEarnedHours,
    plannedProgress: plannedEffortHours === 0 ? 0 : plannedEarnedHours / plannedEffortHours, // O
    plannedStart,
    plannedFinish,
    status: taskStatus(task.progressBasisPoints),
    earnedEffortHours,
    actualEffortHours,
    costVarianceHours: earnedEffortHours - actualEffortHours, // X = V − W
  };
}

export function calculateEffortEvm(input: EffortInput): EffortResult {
  const tasks = input.tasks.map((task) => calculateTaskEffort(task, input.statusDate));

  // Leaf-only rollup. A non-leaf task is a summary row whose effort is carried by
  // its leaf children; summing it as well would double-count. Per-task metrics are
  // still computed for every row above so per-row display is unchanged.
  let bac = 0;
  let pv = 0;
  let ev = 0;
  let ac = 0;
  input.tasks.forEach((task, index) => {
    if (task.isLeaf === false) return;
    const metrics = tasks[index]!;
    bac += hoursToDays(metrics.plannedEffortHours);
    pv += hoursToDays(metrics.plannedEarnedHours);
    ev += hoursToDays(metrics.earnedEffortHours);
    ac += hoursToDays(metrics.actualEffortHours);
  });

  return {
    tasks,
    rollup: {
      bac,
      pv,
      ev,
      ac,
      sv: ev - pv,
      cv: ev - ac,
      spi: ratio(ev, pv),
      cpi: ratio(ev, ac),
    },
  };
}
