// @vitest-environment happy-dom

import { createRoutesStub } from "react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectWorkspaceView,
  type ProjectMember,
  type ProjectState,
  type ProjectTask,
} from "@vecta/application";
import ProjectDashboard from "~/routes/project.dashboard";

/**
 * The cost layer on screen (Design 0010 §6).
 *
 * The arithmetic is pinned in `packages/application/test/cost-layer.test.ts`.
 * What only the screen can get wrong:
 *
 *   * the toggle exists at all when there is money to show, and NOT when there
 *     is none — a control that switches to a table of em dashes is worse than no
 *     control;
 *   * a GENERAL viewer never sees it, because the rate never reached them. The
 *     assertion is that the SERIALISED loader payload does not contain the field
 *     name, not that a button is hidden: ADR 0011 Decision 7 is about the API
 *     boundary, and a hidden button is exactly the thing it rules out;
 *   * the columns do NOT change. The reference spreadsheet has no money column,
 *     and Design 0003 §B-1 is the record of what happens when one is invented.
 */

const AS_OF = "2026-08-03";
const RICH = "a0000000-0000-4000-8000-000000000001";
const POOR = "a0000000-0000-4000-8000-000000000002";

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

function makeProject(members: readonly ProjectMember[]): ProjectState {
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
    members,
    processes: [],
    products: [],
    templates: [],
    tasks: [
      makeTask({
        id: "A",
        seq: 1,
        name: "A",
        assigneeMemberId: RICH,
        plannedEffortMinutes: 480,
        progressBasisPoints: 5_000,
        actualEffortMinutes: 480,
        dailyPlan: { "2026-08-03": 480 },
      }),
      makeTask({
        id: "B",
        seq: 2,
        name: "B",
        assigneeMemberId: POOR,
        plannedEffortMinutes: 480,
        progressBasisPoints: 5_000,
        actualEffortMinutes: 480,
        dailyPlan: { "2026-08-03": 480 },
      }),
    ],
    nextTaskSeq: 3,
    nextBaselineVersion: 1,
  };
}

const priced = makeProject([member(RICH, "Rich", 20_000), member(POOR, "Poor", 2_000)]);
const partlyPriced = makeProject([member(RICH, "Rich", 20_000), member(POOR, "Poor", null)]);
const unpriced = makeProject([member(RICH, "Rich", null), member(POOR, "Poor", null)]);

function renderDashboard(project: ProjectState, role: "PRIVILEGED" | "GENERAL" = "PRIVILEGED") {
  const payload = {
    revision: "7",
    // The SAME projection the loader applies, so what this test renders is what
    // the role would actually receive.
    stateView: projectWorkspaceView(project, role) as ProjectState,
    projectionRole: role,
    today: AS_OF,
    baseline: null,
    unplottedLeafCount: 0,
  };
  const Stub = createRoutesStub([
    { path: "/projects/:id/dashboard", Component: ProjectDashboard, loader: () => payload },
  ]);
  render(<Stub initialEntries={["/projects/p1/dashboard"]} />);
  return payload;
}

afterEach(() => cleanup());

describe("EVM dashboard — cost layer", () => {
  it("offers the unit toggle when there is money to show, and switches the table", async () => {
    renderDashboard(priced);
    await screen.findByTestId("evm-unit-money");
    const total = () => screen.getByTestId("evm-row-__total__").textContent ?? "";
    // Effort first: one person-day planned each, so BAC = 2.0.
    expect(total()).toContain("2.0");

    fireEvent.click(screen.getByTestId("evm-unit-money"));
    // Money: 8 h × 20,000 + 8 h × 2,000 = 176,000, grouped.
    expect(total()).toContain("176,000");
    expect(screen.getByTestId("evm-money-note")).toBeTruthy();
  });

  it("CONTROL (pair): with nothing priced there is no toggle to press", async () => {
    // A toggle that switches to a table of em dashes is worse than no toggle.
    renderDashboard(unpriced);
    await screen.findByTestId("evm-row-__total__");
    expect(screen.queryByTestId("evm-unit-money")).toBeNull();
    expect(screen.queryByTestId("evm-unit-days")).toBeNull();
  });

  it("names how many leaves the money leaves out", async () => {
    renderDashboard(partlyPriced);
    fireEvent.click(await screen.findByTestId("evm-unit-money"));
    expect(screen.getByTestId("evm-unrated-count").textContent).toBe("1");
    // And the amount is the priced leaf ONLY — a zero fallback would have made
    // this the same number and said nothing.
    expect(screen.getByTestId("evm-row-__total__").textContent).toContain("160,000");
  });

  it("CONTROL (security): a GENERAL payload does not carry the rate, by name", async () => {
    const payload = renderDashboard(priced, "GENERAL");
    await screen.findByTestId("evm-row-__total__");
    // The boundary claim, checked where the boundary is: in what was serialised.
    expect(JSON.stringify(payload)).not.toContain("costRateMinorPerHour");
    expect(JSON.stringify(payload)).not.toContain("20000");
    // And with no rate in the payload there is nothing to toggle to.
    expect(screen.queryByTestId("evm-unit-money")).toBeNull();
  });

  it("CONTROL (pair): the PRIVILEGED payload does carry it", async () => {
    // Without this, stripping the field from every role would pass the test above
    // and the cost layer would simply not exist.
    const payload = renderDashboard(priced);
    await screen.findByTestId("evm-unit-money");
    expect(JSON.stringify(payload)).toContain("costRateMinorPerHour");
  });

  it("offers the change segment, and merges same-named parents into one row", async () => {
    // ADR 0011 Decision 8 + the user's 2026-08-06 answer: the spreadsheet's
    // change rollup merges same-named rows. With distinct names this segment is
    // identical to 親タスク別, so the fixture gives two roots the same name and
    // the row count is what proves the merge happened on screen.
    const twoNamed: ProjectState = {
      ...priced,
      tasks: [
        makeTask({ id: "p1", seq: 10, sortOrder: 10, name: "変更A" }),
        { ...priced.tasks[0]!, parentId: "p1" },
        makeTask({ id: "p2", seq: 11, sortOrder: 11, name: "変更A" }),
        { ...priced.tasks[1]!, parentId: "p2" },
      ],
    };
    renderDashboard(twoNamed);
    fireEvent.click(await screen.findByTestId("evm-segment-task"));
    const parents = screen.getAllByTestId(/^evm-row-/u).length;
    fireEvent.click(screen.getByTestId("evm-segment-change"));
    const changes = screen.getAllByTestId(/^evm-row-/u).length;
    // One fewer row: the two "変更A" parents became one change.
    expect(changes).toBe(parents - 1);
  });

  it("does not add a column — the unit changes, the table does not", async () => {
    renderDashboard(priced);
    await screen.findByTestId("evm-unit-money");
    const before = screen.getByTestId("evm-row-__total__").querySelectorAll("td,th").length;
    fireEvent.click(screen.getByTestId("evm-unit-money"));
    const after = screen.getByTestId("evm-row-__total__").querySelectorAll("td,th").length;
    expect(after).toBe(before);
  });
});
