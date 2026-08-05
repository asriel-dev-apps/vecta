import {
  calculateTaskEffort,
  effortForecast,
  effortHoursToDays,
  type EffortRatio,
} from "@vecta/domain";
import { datedActualsByDate } from "./dated-actuals.js";
import {
  compareTaskOrder,
  projectWorkspaceView,
  type ProjectionRole,
} from "./project-projection.js";
import { leafTaskIds, type ProjectMember, type ProjectState, type ProjectTask } from "./project-state.js";

/**
 * The EVM dashboard projection (design 0007 — Step 4). One table, two row
 * meanings: the first-level parent tasks, and the project's members. Both are
 * built from the SAME leaf metrics, so the two segments' totals are the same
 * number by construction rather than by coincidence.
 *
 * Three rules carried over from the WBS side, none of them re-decided here:
 *
 * - **Only leaves are summed.** A summary task's effort is carried by its
 *   children; adding it as well would double-count. Same rule as
 *   `calculateEffortEvm`'s rollup (ADR 0011 Decision 5), applied one level down.
 * - **Row order is the WBS order** (§2), via {@link compareTaskOrder}. This module
 *   never sorts by a metric — that would break "WBS と同じ並び順".
 * - **Effort only** (§1). Every quantity below is person-days; there is no rate
 *   and no money anywhere in this file.
 *
 * What the as-of date does and does not move, because it is easy to misread:
 * **PV is the only metric that depends on it.** PV re-reads each leaf's daily
 * plan up to that date, but EV = M × T and AC are the CURRENT stored values —
 * the data model keeps one progress figure per task, not a history — so an
 * earlier as-of date gives "the plan as of then vs the progress as of now", not a
 * historical snapshot. The screen says so next to the date input.
 */

/** The eight requested columns plus BAC and AC, which the user added on 2026-07-30. */
export interface EvmDashboardMetrics {
  /** BAC — budget at completion, person-days = Σ leaf planned effort. */
  readonly bac: number;
  /** PV — planned value at the as-of date, person-days. */
  readonly pv: number;
  /** EV — earned value, person-days. */
  readonly ev: number;
  /** AC — actual cost (expended effort), person-days. */
  readonly ac: number;
  /** SV = EV − PV, person-days. Negative is behind schedule. */
  readonly sv: number;
  /** CV = EV − AC, person-days. Negative is over budget. */
  readonly cv: number;
  /** CPI = EV / AC, `"-"` when nothing has been expended. */
  readonly cpi: EffortRatio;
  /** SPI = EV / PV, `"-"` when nothing was planned by the as-of date. */
  readonly spi: EffortRatio;
  /** EAC = BAC / CPI, person-days. */
  readonly eac: EffortRatio;
  /** ETC = EAC − AC, person-days. */
  readonly etc: EffortRatio;
}

/** One inflection of a row's cumulative planned value, for the mini S-curve. */
export interface EvmCurvePoint {
  readonly date: string;
  /** Cumulative PV up to and including `date`, person-days. */
  readonly pv: number;
}

/**
 * The same six additive metrics, in the project's currency's MINOR UNIT
 * (Design 0010). Ratios are deliberately absent: SPI and CPI are dimensionless,
 * and the money ones are on {@link EvmDashboardRow} beside their effort twins.
 *
 * Money is DERIVED and never stored: the only persisted figure is a member's
 * rate, and every amount here is `hours × rate` computed afresh. Storing an
 * amount would let it go stale the moment the effort behind it was edited, and
 * a reader could not tell which of the two was right.
 */
export interface EvmMoneyMetrics {
  readonly bac: number;
  readonly pv: number;
  readonly ev: number;
  readonly ac: number;
  readonly sv: number;
  readonly cv: number;
  readonly cpi: EffortRatio;
  readonly spi: EffortRatio;
  readonly eac: EffortRatio;
  readonly etc: EffortRatio;
}

export type EvmDashboardRowKind = "total" | "task" | "member" | "unassigned";

export interface EvmDashboardRow extends EvmDashboardMetrics {
  /** Stable React key: the task id, the member id, or {@link UNASSIGNED_ROW_KEY}. */
  readonly key: string;
  readonly kind: EvmDashboardRowKind;
  /**
   * The row's own name. Empty for the total and unassigned rows, whose captions
   * are UI text: this module stays language-free, exactly as the WBS projection
   * carries resolved master names but no prose.
   */
  readonly label: string;
  /**
   * Cumulative planned value over time (design 0007 §5 B-6). Only the dates the
   * row actually plans effort on, so the array is short; the screen positions
   * them on the projection-wide {@link EvmDashboardProjection.planStart}…`planEnd`
   * axis, which is what makes one row's curve comparable with the next one's.
   *
   * There is no matching EV curve, and cannot be: EV over time needs a progress
   * history and the model stores one current figure per task. The screen draws
   * the single EV level at the as-of date instead.
   */
  readonly curve: readonly EvmCurvePoint[];
  /**
   * The same row in money (Design 0010), or `null` when this row's leaves have
   * no rate to price them with.
   *
   * `null` rather than zeroes, because a row of zeroes reads as "this cost
   * nothing" and the truth is "nobody said what this costs". Leaves whose
   * assignee has no rate — or no assignee — are EXCLUDED from the sums above and
   * counted in {@link EvmDashboardProjection.unratedLeafCount}, the same
   * treatment Design 0009 §3.1 gave a task with an empty daily plot after a
   * silent zero was measured baking a permanent hole into the budget.
   */
  readonly money: EvmMoneyMetrics | null;
}

export interface EvmDashboardProjection {
  readonly projectId: string;
  /** The as-of date the metrics were computed at. */
  readonly statusDate: string;
  /** First/last date any leaf plans effort on — the shared sparkline axis. */
  readonly planStart: string | null;
  readonly planEnd: string | null;
  /** The whole project. Identical for both segments (every leaf lands in exactly one bucket). */
  readonly total: EvmDashboardRow;
  /** First-level parent tasks, in WBS order. */
  readonly byParentTask: readonly EvmDashboardRow[];
  /** Project members in their display order, then the unassigned row if it has anything. */
  readonly byMember: readonly EvmDashboardRow[];
  /**
   * Leaves left OUT of every money figure because no rate could be found for
   * them — no assignee, an assignee the member list does not contain, or an
   * assignee whose rate is `null` (Design 0010 §4).
   *
   * The screen shows it beside the money. Without it the amounts look complete
   * and are quietly short.
   */
  readonly unratedLeafCount: number;
  /** How many leaves the money figures DO price. Zero means there is no cost layer yet. */
  readonly ratedLeafCount: number;
}

export interface EvmDashboardOptions {
  /** As-of date (ISO). Defaults to the project's own stored status date. */
  readonly statusDate?: string;
  readonly role?: ProjectionRole;
}

/**
 * Key of the row holding leaves with no assignee — and leaves naming an assignee
 * the member list does not contain, which validation forbids but stale data could
 * still produce. Both would otherwise vanish from the per-member segment and make
 * its total disagree with the per-task one. A `\u0000` prefix cannot collide with
 * a member id. Written as an ESCAPE, not as a literal: a raw NUL makes git
 * treat the whole file as binary, so every diff-based review goes blind to it
 * (found by review, 2026-08-06 — it had already done exactly that here).
 */
export const UNASSIGNED_ROW_KEY = "\u0000unassigned";

/** Running per-bucket sums, in person-hours (the unit leaf metrics come in). */
interface Accumulator {
  bacHours: number;
  pvHours: number;
  evHours: number;
  acHours: number;
  // The money side accumulates in PARALLEL, per leaf, because the rate belongs to
  // the leaf and not to the row: multiplying a row's total hours by anything
  // would be pricing several people's work at one rate. `rated` is false until a
  // priced leaf lands here, which is what distinguishes "costs nothing" from
  // "nobody said".
  bacMinor: number;
  pvMinor: number;
  evMinor: number;
  acMinor: number;
  rated: boolean;
  /** date → planned person-minutes, for the cumulative curve. */
  readonly dailyMinutes: Map<string, number>;
}

function emptyAccumulator(): Accumulator {
  return {
    bacHours: 0,
    pvHours: 0,
    evHours: 0,
    acHours: 0,
    bacMinor: 0,
    pvMinor: 0,
    evMinor: 0,
    acMinor: 0,
    rated: false,
    dailyMinutes: new Map(),
  };
}

function ratio(numerator: number, denominator: number): EffortRatio {
  return denominator === 0 ? "-" : numerator / denominator;
}

function toCurve(dailyMinutes: ReadonlyMap<string, number>): EvmCurvePoint[] {
  const curve: EvmCurvePoint[] = [];
  let cumulativeMinutes = 0;
  for (const date of [...dailyMinutes.keys()].sort()) {
    cumulativeMinutes += dailyMinutes.get(date) ?? 0;
    curve.push({ date, pv: effortHoursToDays(cumulativeMinutes / 60) });
  }
  return curve;
}

function toRow(
  key: string,
  kind: EvmDashboardRowKind,
  label: string,
  accumulator: Accumulator,
): EvmDashboardRow {
  const bac = effortHoursToDays(accumulator.bacHours);
  const pv = effortHoursToDays(accumulator.pvHours);
  const ev = effortHoursToDays(accumulator.evHours);
  const ac = effortHoursToDays(accumulator.acHours);
  const forecast = effortForecast(bac, ev, ac);
  const moneyForecast = effortForecast(
    accumulator.bacMinor,
    accumulator.evMinor,
    accumulator.acMinor,
  );
  const money: EvmMoneyMetrics | null = accumulator.rated
    ? {
        bac: accumulator.bacMinor,
        pv: accumulator.pvMinor,
        ev: accumulator.evMinor,
        ac: accumulator.acMinor,
        sv: accumulator.evMinor - accumulator.pvMinor,
        cv: accumulator.evMinor - accumulator.acMinor,
        // NOT copied from the effort ratios. They agree only when every rate is
        // equal; when rates differ, a high-rate slip weighs more in money than in
        // hours, and that difference IS the cost layer's entire information gain.
        cpi: ratio(accumulator.evMinor, accumulator.acMinor),
        spi: ratio(accumulator.evMinor, accumulator.pvMinor),
        eac: moneyForecast.eac,
        etc: moneyForecast.etc,
      }
    : null;
  return {
    money,
    key,
    kind,
    label,
    bac,
    pv,
    ev,
    ac,
    sv: ev - pv,
    cv: ev - ac,
    cpi: ratio(ev, ac),
    spi: ratio(ev, pv),
    eac: forecast.eac,
    etc: forecast.etc,
    curve: toCurve(accumulator.dailyMinutes),
  };
}

/**
 * The first-level ancestor of every task: walk up `parentId` until it is null, or
 * until it names a task that is not in the set. That second case is the same
 * orphan rule the grid's `buildTree` uses (a child whose parent is missing is a
 * root), so a task cannot be a root on one screen and a descendant on the other.
 * Iterative with a visited set, so malformed data cannot spin here.
 */
function firstLevelAncestors(tasks: readonly ProjectTask[]): ReadonlyMap<string, string> {
  const parentById = new Map(tasks.map((task) => [task.id, task.parentId]));
  const rootById = new Map<string, string>();

  /** Record `root` for every task walked on the way to it, and return it. */
  function memoise(chain: readonly string[], root: string): string {
    for (const id of chain) rootById.set(id, root);
    return root;
  }

  function resolve(start: string): string {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current = start;
    for (;;) {
      const cached = rootById.get(current);
      if (cached !== undefined) return memoise(chain, cached);
      // A cycle: validation forbids one, but this must not hang on bad data.
      if (visited.has(current)) return memoise(chain, current);
      visited.add(current);
      chain.push(current);
      const parentId = parentById.get(current);
      if (parentId === undefined || parentId === null || !parentById.has(parentId)) {
        return memoise(chain, current);
      }
      current = parentId;
    }
  }

  for (const task of tasks) resolve(task.id);
  return rootById;
}

export function projectEvmDashboard(
  project: ProjectState,
  options: EvmDashboardOptions = {},
): EvmDashboardProjection {
  const statusDate = options.statusDate ?? project.statusDate;
  const role = options.role ?? "PRIVILEGED";
  // Same choke point as the WBS grid (ADR 0011 D18 / ⑦): member data reaches this
  // projection only through the role-scoped read model, so a privileged-only
  // member field can never be summed into a row a GENERAL viewer receives.
  const members = projectWorkspaceView(project, role).members;
  const memberIds = new Set(members.map((member) => member.id));
  const memberById = new Map(members.map((member) => [member.id, member]));

  const leaves = leafTaskIds(project.tasks);
  const rootById = firstLevelAncestors(project.tasks);

  const total = emptyAccumulator();
  const byRootId = new Map<string, Accumulator>();
  const byMemberKey = new Map<string, Accumulator>();
  let planStart: string | null = null;
  let planEnd: string | null = null;
  let unratedLeafCount = 0;
  let ratedLeafCount = 0;

  for (const task of project.tasks) {
    if (!leaves.has(task.id)) continue;
    // Built explicitly rather than passing the task through, because
    // `ProjectTask.datedActuals` is keyed by date AND member while the EVM module
    // wants dates alone (Design 0011 §3). Both are `Record<string, number>`, so
    // handing the task over would type-check and compare composite keys against
    // the status date — right often enough to look correct.
    const metrics = calculateTaskEffort(
      {
        id: task.id,
        plannedEffortMinutes: task.plannedEffortMinutes,
        progressBasisPoints: task.progressBasisPoints,
        actualEffortMinutes: task.actualEffortMinutes,
        dailyPlan: task.dailyPlan,
        datedActualsByDate: datedActualsByDate(task.datedActuals),
      },
      statusDate,
    );
    const rootId = rootById.get(task.id) ?? task.id;
    const memberKey =
      task.assigneeMemberId !== null && memberIds.has(task.assigneeMemberId)
        ? task.assigneeMemberId
        : UNASSIGNED_ROW_KEY;

    // The leaf's own rate, or `null`. Read through the ROLE-SCOPED member list, so
    // a GENERAL viewer's projection has no rate to find and every row's `money`
    // comes out `null` — the cost layer disappears at the structure level rather
    // than being hidden by the screen (ADR 0011 Decision 7).
    const assignee =
      task.assigneeMemberId === null ? undefined : memberById.get(task.assigneeMemberId);
    // `in` narrows a union to the member that HAS the key, which is how the
    // general projection's absence of it becomes a `null` rate rather than a
    // type error — the role projection is doing the work here, not a UI check.
    const rate: number | null =
      assignee !== undefined && "costRateMinorPerHour" in assignee
        ? (assignee as ProjectMember).costRateMinorPerHour
        : null;
    if (rate === null) unratedLeafCount += 1;
    else ratedLeafCount += 1;

    const buckets = [total];
    let root = byRootId.get(rootId);
    if (root === undefined) {
      root = emptyAccumulator();
      byRootId.set(rootId, root);
    }
    buckets.push(root);
    let member = byMemberKey.get(memberKey);
    if (member === undefined) {
      member = emptyAccumulator();
      byMemberKey.set(memberKey, member);
    }
    buckets.push(member);

    for (const bucket of buckets) {
      bucket.bacHours += metrics.plannedEffortHours;
      bucket.pvHours += metrics.plannedEarnedHours;
      bucket.evHours += metrics.earnedEffortHours;
      bucket.acHours += metrics.actualEffortHours;
      if (rate === null) continue;
      bucket.rated = true;
      bucket.bacMinor += metrics.plannedEffortHours * rate;
      bucket.pvMinor += metrics.plannedEarnedHours * rate;
      bucket.evMinor += metrics.earnedEffortHours * rate;
      bucket.acMinor += metrics.actualEffortHours * rate;
    }
    for (const [date, minutes] of Object.entries(task.dailyPlan)) {
      // Zero-valued plan entries exist and carry no effort; they must not widen
      // the axis or add a flat step to a curve.
      if (minutes <= 0) continue;
      for (const bucket of buckets) {
        bucket.dailyMinutes.set(date, (bucket.dailyMinutes.get(date) ?? 0) + minutes);
      }
      if (planStart === null || date < planStart) planStart = date;
      if (planEnd === null || date > planEnd) planEnd = date;
    }
  }

  const byParentTask = project.tasks
    .filter((task) => rootById.get(task.id) === task.id)
    .sort(compareTaskOrder)
    .map((task) => toRow(task.id, "task", task.name, byRootId.get(task.id) ?? emptyAccumulator()));

  const byMember: EvmDashboardRow[] = members.map((member) =>
    toRow(member.id, "member", member.name, byMemberKey.get(member.id) ?? emptyAccumulator()),
  );
  // The unassigned row is emitted only when it holds something, so a project that
  // assigns every task never sees it.
  const unassigned = byMemberKey.get(UNASSIGNED_ROW_KEY);
  if (unassigned !== undefined) {
    byMember.push(toRow(UNASSIGNED_ROW_KEY, "unassigned", "", unassigned));
  }

  return {
    projectId: project.id,
    statusDate,
    planStart,
    planEnd,
    total: toRow("__total__", "total", "", total),
    byParentTask,
    byMember,
    unratedLeafCount,
    ratedLeafCount,
  };
}
