import { describe, expect, it } from "vitest";
import {
  projectEvmDashboard,
  projectWorkspaceView,
  type ProjectMember,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

/**
 * The cost layer (Design 0010) — money as a DERIVED view of the same effort.
 *
 * The controls, and what each catches that the others do not:
 *
 *   * 正 1 — introducing rates moves NO effort figure. On its own this is a
 *     "nothing changed" test, which a build that computed no money at all would
 *     also pass; it means something only next to 正 2.
 *   * 正 2 — with UNEQUAL rates, SPI$ ≠ SPI and CPI$ ≠ CPI. If every rate were
 *     equal, money would be a constant multiple of effort and the ratios would
 *     agree — so this is the only test that can tell "priced per person" from
 *     "multiplied at the end", and it is the whole information gain of the layer.
 *   * 正 3 — the conservation law survives in money.
 *   * 正 4 — a leaf nobody priced is EXCLUDED and COUNTED, never summed as zero.
 *   * 負 1 — a GENERAL projection carries no rate, so every money figure is
 *     `null`. Checked at the structure level, by name, not by looking at a screen.
 */

const RICH = "a0000000-0000-4000-8000-000000000001";
const CHEAP = "a0000000-0000-4000-8000-000000000002";
const UNPRICED = "a0000000-0000-4000-8000-000000000003";

function member(id: string, name: string, rate: number | null): ProjectMember {
  return { id, name, calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: rate };
}

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
    assigneeMemberId: null,
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

function makeProject(
  members: readonly ProjectMember[],
  tasks: readonly ProjectTask[],
): ProjectState {
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
    members,
    processes: [],
    products: [],
    templates: [],
    tasks,
    nextTaskSeq: tasks.length + 1,
    nextBaselineVersion: 1,
  };
}

/**
 * Two leaves with IDENTICAL effort and different progress, one each to an
 * expensive and a cheap member. Identical effort is what makes the fixture able
 * to prove the point: any difference the money figures show comes from the rate.
 */
const rich = makeTask({
  id: "rich",
  seq: 1,
  name: "Rich",
  assigneeMemberId: RICH,
  plannedEffortMinutes: 480,
  progressBasisPoints: 2_500,
  actualEffortMinutes: 480,
  dailyPlan: { "2026-08-03": 240, "2026-08-04": 240 },
});
const cheap = makeTask({
  id: "cheap",
  seq: 2,
  name: "Cheap",
  assigneeMemberId: CHEAP,
  plannedEffortMinutes: 480,
  progressBasisPoints: 10_000,
  actualEffortMinutes: 480,
  dailyPlan: { "2026-08-03": 240, "2026-08-04": 240 },
});

const unpriced = makeProject([member(RICH, "Rich", null), member(CHEAP, "Cheap", null)], [rich, cheap]);
const priced = makeProject(
  [member(RICH, "Rich", 20_000), member(CHEAP, "Cheap", 2_000)],
  [rich, cheap],
);

const AS_OF = "2026-08-03";

describe("cost layer", () => {
  it("CONTROL 正 1: introducing rates moves no effort figure", () => {
    const before = projectEvmDashboard(unpriced, { statusDate: AS_OF }).total;
    const after = projectEvmDashboard(priced, { statusDate: AS_OF }).total;
    for (const key of ["bac", "pv", "ev", "ac", "sv", "cv", "cpi", "spi", "eac", "etc"] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
  });

  it("CONTROL 正 2: unequal rates make SPI$ and CPI$ differ from the effort ratios", () => {
    const total = projectEvmDashboard(priced, { statusDate: AS_OF }).total;
    expect(total.money).not.toBeNull();
    const money = total.money!;

    // Effort: both leaves plan 8 h, so BAC = 2 person-days; EV = 8h×0.25 + 8h×1.
    expect(total.ev).toBeCloseTo(1.25, 4);
    // Money, in minor units per person-HOUR: 8×20000×0.25 + 8×2000×1 = 56,000.
    expect(money.ev).toBeCloseTo(56_000, 2);
    // BAC$ = 8×20000 + 8×2000 = 176,000.
    expect(money.bac).toBeCloseTo(176_000, 2);
    // AC$ = 8×20000 + 8×2000 = 176,000 (both fully expended).
    expect(money.ac).toBeCloseTo(176_000, 2);

    // The point: the ratios do NOT agree, because the expensive task is the one
    // that is behind. Effort CPI = 1.25/2 = 0.625; money CPI = 56000/176000.
    expect(total.cpi).not.toBe("-");
    expect(money.cpi).not.toBe("-");
    expect(money.cpi as number).toBeCloseTo(0.3182, 4);
    expect(total.cpi as number).toBeCloseTo(0.625, 4);
    expect(money.cpi).not.toBe(total.cpi);
    expect(money.spi).not.toBe(total.spi);
  });

  it("CONTROL (pair for 正 2): with EQUAL rates the ratios do agree", () => {
    // Without this, an implementation that produced arbitrary money numbers would
    // pass the test above. Equal rates make money a constant multiple of effort,
    // so the dimensionless ratios must come out identical.
    const flat = makeProject(
      [member(RICH, "Rich", 5_000), member(CHEAP, "Cheap", 5_000)],
      [rich, cheap],
    );
    const total = projectEvmDashboard(flat, { statusDate: AS_OF }).total;
    expect(total.money!.cpi as number).toBeCloseTo(total.cpi as number, 4);
    expect(total.money!.spi as number).toBeCloseTo(total.spi as number, 4);
  });

  it("CONTROL 正 3: the conservation law holds in money too", () => {
    const projection = projectEvmDashboard(priced, { statusDate: AS_OF });
    for (const segment of [projection.byParentTask, projection.byMember]) {
      const summed = segment.reduce((sum, row) => sum + (row.money?.bac ?? 0), 0);
      expect(summed).toBeCloseTo(projection.total.money!.bac, 2);
    }
  });

  it("CONTROL 正 4: a leaf nobody priced is excluded from money and counted", () => {
    const mixed = makeProject(
      [member(RICH, "Rich", 20_000), member(UNPRICED, "Unpriced", null)],
      [rich, { ...cheap, assigneeMemberId: UNPRICED }],
    );
    const projection = projectEvmDashboard(mixed, { statusDate: AS_OF });
    expect(projection.unratedLeafCount).toBe(1);
    expect(projection.ratedLeafCount).toBe(1);
    // Only the priced leaf is in the money BAC: 8 h × 20,000. A zero-priced
    // fallback would have made this the same number and said nothing.
    expect(projection.total.money!.bac).toBeCloseTo(160_000, 2);
    // The effort BAC still counts both — money is a layer, not a filter.
    expect(projection.total.bac).toBeCloseTo(2, 4);
  });

  it("gives a row with no priced leaf a null money block, not zeroes", () => {
    const projection = projectEvmDashboard(unpriced, { statusDate: AS_OF });
    expect(projection.total.money).toBeNull();
    expect(projection.unratedLeafCount).toBe(2);
    expect(projection.ratedLeafCount).toBe(0);
  });

  it("CONTROL 負 1 (security): a GENERAL projection has no rate, so it has no money", () => {
    const projection = projectEvmDashboard(priced, { statusDate: AS_OF, role: "GENERAL" });
    expect(projection.total.money).toBeNull();
    expect(projection.ratedLeafCount).toBe(0);
    // And by NAME, at the structure level — the field must not be present at all,
    // not merely undefined (ADR 0011 Decision 7).
    const general = projectWorkspaceView(priced, "GENERAL");
    for (const scoped of general.members) {
      expect(Object.keys(scoped)).not.toContain("costRateMinorPerHour");
      expect(JSON.stringify(scoped)).not.toContain("costRateMinorPerHour");
    }
  });

  it("CONTROL (pair for 負 1): a PRIVILEGED projection does carry it", () => {
    // Without this, stripping every field from every role would pass the test
    // above and the feature would simply not exist.
    const privileged = projectWorkspaceView(priced, "PRIVILEGED");
    expect(Object.keys(privileged.members[0]!)).toContain("costRateMinorPerHour");
    expect(projectEvmDashboard(priced, { statusDate: AS_OF }).total.money).not.toBeNull();
  });
});
