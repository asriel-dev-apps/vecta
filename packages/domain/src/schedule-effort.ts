// Deterministic, capacity-aware effort placement (ADR 0011 Decision 4; step ④).
//
// Given each task's planned effort L (person-minutes), its assignee, its
// dependencies (FS/SS/FF/SF with working-day lag), the members' daily capacity
// and calendars, and the project calendar, this module places L greedily across
// working days in dependency-topological order and returns a sparse daily plan
// (ISO-date → person-minutes) for every task whose plan is not already fixed.
//
// Emergent duration: there is no stored duration. The window each task occupies
// emerges from L, the assignee's remaining daily capacity, and the calendar.
//
// Determinism: topological order with a (sortOrder, id) tie-break; greedy
// placement; a shared per-member/day capacity ledger. No Date.now, no
// Math.random, no argument-less new Date.
//
// The low-level working-calendar helpers are adapted from scheduling.ts and kept
// local so the proven forward/backward-pass engine is not modified.

import { ScheduleCycleError, type DependencyType } from "./scheduling.js";

/** Default assignee-less daily capacity (person-minutes) = one 8h working day. */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 480;

/** Bounds the greedy scan so a pathological calendar cannot loop forever. */
const MAX_PLACEMENT_WORKING_DAYS = 100_000;

const DAY_IN_MILLISECONDS = 86_400_000;

export interface EffortScheduleCalendarInput {
  readonly id: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface EffortScheduleMemberInput {
  readonly id: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
}

export interface EffortScheduleDependencyInput {
  readonly predecessorId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface EffortScheduleTaskInput {
  readonly id: string;
  readonly sortOrder: number;
  readonly assigneeMemberId: string | null;
  /** L — planned effort, person-minutes. */
  readonly plannedEffortMinutes: number;
  /** Existing plan; authoritative (and left untouched) when the plan is fixed. */
  readonly dailyPlan: Readonly<Record<string, number>>;
  /**
   * Whether this task's existing daily plan is a fixed fact: the scheduler does
   * not re-place it, but it still pre-charges the assignee's capacity ledger and
   * anchors dependents on its P/Q. Absent/false means the task is (re)placed. This
   * is how one-shot generation places only the new leaves while every pre-existing
   * plan stays put and still constrains the placement.
   */
  readonly fixedDailyPlan?: boolean;
  readonly dependencies: readonly EffortScheduleDependencyInput[];
  /**
   * Whether this task is a leaf — a task no other task names as its parent. Only
   * leaves are placed; a non-leaf summary row (`false`) carries no own daily plan
   * (its effort lives in its leaf children) and is emitted with an empty plan.
   * Absent means leaf, so a flat task list schedules unchanged.
   */
  readonly isLeaf?: boolean;
}

export interface EffortScheduleInput {
  readonly projectStart: string;
  readonly defaultCalendarId: string;
  readonly calendars: readonly EffortScheduleCalendarInput[];
  readonly members: readonly EffortScheduleMemberInput[];
  readonly tasks: readonly EffortScheduleTaskInput[];
  /** Capacity used for tasks with no assignee. Defaults to 480 (8h). */
  readonly defaultDailyCapacityMinutes?: number;
}

export interface EffortScheduleResult {
  /**
   * Recomputed sparse daily plan (ISO-date → minutes) per **placed** task.
   * Fixed-plan tasks are absent; their existing plan is authoritative and unchanged.
   */
  readonly dailyPlans: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

interface WorkingCalendar {
  readonly id: string;
  readonly workingWeekdays: ReadonlySet<number>;
  readonly nonWorkingDates: ReadonlySet<string>;
}

interface PlannedSpan {
  readonly start: string | null; // P — first non-zero day
  readonly finish: string | null; // Q — last non-zero day
}

interface Placement {
  readonly plan: Record<string, number>;
  readonly finish: string | null;
}

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDate(date) !== value) {
    throw new Error(`Invalid ISO calendar date: ${value}`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWorkingDay(date: Date, calendar: WorkingCalendar): boolean {
  const javascriptDay = date.getUTCDay();
  const isoWeekday = javascriptDay === 0 ? 7 : javascriptDay;
  return (
    calendar.workingWeekdays.has(isoWeekday) &&
    !calendar.nonWorkingDates.has(formatDate(date))
  );
}

function shiftCalendarDay(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * DAY_IN_MILLISECONDS);
}

function moveToWorkingDay(date: Date, direction: 1 | -1, calendar: WorkingCalendar): Date {
  let result = date;
  let guard = 0;
  while (!isWorkingDay(result, calendar)) {
    result = shiftCalendarDay(result, direction);
    if ((guard += 1) > MAX_PLACEMENT_WORKING_DAYS) {
      throw new Error(`Calendar ${calendar.id} has no working days near ${formatDate(date)}`);
    }
  }
  return result;
}

function addWorkingDays(date: Date, amount: number, calendar: WorkingCalendar): Date {
  let result = date;
  const direction: 1 | -1 = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    result = shiftCalendarDay(result, direction);
    if (isWorkingDay(result, calendar)) remaining -= 1;
  }
  return result;
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function resolveCalendars(input: EffortScheduleInput): {
  readonly byId: ReadonlyMap<string, WorkingCalendar>;
  readonly defaultCalendar: WorkingCalendar;
} {
  const calendars = input.calendars.map((calendar): WorkingCalendar => {
    const weekdays = new Set(calendar.workingWeekdays);
    if (
      weekdays.size === 0 ||
      weekdays.size !== calendar.workingWeekdays.length ||
      [...weekdays].some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
    ) {
      throw new Error(`Calendar ${calendar.id} must define unique ISO weekdays from 1 to 7`);
    }
    const nonWorkingDates = new Set(calendar.nonWorkingDates);
    for (const date of nonWorkingDates) parseDate(date);
    return { id: calendar.id, workingWeekdays: weekdays, nonWorkingDates };
  });
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  if (byId.size !== calendars.length) {
    throw new Error("Calendar IDs must be unique");
  }
  const defaultCalendar = byId.get(input.defaultCalendarId);
  if (defaultCalendar === undefined) {
    throw new Error(`The default calendar must identify a configured calendar: ${input.defaultCalendarId}`);
  }
  return { byId, defaultCalendar };
}

/**
 * Kahn topological order over the dependency edges, selecting the lowest
 * (sortOrder, id) task among those currently free — the deterministic tie-break.
 * A dependency cycle raises the shared ScheduleCycleError.
 */
function topologicalOrder(
  tasks: readonly EffortScheduleTaskInput[],
): readonly EffortScheduleTaskInput[] {
  const ranked = [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
  const rankById = new Map(ranked.map((task, index) => [task.id, index]));
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency.predecessorId)) {
        throw new Error(`Unknown predecessor: ${dependency.predecessorId}`);
      }
      const entries = successors.get(dependency.predecessorId) ?? [];
      entries.push(task.id);
      successors.set(dependency.predecessorId, entries);
    }
  }

  // Min-heap of ranks (unique integers), so the lowest (sortOrder, id) free task
  // is placed first without an O(n^2) scan.
  const heap: number[] = [];
  const push = (rank: number): void => {
    heap.push(rank);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent]! <= heap[child]!) break;
      [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
      child = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && heap[left]! < heap[smallest]!) smallest = left;
        if (right < heap.length && heap[right]! < heap[smallest]!) smallest = right;
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest]!, heap[parent]!];
        parent = smallest;
      }
    }
    return top;
  };

  for (const task of ranked) {
    if (indegree.get(task.id) === 0) push(rankById.get(task.id)!);
  }

  const ordered: EffortScheduleTaskInput[] = [];
  while (heap.length > 0) {
    const task = ranked[pop()]!;
    ordered.push(task);
    for (const successorId of successors.get(task.id) ?? []) {
      const next = (indegree.get(successorId) ?? 0) - 1;
      indegree.set(successorId, next);
      if (next === 0) push(rankById.get(successorId)!);
    }
  }

  if (ordered.length !== tasks.length) {
    const orderedIds = new Set(ordered.map((task) => task.id));
    throw new ScheduleCycleError(
      findCycleTaskIds(
        tasks,
        byId,
        new Set(tasks.filter((task) => !orderedIds.has(task.id)).map((task) => task.id)),
      ),
    );
  }
  return ordered;
}

/**
 * Tarjan SCC over the unresolved subgraph — reports only the tasks that actually
 * sit on a dependency cycle (not those merely blocked by one). Adapted from
 * scheduling.ts so the cycle-error semantics stay identical.
 */
function findCycleTaskIds(
  tasks: readonly EffortScheduleTaskInput[],
  byId: ReadonlyMap<string, EffortScheduleTaskInput>,
  unresolvedIds: ReadonlySet<string>,
): readonly string[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycleIds = new Set<string>();

  const visit = (taskId: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(taskId, index);
    lowLinks.set(taskId, index);
    stack.push(taskId);
    onStack.add(taskId);

    const task = byId.get(taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    for (const dependency of task.dependencies) {
      const predecessorId = dependency.predecessorId;
      if (!unresolvedIds.has(predecessorId)) continue;
      if (!indices.has(predecessorId)) {
        visit(predecessorId);
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId) ?? index, lowLinks.get(predecessorId) ?? index));
      } else if (onStack.has(predecessorId)) {
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId) ?? index, indices.get(predecessorId) ?? index));
      }
    }

    if (lowLinks.get(taskId) !== index) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) throw new Error("Invalid cycle detection state");
      onStack.delete(member);
      component.push(member);
    } while (member !== taskId);

    const selfReferential =
      component.length === 1 &&
      task.dependencies.some((dependency) => dependency.predecessorId === taskId);
    if (component.length > 1 || selfReferential) {
      for (const id of component) cycleIds.add(id);
    }
  };

  for (const task of tasks) {
    if (unresolvedIds.has(task.id) && !indices.has(task.id)) visit(task.id);
  }
  return tasks.filter((task) => cycleIds.has(task.id)).map((task) => task.id);
}

function spanOf(plan: Readonly<Record<string, number>>): PlannedSpan {
  let start: string | null = null;
  let finish: string | null = null;
  for (const [date, value] of Object.entries(plan)) {
    if (value > 0) {
      if (start === null || date < start) start = date;
      if (finish === null || date > finish) finish = date;
    }
  }
  return { start, finish };
}

/**
 * Greedy forward placement of `effortMinutes` from `startBound`, filling each
 * working day of `calendar` with min(remaining, dailyCapacity − already used by
 * this member that day). Pure: it reads `ledgerFor` but does not mutate it, so
 * it can be evaluated twice (for the finish-bound retry) before one is committed.
 */
function placeGreedy(
  taskId: string,
  effortMinutes: number,
  startBound: Date,
  calendar: WorkingCalendar,
  dailyCapacityMinutes: number,
  ledgerFor: (date: string) => number,
): Placement {
  const plan: Record<string, number> = {};
  let remaining = effortMinutes;
  let finish: string | null = null;
  if (remaining <= 0) return { plan, finish };

  let cursor = moveToWorkingDay(startBound, 1, calendar);
  let scanned = 0;
  while (remaining > 0) {
    const dateText = formatDate(cursor);
    const free = Math.max(0, dailyCapacityMinutes - ledgerFor(dateText));
    if (free > 0) {
      const placed = Math.min(remaining, free);
      plan[dateText] = placed;
      remaining -= placed;
      finish = dateText;
    }
    if (remaining > 0) {
      cursor = moveToWorkingDay(shiftCalendarDay(cursor, 1), 1, calendar);
      if ((scanned += 1) > MAX_PLACEMENT_WORKING_DAYS) {
        throw new Error(`Task ${taskId} cannot be placed within the working-day bound`);
      }
    }
  }
  return { plan, finish };
}

export function scheduleEffortDailyPlans(input: EffortScheduleInput): EffortScheduleResult {
  const { byId: calendarsById, defaultCalendar } = resolveCalendars(input);
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const defaultDailyCapacity = input.defaultDailyCapacityMinutes ?? DEFAULT_DAILY_CAPACITY_MINUTES;

  const taskIds = new Set(input.tasks.map((task) => task.id));
  if (taskIds.size !== input.tasks.length) {
    throw new Error("Task IDs must be unique");
  }

  const calendarForMember = (memberId: string | null): WorkingCalendar => {
    if (memberId === null) return defaultCalendar;
    const member = membersById.get(memberId);
    if (member === undefined) throw new Error(`Task references an unknown member: ${memberId}`);
    const calendar = calendarsById.get(member.calendarId);
    if (calendar === undefined) throw new Error(`Member ${memberId} references an unknown calendar: ${member.calendarId}`);
    return calendar;
  };
  const capacityForMember = (memberId: string | null): number =>
    memberId === null ? defaultDailyCapacity : membersById.get(memberId)!.dailyCapacityMinutes;

  // member id \u0000 ISO-date → person-minutes already committed that day. Shared
  // across tasks so an assignee's tasks (locked or placed) level against a
  // common daily budget. Unassigned tasks are not leveled (no shared resource).
  const ledger = new Map<string, number>();
  const ledgerKey = (memberId: string, date: string): string => `${memberId}\u0000${date}`;
  const consume = (memberId: string, plan: Readonly<Record<string, number>>): void => {
    for (const [date, minutes] of Object.entries(plan)) {
      if (minutes <= 0) continue;
      const key = ledgerKey(memberId, date);
      ledger.set(key, (ledger.get(key) ?? 0) + minutes);
    }
  };

  // Pass A — fixed-plan leaf tasks are immovable facts: record their P/Q and
  // pre-charge their assignee's ledger before any placed task is scheduled.
  // Non-leaf summary rows carry no own plan, so they neither span nor charge.
  const spanById = new Map<string, PlannedSpan>();
  for (const task of input.tasks) {
    if (task.fixedDailyPlan !== true || task.isLeaf === false) continue;
    spanById.set(task.id, spanOf(task.dailyPlan));
    if (task.assigneeMemberId !== null) consume(task.assigneeMemberId, task.dailyPlan);
  }

  // Pass B — place non-fixed leaf tasks in dependency-topological order.
  const dailyPlans = new Map<string, Record<string, number>>();
  for (const task of topologicalOrder(input.tasks)) {
    if (task.isLeaf === false) {
      // Non-leaf summary row: emit an empty plan (so its own daily plot is cleared)
      // and an empty span (so dependents never anchor on it) without charging the
      // ledger. Its effort is scheduled through its leaf children.
      spanById.set(task.id, { start: null, finish: null });
      dailyPlans.set(task.id, {});
      continue;
    }
    if (task.fixedDailyPlan === true) continue;

    const calendar = calendarForMember(task.assigneeMemberId);
    const dailyCapacity = capacityForMember(task.assigneeMemberId);

    let startBound = moveToWorkingDay(parseDate(input.projectStart), 1, calendar);
    let requiredFinish: Date | null = null;
    for (const dependency of task.dependencies) {
      const span = spanById.get(dependency.predecessorId);
      if (span === undefined) continue; // predecessor not yet spanned (should not happen)
      if (dependency.type === "FS") {
        if (span.finish === null) continue;
        startBound = laterDate(
          startBound,
          moveToWorkingDay(
            addWorkingDays(parseDate(span.finish), dependency.lagWorkingDays + 1, defaultCalendar),
            1,
            calendar,
          ),
        );
      } else if (dependency.type === "SS") {
        if (span.start === null) continue;
        startBound = laterDate(
          startBound,
          moveToWorkingDay(
            addWorkingDays(parseDate(span.start), dependency.lagWorkingDays, defaultCalendar),
            1,
            calendar,
          ),
        );
      } else {
        // FF anchors on the predecessor finish (Q); SF on its start (P). Both are
        // finish lower bounds under emergent duration. See the retry note below.
        const anchor = dependency.type === "FF" ? span.finish : span.start;
        if (anchor === null) continue;
        const bound = moveToWorkingDay(
          addWorkingDays(parseDate(anchor), dependency.lagWorkingDays, defaultCalendar),
          1,
          calendar,
        );
        requiredFinish = requiredFinish === null ? bound : laterDate(requiredFinish, bound);
      }
    }

    const memberId = task.assigneeMemberId;
    const ledgerFor = (date: string): number =>
      memberId === null ? 0 : ledger.get(ledgerKey(memberId, date)) ?? 0;

    let placement = placeGreedy(
      task.id,
      task.plannedEffortMinutes,
      startBound,
      calendar,
      dailyCapacity,
      ledgerFor,
    );
    // FF/SF finish bound: greedy forward placement yields the earliest finish. If
    // that finish is earlier than required, re-place from the required finish so
    // the last unit lands on/after it. This conservative realization (start ≥
    // requiredFinish ⇒ finish ≥ requiredFinish) is capacity-safe, deterministic,
    // and single-retry; the concurrent-overlap reading of FF/SF is deferred.
    if (
      requiredFinish !== null &&
      placement.finish !== null &&
      parseDate(placement.finish).getTime() < requiredFinish.getTime()
    ) {
      placement = placeGreedy(
        task.id,
        task.plannedEffortMinutes,
        laterDate(startBound, requiredFinish),
        calendar,
        dailyCapacity,
        ledgerFor,
      );
    }

    if (memberId !== null) consume(memberId, placement.plan);
    spanById.set(task.id, spanOf(placement.plan));
    dailyPlans.set(task.id, placement.plan);
  }

  return { dailyPlans };
}
