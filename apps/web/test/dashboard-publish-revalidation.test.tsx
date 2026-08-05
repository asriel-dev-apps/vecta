// @vitest-environment happy-dom

import { createRoutesStub, data } from "react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectState, ProjectTask } from "@vecta/application";
import ProjectDashboard from "~/routes/project.dashboard";
import { skipRevalidationOnSelfSave } from "~/routing/self-save-revalidation";

/**
 * Publishing a baseline must refresh the strip IN PLACE (Design 0009 §6).
 *
 * The reason this needs its own test rather than riding on the strip's rendering
 * tests: every other write on this app deliberately does NOT re-read after a
 * successful save (`skipRevalidationOnSelfSave` — the client already applied the
 * change optimistically). Publishing is the opposite case. Its whole visible
 * result — the version, the publication date, the four baseline metrics — is
 * computed by the SERVER from rows the client has never seen, so suppressing the
 * re-read would leave the screen saying "未凍結" about a plan that is now frozen.
 *
 * The handoff carried this as an OPEN DEFECT — "`shouldRevalidate` skips the
 * dashboard's re-read after publishing". **Measured 2026-08-06: it does not.**
 * `baseline-publish` was never in `SELF_SAVE_KINDS`, and the dashboard route
 * exports no `shouldRevalidate` of its own, so the predicate returns
 * `defaultShouldRevalidate` and the loader re-runs. The note had been reasoned
 * from the parent route's `shouldRevalidate` export rather than measured. The
 * control below is what makes that a measurement: adding `"baseline-publish"` to
 * `SELF_SAVE_KINDS` fails BOTH tests here (observed, not predicted).
 *
 * Both halves are asserted, because either alone would pass while broken:
 *
 *   * the POSITIVE — after publishing, the strip names v1 without a navigation;
 *   * the NEGATIVE PAIR — an ordinary `wbs-save` result on the same predicate
 *     still suppresses its re-read, so this is not "revalidate everything", which
 *     is the cheap way to make the positive pass and would undo ADR 0012 Step 4b.
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
  projectStart: "2026-01-05",
  statusDate: AS_OF,
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [{ id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: null }],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    makeTask({
      id: "A",
      seq: 1,
      name: "A",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 480,
      progressBasisPoints: 5_000,
      actualEffortMinutes: 300,
      dailyPlan: { "2026-01-05": 240, "2026-01-06": 240 },
    }),
  ],
  nextTaskSeq: 2,
  nextBaselineVersion: 1,
};

/** What the loader would return once the publish command has committed. */
const publishedBaseline = {
  version: 1,
  sourceRevision: "7",
  publishedAt: "2026-08-06T00:00:00.000Z",
  tasks: project.tasks.map((task) => ({
    taskId: task.id,
    parentTaskId: task.parentId,
    dailyPlan: task.dailyPlan,
    plannedEffortMinutes: task.plannedEffortMinutes,
    assigneeMemberId: task.assigneeMemberId,
    name: task.name,
    seq: task.seq,
  })),
};

afterEach(() => cleanup());

describe("EVM dashboard — publishing refreshes the strip in place", () => {
  it("names the new baseline without a reload", async () => {
    // The server's own state: `null` until the action runs, the published
    // baseline afterwards. A loader that never re-runs keeps serving the first.
    const server: { baseline: typeof publishedBaseline | null } = { baseline: null };
    let loaderCalls = 0;
    const loader = () => {
      loaderCalls += 1;
      return {
        revision: "7",
        stateView: project,
        projectionRole: "PRIVILEGED" as const,
        today: AS_OF,
        baseline: server.baseline,
        unplottedLeafCount: 0,
      };
    };
    const action = () => {
      server.baseline = publishedBaseline;
      return data({ ok: true, kind: "baseline-publish", revision: "8" });
    };

    const Stub = createRoutesStub([
      {
        path: "/projects/:id/dashboard",
        Component: ProjectDashboard,
        loader,
        action,
        shouldRevalidate: skipRevalidationOnSelfSave,
      },
    ]);
    render(<Stub initialEntries={["/projects/p1/dashboard"]} />);

    const source = await screen.findByTestId("evm-baseline-source");
    await waitFor(() => expect(loaderCalls).toBe(1));
    expect(source.textContent).toContain("現在計画");

    fireEvent.click(screen.getByTestId("evm-publish-baseline"));

    // The point of the test: the strip re-reads and changes on screen, with no
    // navigation and no reload.
    await waitFor(() =>
      expect(screen.getByTestId("evm-baseline-source").textContent).toContain("ベースライン v1"),
    );
    expect(loaderCalls).toBe(2);
    expect(screen.getByTestId("evm-baseline-metrics")).toBeTruthy();
  });

  it("CONTROL (pair): an ordinary self-save on the same predicate still skips its re-read", async () => {
    // Without this, "revalidate after every action" would satisfy the test above
    // and silently undo the no-re-settle economy every other write depends on
    // (ADR 0012 Step 4b). The predicate is shared, so it is checked here directly
    // rather than through a second screen.
    expect(
      skipRevalidationOnSelfSave({
        actionResult: { ok: true, kind: "wbs-save", revision: "8" },
        defaultShouldRevalidate: true,
      } as Parameters<typeof skipRevalidationOnSelfSave>[0]),
    ).toBe(false);
    expect(
      skipRevalidationOnSelfSave({
        actionResult: { ok: true, kind: "baseline-publish", revision: "8" },
        defaultShouldRevalidate: true,
      } as Parameters<typeof skipRevalidationOnSelfSave>[0]),
    ).toBe(true);
  });
});
