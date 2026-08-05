// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutesStub } from "react-router";
import type { ProjectState, ProjectTask } from "@vecta/application";
import ProjectDashboard from "~/routes/project.dashboard";

// Design 0007 — the EVM dashboard. These drive the REAL route Component through
// `createRoutesStub` against a fixture whose numbers are hand-checkable, so what
// is asserted is what a reader would see on screen: the row set, the ten columns,
// the segment switch, and what the as-of date does and does not move.
//
// The route's own loader is not exercised here (the stub supplies one): the read
// it performs is covered by `project-access.test.ts`, and the `today` it resolves
// by `as-of-date.test.ts`.

afterEach(() => cleanup());

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

/**
 * Phase A is a summary row over two assigned leaves; Phase B is an unassigned
 * leaf that is also a root. As of 2026-01-06 that gives Phase A
 * BAC 2.0 · PV 1.0 · EV 1.5 · AC 1.625 → CPI 0.92, SPI 1.50 — all short enough to
 * verify by hand against the cells below.
 */
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

function mount(project: ProjectState = seed): void {
  const Stub = createRoutesStub([
    {
      path: "/projects/:id/dashboard",
      Component: ProjectDashboard,
      loader: () => ({
        revision: "7",
        stateView: project,
        projectionRole: "PRIVILEGED" as const,
        today: AS_OF,
      }),
    },
  ]);
  render(<Stub initialEntries={["/projects/p1/dashboard"]} />);
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("evm-row-P1")).toBeTruthy());
}

/** The numeric cells of a row, in column order, as displayed. */
function cells(key: string): string[] {
  return within(screen.getByTestId(`evm-row-${key}`))
    .getAllByRole("cell")
    .map((cell) => cell.textContent?.trim() ?? "")
    .slice(0, 10);
}

describe("EVM dashboard — rows and columns", () => {
  it("HEADLINE: shows the first-level parents only, under a pinned project total", async () => {
    mount();
    await ready();

    // The two roots — and NOT the leaves A and B, which are the tree's second
    // level (design 0007 §4-3: no expand, no intermediate nodes).
    expect(screen.getByText("Phase A")).toBeTruthy();
    expect(screen.getByText("Phase B")).toBeTruthy();
    expect(screen.queryByTestId("evm-row-A")).toBeNull();
    expect(screen.queryByTestId("evm-row-B")).toBeNull();
    expect(screen.getByText("プロジェクト合計")).toBeTruthy();
  });

  it("renders the ten effort columns with the values the fixture implies", async () => {
    mount();
    await ready();

    // BAC · PV · EV · AC · SV · CV · CPI · SPI · EAC · ETC.
    // The parent's own 960 planned minutes are absent from every one of these:
    // if they were counted, BAC would read 4.0.
    expect(cells("P1")).toEqual([
      "2.0",
      "1.0",
      "1.5",
      "1.6",
      "▲+0.5",
      "▼-0.1",
      "0.92",
      "1.50",
      "2.2",
      "0.5",
    ]);
  });

  it("shows an em dash, never an infinity, for a row that has not started", async () => {
    mount();
    await ready();

    expect(cells("P2")).toEqual(["0.5", "0.0", "0.0", "0.0", "0.0", "0.0", "—", "—", "—", "—"]);
  });

  it("writes the unit in the header once and never in a cell", async () => {
    mount();
    await ready();

    // §5 A-3 — a unit inside a cell is what breaks the digit alignment A-1 buys.
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("人日").length).toBeGreaterThan(0);
    const body = table.querySelector("tbody");
    expect(body?.textContent).not.toContain("人日");
  });

  it("marks the sign of a variance with a symbol as well as a colour", async () => {
    mount();
    await ready();

    // §5 B-5 — colour alone disappears in black and white and for a colour-blind
    // reader; the symbol is what survives both.
    const row = within(screen.getByTestId("evm-row-P1"));
    expect(row.getByText("▲")).toBeTruthy();
    expect(row.getByText("▼")).toBeTruthy();
  });
});

describe("EVM dashboard — the segment switch", () => {
  it("HEADLINE: swaps what a row means, keeping the same table and columns", async () => {
    mount();
    await ready();

    fireEvent.click(screen.getByTestId("evm-segment-member"));

    // Members, in the members master's order, then the unassigned row.
    await waitFor(() => expect(screen.getByTestId("evm-row-member-1")).toBeTruthy());
    expect(screen.getByText("Member 01")).toBeTruthy();
    expect(screen.getByText("Member 02")).toBeTruthy();
    expect(screen.getByText("未割当")).toBeTruthy();
    // The task rows are gone — it is one table, not two stacked.
    expect(screen.queryByTestId("evm-row-P1")).toBeNull();
    // Same ten columns; the header's first cell is the only thing that renamed.
    expect(screen.getAllByRole("columnheader")).toHaveLength(12);
    expect(screen.getByRole("columnheader", { name: "メンバー" })).toBeTruthy();
  });

  it("keeps the project total identical across the two segments", async () => {
    mount();
    await ready();
    const asTasks = cells("__total__");

    fireEvent.click(screen.getByTestId("evm-segment-member"));
    await waitFor(() => expect(screen.getByTestId("evm-row-member-1")).toBeTruthy());

    // The property the unassigned row exists to protect: if it were dropped, the
    // per-member total would silently be 0.5 person-days short of this.
    expect(cells("__total__")).toEqual(asTasks);
    expect(asTasks[0]).toBe("2.5");
  });

  it("reports which segment is on, so it is not colour-only", async () => {
    mount();
    await ready();

    expect(screen.getByTestId("evm-segment-task").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("evm-segment-member").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByTestId("evm-segment-member"));

    await waitFor(() =>
      expect(screen.getByTestId("evm-segment-member").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByTestId("evm-segment-task").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("EVM dashboard — the as-of date", () => {
  it("HEADLINE: moves PV without a round trip, and leaves EV and AC alone", async () => {
    mount();
    await ready();
    expect(cells("__total__").slice(0, 4)).toEqual(["2.5", "1.0", "1.5", "1.6"]);

    fireEvent.change(screen.getByTestId("evm-as-of"), { target: { value: "2026-01-08" } });

    // PV catches up to BAC; EV and AC do not move, because the model holds one
    // current progress figure per task and no history. The screen says so.
    await waitFor(() => expect(cells("__total__")[1]).toBe("2.5"));
    expect(cells("__total__").slice(0, 4)).toEqual(["2.5", "2.5", "1.5", "1.6"]);
    expect(screen.getByText(/基準日で変わるのは PV/u)).toBeTruthy();
  });

  it("opens on the date the server resolved", async () => {
    mount();
    await ready();

    expect((screen.getByTestId("evm-as-of") as HTMLInputElement).value).toBe(AS_OF);
  });

  it("ignores a cleared date rather than blanking the table", async () => {
    mount();
    await ready();

    fireEvent.change(screen.getByTestId("evm-as-of"), { target: { value: "" } });

    expect((screen.getByTestId("evm-as-of") as HTMLInputElement).value).toBe(AS_OF);
    expect(cells("__total__")[1]).toBe("1.0");
  });
});

describe("EVM dashboard — the risk marker", () => {
  it("HEADLINE: fires on a row well under the threshold, and not on the others", async () => {
    // Both directions, because a marker that fires on every row and a marker that
    // never fires look identical from a passing test that only checks one of them.
    const risky: ProjectState = {
      ...seed,
      tasks: seed.tasks.map((task) =>
        task.id === "B" ? { ...task, actualEffortMinutes: 1_200 } : task,
      ),
    };

    mount(risky);
    await ready();

    // Phase A's CPI is now 1.5 / 3.125 = 0.48.
    expect(screen.getByTestId("evm-row-P1").className).toContain("evm-row--risk");
    // Phase B has no CPI and no SPI at all — an undefined index is not a bad one.
    expect(screen.getByTestId("evm-row-P2").className).not.toContain("evm-row--risk");
  });

  it("stays off for a row that is merely a little under 1.0", async () => {
    mount();
    await ready();

    // Phase A's CPI is 0.92 here. Marking it would mark nearly every row, which
    // is how the rows that matter get buried (§5 C-10).
    expect(screen.getByTestId("evm-row-P1").className).not.toContain("evm-row--risk");
  });
});
