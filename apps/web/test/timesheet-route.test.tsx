// @vitest-environment happy-dom

import { createRoutesStub, data } from "react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectState, ProjectTask } from "@vecta/application";
import { TimesheetImport } from "~/timesheet/timesheet-import";

/**
 * The timesheet import screen (Design 0011 §6.2).
 *
 * What is worth checking here, as opposed to in the importer's own tests:
 *
 *   * **The import button cannot be reached without a preview.** The import
 *     REPLACES whole `(date, member)` partitions, so it deletes rows the file
 *     never mentions; the partition count is the only place that blast radius is
 *     visible, and a button that skips it is a button pressed blind.
 *   * **Every rejected line is shown**, not the first. A screen that rendered
 *     `issues[0]` would pass a test that only asserted "an error appears".
 *   * **A VIEWER cannot start one.** The server 403s the write regardless; the
 *     disabled control says so before the click rather than after it.
 */

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

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-08-01",
  statusDate: "2026-08-31",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [{ id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: null }],
  processes: [],
  products: [],
  templates: [],
  tasks: [makeTask({ id: "A", seq: 1, name: "A" })],
  nextTaskSeq: 2,
  nextBaselineVersion: 1,
};

const SUMMARY = {
  rowCount: 3,
  firstDate: "2026-08-03",
  lastDate: "2026-08-05",
  memberCount: 1,
  taskCount: 2,
  partitionCount: 2,
};

function renderScreen(
  action: (args: { request: Request }) => unknown,
  props: Partial<Parameters<typeof TimesheetImport>[0]> = {},
): void {
  const Stub = createRoutesStub([
    {
      path: "/projects/:id/timesheet",
      Component: () => (
        <TimesheetImport
          project={project}
          revision="7"
          templateHeader="タスクNo,日付,メンバー,工数(時間)"
          leafCount={1}
          datedLeafCount={0}
          editable
          {...props}
        />
      ),
      action,
    },
  ]);
  render(<Stub initialEntries={["/projects/p1/timesheet"]} />);
}

/** happy-dom's `File.text()` works; this just makes the intent obvious. */
function chooseFile(text: string): void {
  const input = screen.getByTestId("timesheet-file") as HTMLInputElement;
  const file = new File([text], "timesheet.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

afterEach(() => cleanup());

describe("timesheet import screen", () => {
  it("will not import until a preview of THIS file has come back", async () => {
    const intents: string[] = [];
    const action = async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { intent: string };
      intents.push(body.intent);
      return data({ ok: true, kind: "timesheet-preview", summary: SUMMARY });
    };
    renderScreen(action);

    // Nothing chosen: neither button does anything.
    expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(true);

    chooseFile("タスクNo,日付,メンバー,工数(時間)\n1,2026-08-03,Member 01,2\n");
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(false),
    );
    // Still shut — a file is not a preview.
    expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("timesheet-preview"));
    await waitFor(() => expect(screen.getByTestId("timesheet-summary")).toBeTruthy());
    // The number that justifies the gate is on screen BEFORE the button opens.
    expect(screen.getByTestId("timesheet-partition-count").textContent).toBe("2");
    expect(screen.getByTestId("timesheet-row-count").textContent).toBe("3");
    expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(false);
    expect(intents).toEqual(["preview"]);
  });

  it("posts the same CSV text for the import as for the preview", async () => {
    const posted: { intent: string; csv: string }[] = [];
    const csv = "タスクNo,日付,メンバー,工数(時間)\n1,2026-08-03,Member 01,2\n";
    const action = async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { intent: string; csv: string };
      posted.push({ intent: body.intent, csv: body.csv });
      return body.intent === "preview"
        ? data({ ok: true, kind: "timesheet-preview", summary: SUMMARY })
        : data({ ok: true, kind: "timesheet-import", revision: "8", summary: SUMMARY });
    };
    renderScreen(action);

    chooseFile(csv);
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("timesheet-preview"));
    await waitFor(() => expect(screen.getByTestId("timesheet-summary")).toBeTruthy());
    fireEvent.click(screen.getByTestId("timesheet-import"));
    await waitFor(() => expect(screen.getByTestId("timesheet-done")).toBeTruthy());

    expect(posted.map((entry) => entry.intent)).toEqual(["preview", "import"]);
    // The bytes the person approved are the bytes that were applied.
    expect(posted[0]?.csv).toBe(posted[1]?.csv);
    expect(screen.getByTestId("timesheet-done").textContent).toContain("3 行");
  });

  it("REVIEW 2026-08-06: choosing a second file closes the import button again", async () => {
    // Found by review. Clearing the file text was not enough — `fetcher.data`
    // outlived it, so the first file's preview kept the button open and the
    // SECOND file would have been imported with nobody having seen what it
    // deletes. That is the exact failure the gate exists to prevent.
    const posted: { intent: string; csv: string }[] = [];
    const action = async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { intent: string; csv: string };
      posted.push({ intent: body.intent, csv: body.csv });
      return data({ ok: true, kind: "timesheet-preview", summary: SUMMARY });
    };
    renderScreen(action);

    const first = "タスクNo,日付,メンバー,工数(時間)\n1,2026-08-03,Member 01,2\n";
    chooseFile(first);
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("timesheet-preview"));
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(false),
    );

    // A different file, chosen without previewing it.
    chooseFile("タスクNo,日付,メンバー,工数(時間)\n1,2026-09-09,Member 01,7\n");
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(true),
    );
    // The old summary must not be presented as this file's, either.
    expect(screen.queryByTestId("timesheet-summary")).toBeNull();
    expect(posted).toHaveLength(1);
  });

  it("lists EVERY rejected line with its number, not just the first", async () => {
    const action = () =>
      data(
        {
          ok: false,
          code: "INVALID",
          issues: [
            { line: 2, message: "タスクNo「99」はこのプロジェクトにありません" },
            { line: 4, message: "メンバー「Member 99」はこのプロジェクトにいません" },
            { line: 7, message: "同じ 日付 × メンバー × タスクNo の行が重複しています" },
          ],
        },
        { status: 422 },
      );
    renderScreen(action);

    chooseFile("タスクNo,日付,メンバー,工数(時間)\n99,2026-08-03,Member 01,2\n");
    await waitFor(() =>
      expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("timesheet-preview"));

    const issues = await screen.findByTestId("timesheet-issues");
    for (const line of ["2 行目", "4 行目", "7 行目"]) {
      expect(issues.textContent).toContain(line);
    }
    // And it says plainly that nothing was written — the whole point of
    // abandoning the file rather than importing the good rows.
    expect(issues.textContent).toContain("1 行も書き込んでいません");
    // A rejected preview must not open the import button.
    expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says how much of AC actually carries a date", async () => {
    // Without this the as-of date on the dashboard looks more meaningful than it
    // is: un-imported tasks contribute a constant to AC(t) at every date.
    renderScreen(() => data({ ok: true }), { leafCount: 4, datedLeafCount: 1 });
    const coverage = await screen.findByTestId("timesheet-coverage");
    expect(coverage.textContent).toContain("1");
    expect(coverage.textContent).toContain("4");
    expect(coverage.textContent).toContain("基準日を動かしても AC は動きません");
  });

  it("CONTROL: a VIEWER cannot start an import", async () => {
    renderScreen(() => data({ ok: true }), { editable: false });
    await screen.findByTestId("timesheet-screen");
    expect((screen.getByTestId("timesheet-file") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("timesheet-preview") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("timesheet-import") as HTMLButtonElement).disabled).toBe(true);
  });
});
