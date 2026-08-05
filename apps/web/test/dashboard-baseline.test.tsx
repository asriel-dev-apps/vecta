// @vitest-environment happy-dom

import { createRoutesStub } from "react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectState, ProjectTask } from "@vecta/application";
import ProjectDashboard from "~/routes/project.dashboard";

/**
 * The dashboard's baseline strip (Design 0009 §6).
 *
 * The point of the strip is that an SPI cannot be read without knowing what its PV
 * came from: "against the plan we approved" and "against the plan someone edited
 * this morning" are different claims that look identical on screen. So the source
 * is rendered in BOTH states, and both are asserted here — the unfrozen case is
 * the one production is actually in, since its project has never been baselined.
 */

const AS_OF = "2026-01-06";

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
    actualStart: null,
    actualFinish: null,
    dependencies: [],
    ...overrides,
  };
}

const seed: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: AS_OF,
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [
    { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    { id: "member-2", name: "Member 02", calendarId: "standard", dailyCapacityMinutes: 480 },
  ],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    makeTask({ id: "P1", sortOrder: 0, seq: 1, name: "Phase A", plannedEffortMinutes: 960 }),
    makeTask({
      id: "A",
      parentId: "P1",
      sortOrder: 1,
      seq: 2,
      name: "A",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 480,
      progressBasisPoints: 5_000,
      actualEffortMinutes: 300,
      dailyPlan: { "2026-01-05": 240, "2026-01-06": 240 },
    }),
    makeTask({
      id: "B",
      parentId: "P1",
      sortOrder: 2,
      seq: 3,
      name: "B",
      assigneeMemberId: "member-2",
      plannedEffortMinutes: 480,
      progressBasisPoints: 10_000,
      actualEffortMinutes: 480,
      dailyPlan: { "2026-01-07": 480 },
    }),
    makeTask({
      id: "P2",
      sortOrder: 3,
      seq: 4,
      name: "Phase B",
      plannedEffortMinutes: 240,
      dailyPlan: { "2026-01-08": 240 },
    }),
  ],
  nextTaskSeq: 5,
  nextBaselineVersion: 1,
};

const project = seed;
const leaves = project.tasks.filter(
  (task) => !project.tasks.some((other) => other.parentId === task.id),
);

function renderDashboard(loaderData: Record<string, unknown>): void {
  const Stub = createRoutesStub([
    {
      path: "/projects/:id/dashboard",
      Component: ProjectDashboard,
      loader: () => ({
        revision: "7",
        stateView: project,
        projectionRole: "PRIVILEGED" as const,
        today: AS_OF,
        baseline: null,
        unplottedLeafCount: 0,
        ...loaderData,
      }),
    },
  ]);
  render(<Stub initialEntries={["/projects/p1/dashboard"]} />);
}

const frozenFromCurrent = () => ({
  version: 1,
  sourceRevision: "7",
  publishedAt: "2026-08-05T00:00:00.000Z",
  tasks: leaves.map((task) => ({
    taskId: task.id,
    parentTaskId: task.parentId,
    dailyPlan: task.dailyPlan,
    plannedEffortMinutes: task.plannedEffortMinutes,
    assigneeMemberId: task.assigneeMemberId,
    name: task.name,
    seq: task.seq,
  })),
});

afterEach(() => cleanup());

describe("EVM dashboard — baseline strip", () => {
  it("says PV is the CURRENT plan, and warns it is not frozen, when none exists", async () => {
    renderDashboard({ baseline: null });
    const source = await screen.findByTestId("evm-baseline-source");
    expect(source.textContent).toContain("現在計画");
    expect(source.textContent).toContain("未凍結");
    // No baseline metrics at all — an empty SV next to a live one would read as
    // "zero variance", which is the opposite of "not measured".
    expect(screen.queryByTestId("evm-baseline-metrics")).toBeNull();
  });

  it("names the version and publication date once a baseline exists", async () => {
    renderDashboard({ baseline: frozenFromCurrent() });
    const source = await screen.findByTestId("evm-baseline-source");
    expect(source.textContent).toContain("ベースライン v1");
    expect(source.textContent).toContain("2026-08-05");
    expect(screen.getByTestId("evm-baseline-metrics")).toBeTruthy();
  });

  it("CONTROL: the baseline metrics are computed, not placeholders", async () => {
    // Freezing the current plan and reading it back at the same as-of date must
    // reproduce a real BAC. A strip that rendered "—" everywhere would satisfy the
    // test above and tell the reader nothing.
    renderDashboard({ baseline: frozenFromCurrent() });
    await waitFor(() => expect(screen.getByTestId("baseline-bac")).toBeTruthy());
    const bac = screen.getByTestId("baseline-bac").textContent ?? "";
    expect(bac).not.toBe("—");
    expect(Number(bac.replace(/[^\d.-]/gu, ""))).toBeGreaterThan(0);
  });

  it("shows the unplotted-leaf COUNT before offering the checkbox that waives it", async () => {
    // The gate is only meaningful if the number was in front of the person who
    // ticked the box. A checkbox with nothing beside it is a formality.
    renderDashboard({ baseline: null, unplottedLeafCount: 3 });
    const notice = await screen.findByTestId("evm-unplotted-count");
    expect(notice.textContent).toContain("3");
    expect(screen.getByTestId("evm-acknowledge-unplotted")).toBeTruthy();
  });

  it("CONTROL (pair): with nothing unplotted there is no checkbox to tick", async () => {
    // Without this, a strip that ALWAYS showed the waiver would pass the test
    // above — and a waiver shown every time is one nobody reads.
    renderDashboard({ baseline: null, unplottedLeafCount: 0 });
    await screen.findByTestId("evm-publish-baseline");
    expect(screen.queryByTestId("evm-acknowledge-unplotted")).toBeNull();
    expect(screen.queryByTestId("evm-unplotted-count")).toBeNull();
  });
});
