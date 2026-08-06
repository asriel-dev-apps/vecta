import {
  calculateEffortEvm,
  effortHoursToDays,
  type EffortInput,
  type EffortRatio,
  type EffortRollup,
  type EffortTaskInput,
} from "./evm.js";

/**
 * Schedule variance measured against an APPROVED BASELINE rather than against
 * whatever the plan says today (design 0009).
 *
 * ## Why this exists at all
 *
 * SV and PV are defined against an approved baseline, and until now there was
 * none: `calculateEffortEvm` derives PV from the CURRENT daily plot, so editing
 * the plan silently rewrote the past. A project could not be behind schedule for
 * longer than it took to move the plot.
 *
 * ## Why both sides come from the baseline (user decision, 2026-08-05)
 *
 * `calculateEffortEvm` computes EV as `M × T` where M is the current Σ dailyPlan.
 * Dividing a baseline PV by that EV would mix two scopes: a task added after
 * publishing lands in EV and not in PV, so merely adding work would improve SPI.
 *
 * So SV/SPI here use `M_baseline × T_current` — the frozen plot, the live
 * progress. The consequences are the point rather than side effects:
 *
 *   * a task added after publishing appears in NEITHER term and cannot move
 *     SPI. Scope growth shows up as a BAC difference instead. BAC answers "how
 *     much bigger did this get"; SV/SPI answer "how are we doing against what we
 *     agreed".
 *   * a task deleted after publishing keeps its baseline row at T = 0 and
 *     therefore HURTS SV, which is right: planned work that vanished is schedule
 *     variance, not an improvement.
 *
 * The grid's per-row EV column is NOT this. A row answers "how far through its
 * own current plan is this task", which must keep tracking the current plan.
 * Only the project rollup becomes baseline-scoped.
 *
 * ## What a baseline row carries, and what it deliberately does not
 *
 * Only `dailyPlan` and enough structure to know which rows are leaves. Measured
 * 2026-08-05: BAC and PV come from Σ dailyPlan, NOT from `plannedEffortMinutes`
 * — a task with a 480-minute estimate and an empty plot contributes 0, and one
 * with a 99,999-minute estimate and a single 480-minute day contributes 1 day.
 * Progress and actuals are deliberately absent: they are what the baseline is
 * being compared against.
 */

/** A task as it was frozen. `dailyPlan` is the whole of the plan side. */
export interface BaselineTaskInput {
  readonly id: string;
  /** The frozen daily planned-value plot: sparse ISO-date → person-minutes. */
  readonly dailyPlan: Readonly<Record<string, number>>;
  /** As in `EffortTaskInput`: absent means leaf, so a flat list rolls up unchanged. */
  readonly isLeaf?: boolean;
}

export interface BaselineEvmInput {
  readonly statusDate: string;
  readonly baselineTasks: readonly BaselineTaskInput[];
  /**
   * Current progress, keyed by task id, in basis points (0–10000). A task in the
   * baseline with no entry here has been DELETED from the current plan; it is
   * read as 0 % complete, which is what makes a vanished task hurt SV.
   */
  readonly progressByTaskId: Readonly<Record<string, number>>;
}

export interface BaselineEvmRollup {
  /** Budget at completion over the baseline scope, person-days. */
  readonly bac: number;
  /** Planned value from the FROZEN plot, accumulated through the status date. */
  readonly pv: number;
  /** `M_baseline × T_current`, person-days. */
  readonly ev: number;
  /** EV − PV. */
  readonly sv: number;
  /** EV / PV, `"-"` when PV is zero — the same convention as `calculateEffortEvm`. */
  readonly spi: EffortRatio;
}

/**
 * The baseline-scoped rollup.
 *
 * Implemented by feeding the frozen plot through `calculateEffortEvm` rather
 * than by re-deriving the arithmetic: BAC, PV and `M × T` are exactly what it
 * already computes, and a second implementation of the same formulas is a second
 * place for them to drift. Actual effort is passed as 0 because AC has no
 * baseline meaning — cost variance stays a current-plan measure — so `cv`/`cpi`
 * from that call are discarded rather than exposed.
 */
export function calculateBaselineEvm(input: BaselineEvmInput): BaselineEvmRollup {
  const tasks: readonly EffortTaskInput[] = input.baselineTasks.map((task) => ({
    id: task.id,
    // Unused by the rollup (measured: L never reaches BAC), and 0 keeps it from
    // reading as a second, disagreeing source of the budget.
    plannedEffortMinutes: 0,
    progressBasisPoints: input.progressByTaskId[task.id] ?? 0,
    actualEffortMinutes: 0,
    dailyPlan: task.dailyPlan,
    ...(task.isLeaf === undefined ? {} : { isLeaf: task.isLeaf }),
  }));

  const evmInput: EffortInput = { statusDate: input.statusDate, tasks };
  const rollup: EffortRollup = calculateEffortEvm(evmInput).rollup;

  return {
    bac: rollup.bac,
    pv: rollup.pv,
    ev: rollup.ev,
    sv: rollup.sv,
    spi: rollup.spi,
  };
}

/** Person-days from person-hours, re-exported so callers need one import. */
export { effortHoursToDays };
