// @vitest-environment happy-dom

import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { datedActualKey, projectEvmTrend, type ProjectState, type ProjectTask } from "@vecta/application";
import { EvmTrendChart } from "~/dashboard/evm-trend-chart";
import ProjectDashboard from "~/routes/project.dashboard";

/**
 * The dashboard's EVM trend (Design 0013).
 *
 * The series arithmetic is pinned in `packages/application/test/evm-trend.test.ts`;
 * what is checked here is what a chart can get wrong on screen and nowhere else:
 *
 *   * the EV line is ABSENT and the screen SAYS WHY. A missing line reads as a
 *     bug unless it is named as a limit, and the limit is real — there is no
 *     progress history to draw from.
 *   * the undated-actuals caveat appears exactly when it applies. Without it a
 *     reader subtracts the curve from the table's AC and concludes one of them is
 *     wrong.
 *   * SSR and hydration produce the same SVG. Everything in the chart is derived
 *     from props for this reason; a stray clock or locale call would show up here.
 */

const AS_OF = "2026-08-10";
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
    statusDate: AS_OF,
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

const dated = makeProject([
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

const undatedOnly = makeProject([
  makeTask({
    id: "A",
    seq: 1,
    plannedEffortMinutes: 480,
    progressBasisPoints: 5_000,
    actualEffortMinutes: 480,
    dailyPlan: { "2026-08-03": 480 },
  }),
]);

function renderDashboard(project: ProjectState): void {
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
      }),
    },
  ]);
  render(<Stub initialEntries={["/projects/p1/dashboard"]} />);
}

afterEach(() => cleanup());

describe("EVM dashboard — trend", () => {
  it("draws PV and AC as curves and EV as a single point", async () => {
    renderDashboard(dated);
    await screen.findByTestId("evm-trend-chart");
    expect(screen.getByTestId("evm-trend-pv")).toBeTruthy();
    expect(screen.getByTestId("evm-trend-ac")).toBeTruthy();
    expect(screen.getByTestId("evm-trend-ev")).toBeTruthy();
    // The EV mark is a point, not a polyline. If someone later "completes" the
    // chart by joining EV over time, this is what says no.
    expect(screen.getByTestId("evm-trend-ev").tagName.toLowerCase()).toBe("circle");
  });

  it("says on screen WHY there is no EV line", async () => {
    renderDashboard(dated);
    const trend = await screen.findByTestId("evm-trend");
    expect(trend.textContent).toContain("線になりません");
    expect(trend.textContent).toContain("履歴が無い");
  });

  it("warns about undated actuals exactly when there are some", async () => {
    renderDashboard(undatedOnly);
    const note = await screen.findByTestId("evm-trend-undated");
    expect(note.textContent).toBe("1.0");
    // Nothing dated, so there is no AC curve to draw — and the absence is
    // explained rather than left as a missing line.
    expect(screen.queryByTestId("evm-trend-ac")).toBeNull();
  });

  it("CONTROL (pair): with every actual dated, the caveat is absent", async () => {
    // Without this, a screen that ALWAYS printed the caveat would pass the test
    // above, and a caveat shown every time is one nobody reads.
    renderDashboard(dated);
    await screen.findByTestId("evm-trend");
    expect(screen.queryByTestId("evm-trend-undated")).toBeNull();
  });

  it("SSR and hydration agree on the SVG", async () => {
    // The chart is pure geometry over props for exactly this reason. A clock, a
    // locale-dependent number or a DOM measurement would diverge here.
    const trend = projectEvmTrend(dated, { statusDate: AS_OF });
    const server = renderToString(<EvmTrendChart trend={trend} />);
    renderDashboard(dated);
    await waitFor(() => expect(screen.getByTestId("evm-trend-chart")).toBeTruthy());
    const client = screen.getByTestId("evm-trend-chart").outerHTML;
    // Compare the geometry that carries the meaning: the two polylines' points.
    const points = (html: string) => [...html.matchAll(/points="([^"]+)"/gu)].map((m) => m[1]);
    expect(points(client)).toEqual(points(server));
    expect(points(server).length).toBe(2);
  });

  it("says nothing is plotted when nothing is", async () => {
    renderDashboard(makeProject([makeTask({ id: "A", seq: 1 })]));
    const empty = await screen.findByTestId("evm-trend-empty");
    expect(empty.textContent).toContain("まだありません");
  });
});
