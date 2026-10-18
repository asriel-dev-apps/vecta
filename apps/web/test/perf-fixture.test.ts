import { describe, expect, it } from "vitest";
import { EDIT } from "../perf/expected.mjs";
import { buildPerfFixture } from "../perf/fixture";
import { EDIT_COL, EDIT_ROW, STAMP_COLS, addDays } from "../perf/geometry";

function axis(dates: Iterable<string>): { first: string; last: string; count: number } {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const count = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
  return { first, last, count };
}

describe("perf fixture", () => {
  for (const cols of [45, 500] as const) {
    it(`${cols} columns: 5,000 rows, the day axis is exactly ${cols} calendar days, edit probe sums match the reviewed literals`, () => {
      const { project } = buildPerfFixture(5000, cols);
      expect(project.tasks).toHaveLength(5000);
      const dates = project.tasks.flatMap((task) => Object.keys(task.dailyPlan));
      expect(axis(dates)).toEqual({ first: "2026-01-05", last: addDays("2026-01-05", cols - 1), count: cols });

      let minutes = 0;
      for (const task of project.tasks) for (const value of Object.values(task.dailyPlan)) minutes += value;
      const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
      expect(fmt(minutes / 480)).toBe(EDIT[cols].bacBefore);
      expect(fmt((minutes + (Number(EDIT.typedHours) * 60 - 120)) / 480)).toBe(EDIT[cols].bacAfter);

      const row = project.tasks[EDIT_ROW]!;
      expect(row.parentId).not.toBeNull();
      expect(row.dailyPlan[EDIT.date]).toBe(120);
      expect(addDays("2026-01-05", EDIT_COL)).toBe(EDIT.date);
      const rowMinutes = Object.values(row.dailyPlan).reduce((sum, value) => sum + value, 0);
      expect(fmt(rowMinutes / 60)).toBe(EDIT[cols].rowHoursBefore);
    });

    it(`${cols} columns: every leaf row carries a nonzero stamp in the in-view columns`, () => {
      const { project } = buildPerfFixture(5000, cols);
      const leaves = project.tasks.filter((task) => task.parentId !== null);
      const stamped = leaves.filter((task) =>
        STAMP_COLS.some((col) => (task.dailyPlan[addDays("2026-01-05", col)] ?? 0) > 0),
      );
      // Weekend/holiday columns are not stamped; every leaf still has >= 1 working stamp column.
      expect(stamped).toHaveLength(leaves.length);
    });
  }

  it("names and No. of the rows the browser spec asserts literally", () => {
    const { project } = buildPerfFixture(5000, 45);
    expect(project.tasks[0]!.name).toBe("Phase A deliverable 1");
    expect(project.tasks[1]!.name).toBe("Subtask 1.1");
    expect(project.tasks[2501]!.name).toBe("Subtask 417.5");
    expect(project.tasks[4999]!.name).toBe("Subtask 834.1");
    expect(project.tasks[4999]!.seq).toBe(5000);
  });
});
