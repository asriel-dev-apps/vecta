import type { ProjectState, ProjectTask } from "@vecta/application";
import { createDemoProject } from "../test/fixtures/demo-project";
import {
  AXIS_START,
  DAILY_COL_W,
  EDIT_COL,
  EDIT_MINUTES_BEFORE,
  EDIT_ROW,
  H_TOP,
  META_WIDTH,
  PINNED_WIDTH,
  ROW_H,
  STAMP_COLS,
  V_STEP,
  H_STEP,
  addDays,
} from "./geometry";

// Synthetic ProjectState for the perf harness: the demo project rebased into a
// window of exactly `cols` calendar days, plus sentinel stamps. A stamp is a fixed
// (row, day column, minutes) triple that guarantees every probed window contains a
// nonzero cell, whatever the seeded plans look like.

export const FIXTURE_ID = "vecta-perf-v1";
const SUBTASKS_PER_PARENT = 5;
const MEMBER_COUNT = 8;
const HOLIDAYS = new Set(["2026-01-07", "2026-01-08"]);

export interface PerfFixture {
  readonly project: ProjectState;
  readonly rows: number;
  readonly cols: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly leafIndexes: readonly number[];
}

function workingDays(cols: number): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < cols; offset += 1) {
    const date = addDays(AXIS_START, offset);
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(date)) out.push(date);
  }
  return out;
}

function compress(tasks: readonly ProjectTask[], working: readonly string[]): ProjectTask[] {
  return tasks.map((task, index) => {
    const entries = Object.entries(task.dailyPlan);
    if (entries.length === 0) return task;
    const span = entries.length;
    const room = Math.max(0, working.length - span);
    const start = room === 0 ? 0 : (index * 17) % (room + 1);
    const dailyPlan: Record<string, number> = {};
    for (let offset = 0; offset < span; offset += 1) {
      const date = working[Math.min(working.length - 1, start + offset)]!;
      dailyPlan[date] = (dailyPlan[date] ?? 0) + entries[offset]![1];
    }
    return { ...task, dailyPlan };
  });
}

function trim(tasks: readonly ProjectTask[], rows: number): ProjectTask[] {
  if (tasks.length < rows) throw new Error(`fixture produced ${tasks.length} tasks, wanted ${rows}`);
  if (tasks.length === rows) return [...tasks];
  const parents = tasks.filter((task) => task.parentId === null);
  const lastParent = parents[parents.length - 1]!;
  const children = tasks.filter((task) => task.parentId === lastParent.id);
  const extra = tasks.length - rows;
  if (extra > children.length) throw new Error("cannot trim enough from the last parent");
  const drop = new Set(children.slice(children.length - extra).map((task) => task.id));
  return tasks.filter((task) => !drop.has(task.id));
}

/** Minutes stamped at (leaf, day column). Deterministic, always 1..8 hours. */
export function stampMinutes(leafOrdinal: number, col: number): number {
  return 60 * (1 + ((leafOrdinal * 3 + col) % 8));
}

function bounceCol(value: number, max: number): number {
  if (max <= 0) return 0;
  const period = max * 2;
  const wrapped = value % period;
  return wrapped <= max ? wrapped : period - wrapped;
}

export function buildPerfFixture(rows: number, cols: number): PerfFixture {
  const group = SUBTASKS_PER_PARENT + 1;
  const parentCount = Math.floor(rows / group);
  const remainder = rows - parentCount * group;
  const seeded = createDemoProject({
    parentCount: remainder === 0 ? parentCount : parentCount + 1,
    subtasksPerParent: SUBTASKS_PER_PARENT,
    memberCount: MEMBER_COUNT,
    seed: 0x5eed,
  });
  const working = workingDays(cols);
  const firstDate = AXIS_START;
  const lastDate = addDays(AXIS_START, cols - 1);
  if (working[0] !== firstDate || working[working.length - 1] !== lastDate) {
    throw new Error(`cols=${cols} does not start and end on a working day`);
  }
  const tasks = compress(trim(seeded.tasks, rows), working);
  const isLeaf = (task: ProjectTask) => task.parentId !== null;
  const leafIndexes = tasks.flatMap((task, index) => (isLeaf(task) ? [index] : []));
  const plans = tasks.map((task) => ({ ...task.dailyPlan }));

  // Axis endpoints: the first leaf owns the first working day, the last leaf the last one.
  const first = leafIndexes[0]!;
  const last = leafIndexes[leafIndexes.length - 1]!;
  plans[first]![firstDate] = plans[first]![firstDate] ?? 60;
  plans[last]![lastDate] = plans[last]![lastDate] ?? 60;

  const leafSet = new Set(leafIndexes);
  const ordinalOf = new Map(leafIndexes.map((index, ordinal) => [index, ordinal]));
  const stampFast = (rowIndex: number, col: number): void => {
    const date = addDays(AXIS_START, col);
    if (col < 0 || col >= cols || !working.includes(date) || !leafSet.has(rowIndex)) return;
    plans[rowIndex]![date] = stampMinutes(ordinalOf.get(rowIndex)!, col);
  };

  // V sweeps: every leaf row has values in the day columns that sit in view.
  for (const index of leafIndexes) for (const col of STAMP_COLS) stampFast(index, col);
  // H sweeps: three leaf rows around row 2,400 have a value in every working column.
  const hRow = Math.floor(H_TOP / ROW_H);
  const hLeaves = leafIndexes.filter((index) => index >= hRow && index < hRow + 14).slice(0, 3);
  for (const index of hLeaves) for (let col = 0; col < cols; col += 1) stampFast(index, col);
  // D sweep: leaf rows of step k carry values in the columns of that step's window.
  const maxLeftEstimate = Math.max(0, META_WIDTH + cols * DAILY_COL_W - 1440);
  const rowsPerStep = V_STEP / ROW_H;
  for (const index of leafIndexes) {
    const k = Math.floor(index / rowsPerStep);
    const left = bounceCol(k * H_STEP, maxLeftEstimate);
    const center = Math.round((left + PINNED_WIDTH + 450 - META_WIDTH) / DAILY_COL_W);
    for (let delta = -2; delta <= 2; delta += 1) stampFast(index, center + delta);
  }
  // Edit probe cell: an editable working day with a known value.
  if (leafSet.has(EDIT_ROW)) plans[EDIT_ROW]![addDays(AXIS_START, EDIT_COL)] = EDIT_MINUTES_BEFORE;

  const stamped = tasks.map((task, index) => {
    if (!isLeaf(task)) return task;
    const dailyPlan = plans[index]!;
    const total = Object.values(dailyPlan).reduce((sum, minutes) => sum + minutes, 0);
    return { ...task, dailyPlan, plannedEffortMinutes: total };
  });
  return {
    project: {
      ...seeded,
      name: `Perf ${rows}x${cols}`,
      projectStart: AXIS_START,
      statusDate: working[Math.floor(working.length / 2)]!,
      tasks: stamped,
    },
    rows,
    cols,
    firstDate,
    lastDate,
    leafIndexes,
  };
}
