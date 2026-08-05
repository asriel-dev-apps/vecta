import { describe, expect, it } from "vitest";
import {
  datedActualKey,
  projectEvmTrend,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

/**
 * The EVM trend series (Design 0013).
 *
 * Every control here exists because a chart is the easiest thing in the product
 * to get wrong invisibly: a swapped series, a truncated range or a fabricated
 * curve all render as a perfectly plausible picture.
 *
 *   * 正 1 — moving a task's PROGRESS moves the EV point and NOTHING else. Two
 *     series swapped for each other would pass any test that only checked that
 *     "something changed".
 *   * 正 2 — the date range and point count are golden. A range error draws a
 *     correct-looking shape over the wrong window.
 *   * 正 3 — adding a day of actuals extends the AC curve and leaves PV alone.
 *   * 負 1 — undated actuals do NOT become a flat AC line. This is the specific
 *     thing that would make the curve useless while looking finished.
 *   * 負 2 — days nobody planned are absent, not plotted at zero.
 */

const MEMBER = "a0000000-0000-4000-8000-000000000001";

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id">): ProjectTask {
  return {
    parentId: null,
    sortOrder: 0,
    seq: 1,
    name: "Task",
    processId: null,
    productId: null,
    note: "",
    contract: "",
    assigneeMemberId: MEMBER,
    plannedEffortMinutes: 0,
    progressBasisPoints: 0,
    actualEffortMinutes: 0,
    prorationWeightBp: null,
    dailyPlan: {},
    datedActuals: {},
    actualStart: null,
    actualFinish: null,
    dependencies: [],
    ...overrides,
  };
}

function makeProject(tasks: readonly ProjectTask[]): ProjectState {
  return {
    id: "project-1",
    name: "Effort WBS",
    projectStart: "2026-08-01",
    statusDate: "2026-08-31",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
    ],
    members: [{ id: MEMBER, name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 }],
    processes: [],
    products: [],
    templates: [],
    tasks,
    nextTaskSeq: tasks.length + 1,
    nextBaselineVersion: 1,
  };
}

/** One leaf: 480 min planned across two days, half of it logged on the first. */
const project = makeProject([
  makeTask({
    id: "A",
    seq: 1,
    plannedEffortMinutes: 480,
    progressBasisPoints: 5_000,
    actualEffortMinutes: 240,
    dailyPlan: { "2026-08-03": 240, "2026-08-05": 240 },
    datedActuals: { [datedActualKey("2026-08-03", MEMBER)]: 240 },
  }),
]);

describe("projectEvmTrend", () => {
  it("CONTROL 正 2: pins the start, the end and the point count", () => {
    const trend = projectEvmTrend(project, { statusDate: "2026-08-10" });
    expect(trend.start).toBe("2026-08-03");
    expect(trend.end).toBe("2026-08-05");
    expect(trend.pv.map((point) => point.date)).toEqual(["2026-08-03", "2026-08-05"]);
    // Cumulative, in person-days: 240 min = 0.5 h... = 4 h = 0.5 person-days.
    expect(trend.pv.map((point) => point.value)).toEqual([0.5, 1]);
    expect(trend.ac.map((point) => point.date)).toEqual(["2026-08-03"]);
    expect(trend.ac.map((point) => point.value)).toEqual([0.5]);
  });

  it("CONTROL 正 1: moving PROGRESS moves the EV point and neither curve", () => {
    const before = projectEvmTrend(project, { statusDate: "2026-08-10" });
    const advanced = projectEvmTrend(
      makeProject([{ ...project.tasks[0]!, progressBasisPoints: 10_000 }]),
      { statusDate: "2026-08-10" },
    );
    expect(advanced.ev).not.toBe(before.ev);
    expect(advanced.ev).toBe(1); // M = 8 h = 1 person-day, T = 1
    // The two series are byte-identical. A swapped-series bug fails right here.
    expect(advanced.pv).toEqual(before.pv);
    expect(advanced.ac).toEqual(before.ac);
  });

  it("CONTROL 正 3: a day of actuals extends AC and leaves PV alone", () => {
    const later = projectEvmTrend(
      makeProject([
        {
          ...project.tasks[0]!,
          actualEffortMinutes: 480,
          datedActuals: {
            [datedActualKey("2026-08-03", MEMBER)]: 240,
            [datedActualKey("2026-08-06", MEMBER)]: 240,
          },
        },
      ]),
      { statusDate: "2026-08-10" },
    );
    const before = projectEvmTrend(project, { statusDate: "2026-08-10" });
    expect(later.ac.map((point) => point.date)).toEqual(["2026-08-03", "2026-08-06"]);
    expect(later.ac.at(-1)?.value).toBe(1);
    expect(later.pv).toEqual(before.pv);
    // The axis grows to cover the new point — a range that ignored AC would clip it.
    expect(later.end).toBe("2026-08-06");
  });

  it("CONTROL 負 1: undated actuals stay OFF the curve and are reported separately", () => {
    // The failure this catches: adding the constant to the curve raises the whole
    // line from day one, so a month with nothing logged still shows spend and the
    // shape — the only reason to draw a curve — is gone.
    const undated = projectEvmTrend(
      makeProject([
        makeTask({
          id: "A",
          seq: 1,
          plannedEffortMinutes: 480,
          actualEffortMinutes: 480,
          dailyPlan: { "2026-08-03": 480 },
        }),
      ]),
      { statusDate: "2026-08-10" },
    );
    expect(undated.ac).toEqual([]);
    expect(undated.undatedActualDays).toBe(1);
  });

  it("CONTROL (pair for 負 1): a task WITH dated actuals contributes nothing to the constant", () => {
    // Without this, "undatedActualDays is 0 and the curve is empty" would also
    // pass — i.e. a build that lost the actuals entirely.
    const trend = projectEvmTrend(project, { statusDate: "2026-08-10" });
    expect(trend.undatedActualDays).toBe(0);
    expect(trend.ac).not.toEqual([]);
  });

  it("CONTROL 負 2: a day nobody planned is absent, not plotted at zero", () => {
    // Zero-valued plan entries are real in this model. Plotting them would put a
    // flat step on every non-working day and make weekends read as stalls.
    const withZeros = projectEvmTrend(
      makeProject([
        makeTask({
          id: "A",
          seq: 1,
          dailyPlan: { "2026-08-03": 240, "2026-08-04": 0, "2026-08-05": 240 },
        }),
      ]),
      { statusDate: "2026-08-10" },
    );
    expect(withZeros.pv.map((point) => point.date)).toEqual(["2026-08-03", "2026-08-05"]);
  });

  it("uses the BASELINE plot for PV when one exists, and says so", () => {
    const baselineTasks = [{ id: "A", dailyPlan: { "2026-08-01": 480 } }];
    const trend = projectEvmTrend(project, { statusDate: "2026-08-10", baselineTasks });
    expect(trend.pvSource).toBe("baseline");
    // The frozen plot, not the current one — the dates prove which was read.
    expect(trend.pv.map((point) => point.date)).toEqual(["2026-08-01"]);
    // And AC is unaffected by the baseline: it is a measurement, not a plan.
    expect(trend.ac.map((point) => point.date)).toEqual(["2026-08-03"]);
  });

  it("falls back to the current plan and labels it, which is production's state", () => {
    const trend = projectEvmTrend(project, { statusDate: "2026-08-10" });
    expect(trend.pvSource).toBe("current");
  });

  it("is deterministic", () => {
    expect(projectEvmTrend(project, { statusDate: "2026-08-10" })).toEqual(
      projectEvmTrend(project, { statusDate: "2026-08-10" }),
    );
  });
});
