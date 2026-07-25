// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutesStub, data } from "react-router";
import type { ProjectCommand, ProjectState } from "@vecta/application";
import ProjectMembers, { shouldRevalidate } from "~/routes/project.members";
import { toCommand } from "~/wbs/project-command-contract";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4c-1 — the `/projects/:id/members` route hosts ONLY the existing
// MemberList (name / 稼働カレンダー / 日次キャパシティ). These drive the real route
// Component through `createRoutesStub` and pin the panel's fields, the capacity
// hours×60 unit + 1..1440 clamp, and the shared optimistic pipeline. A PRIVILEGED
// loader is used so capacity is present (the D18 stripped-view case is pinned in
// load-project-view.test.ts).

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });
const empty: ProjectState = createDemoProject({ parentCount: 0, subtasksPerParent: 0, memberCount: 0 });

type ActionMode = "accept" | "conflict" | "forbid";

interface FakeServer {
  revision: string;
  state: ProjectState;
  loaderCalls: number;
  expectedRevisions: string[];
  commands: ProjectCommand[];
  mode: ActionMode;
  conflictState: ProjectState;
  conflictRevision: string;
}

function mount(initial: ProjectState, mode: ActionMode = "accept") {
  const server: FakeServer = {
    revision: "7",
    state: initial,
    loaderCalls: 0,
    expectedRevisions: [],
    commands: [],
    mode,
    conflictState: initial,
    conflictRevision: "9",
  };
  const loader = () => {
    server.loaderCalls += 1;
    return { revision: server.revision, stateView: server.state, projectionRole: "PRIVILEGED" as const };
  };
  const action = async ({ request }: { request: Request }) => {
    const body = (await request.json()) as {
      expectedRevision: string;
      commands: { command: unknown }[];
    };
    server.expectedRevisions.push(body.expectedRevision);
    for (const entry of body.commands) server.commands.push(toCommand(entry.command as never));
    if (server.mode === "conflict") {
      server.revision = server.conflictRevision;
      server.state = server.conflictState;
      return data(
        { ok: false, code: "VERSION_CONFLICT", actualRevision: server.conflictRevision },
        { status: 409 },
      );
    }
    if (server.mode === "forbid") {
      return data({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }
    server.revision = String(Number(server.revision) + 1);
    return data({ ok: true, kind: "members-save", revision: server.revision });
  };
  const Stub = createRoutesStub([
    { path: "/projects/:id/members", Component: ProjectMembers, loader, action, shouldRevalidate },
  ]);
  render(<Stub initialEntries={["/projects/p1/members"]} />);
  return server;
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("master-section-member")).toBeTruthy());
}

describe("ProjectMembers — the MemberList panel", () => {
  it("renders the member rows, calendar, and 8h capacity from the loaded project", async () => {
    mount(seed);
    await ready();
    expect(screen.getByDisplayValue("Member 01")).toBeTruthy();
    expect(screen.getByDisplayValue("Member 02")).toBeTruthy();
    // Capacity shows hours: 480 minutes / 60 = 8.
    expect(screen.getAllByLabelText("日次キャパシティ(時間)")[0]).toHaveProperty("value", "8");
    expect(screen.getAllByLabelText("稼働カレンダー").length).toBe(seed.members.length);
    expect(screen.getByText("マスタ管理 · メンバー")).toBeTruthy();
    // The members route hosts neither 工程/プロダクト nor the template panel.
    expect(screen.queryByTestId("master-section-工程")).toBeNull();
    expect(screen.queryByTestId("master-section-template")).toBeNull();
  });

  it("shows the （未登録） empty state with no members", async () => {
    mount(empty);
    await ready();
    expect(screen.getByText("（未登録）")).toBeTruthy();
  });

  it("dispatches member.add with the default calendar and 480-minute capacity", async () => {
    const server = mount(seed);
    await ready();
    fireEvent.change(screen.getByLabelText("メンバーを追加"), { target: { value: "Member 99" } });
    fireEvent.click(screen.getByTestId("master-add-member"));

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "member.add") throw new Error(`expected member.add, got ${command.type}`);
    expect(command.member.name).toBe("Member 99");
    expect(command.member.calendarId).toBe(seed.defaultCalendarId);
    expect(command.member.dailyCapacityMinutes).toBe(480);
  });

  it("dispatches member.update on rename", async () => {
    const server = mount(seed);
    await ready();
    const input = screen.getByDisplayValue("Member 01") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed member" } });
    fireEvent.blur(input);

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "member.update") throw new Error(`expected member.update, got ${command.type}`);
    expect(command.changes).toEqual({ name: "Renamed member" });
  });

  it("dispatches member.update with dailyCapacityMinutes = hours × 60", async () => {
    const server = mount(seed);
    await ready();
    const capacity = screen.getAllByLabelText("日次キャパシティ(時間)")[0] as HTMLInputElement;
    fireEvent.change(capacity, { target: { value: "10" } });
    fireEvent.blur(capacity);

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "member.update") throw new Error(`expected member.update, got ${command.type}`);
    expect(command.changes).toEqual({ dailyCapacityMinutes: 600 });
  });

  it("reverts an out-of-range capacity (0 and >1440) without dispatching", async () => {
    const server = mount(seed);
    await ready();
    const capacity = screen.getAllByLabelText("日次キャパシティ(時間)")[0] as HTMLInputElement;

    // 0 hours → 0 minutes (< 1) → revert to the current 8h, no command.
    fireEvent.change(capacity, { target: { value: "0" } });
    fireEvent.blur(capacity);
    expect(capacity.value).toBe("8");

    // 30 hours → 1800 minutes (> 1440) → revert, no command.
    fireEvent.change(capacity, { target: { value: "30" } });
    fireEvent.blur(capacity);
    expect(capacity.value).toBe("8");

    // Neither out-of-range edit reached the server.
    expect(server.commands.length).toBe(0);
  });

  it("dispatches member.update on a calendar change", async () => {
    // Add a second calendar so there is a distinct target to switch to.
    const withCalendars: ProjectState = {
      ...seed,
      calendars: [
        ...seed.calendars,
        { id: "cal-alt", name: "Alt calendar", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
      ],
    };
    const server = mount(withCalendars);
    await ready();
    const select = screen.getAllByLabelText("稼働カレンダー")[0]!;
    fireEvent.change(select, { target: { value: "cal-alt" } });

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "member.update") throw new Error(`expected member.update, got ${command.type}`);
    expect(command.changes).toEqual({ calendarId: "cal-alt" });
  });

  it("dispatches member.delete for an unassigned member", async () => {
    // The demo's members are all task assignees (member.delete of an assignee is
    // rejected by the domain), so delete a spare member with no task references.
    const spare = { id: "d0000000-0000-4000-8000-00000000dead", name: "Spare member", calendarId: "standard", dailyCapacityMinutes: 480 };
    const withSpare: ProjectState = { ...seed, members: [...seed.members, spare] };
    const server = mount(withSpare);
    await ready();
    fireEvent.click(screen.getByLabelText("Spare member を削除"));

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "member.delete") throw new Error(`expected member.delete, got ${command.type}`);
    expect(command.memberId).toBe(spare.id);
  });

  it("on success advances the confirmed revision with NO loader re-run", async () => {
    const server = mount(seed);
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("メンバーを追加"), { target: { value: "Member 99" } });
    fireEvent.click(screen.getByTestId("master-add-member"));
    await waitFor(() => expect(server.commands.length).toBe(1));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(server.loaderCalls).toBe(1);
    expect(server.expectedRevisions[0]).toBe("7");
    // Optimistic member persists (no re-settle).
    expect(screen.getByDisplayValue("Member 99")).toBeTruthy();
  });

  it("rolls back the optimistic member and shows a notice when denied", async () => {
    mount(seed, "forbid");
    await ready();
    fireEvent.change(screen.getByLabelText("メンバーを追加"), { target: { value: "Member 99" } });
    fireEvent.click(screen.getByTestId("master-add-member"));

    await waitFor(() => expect(screen.getByDisplayValue("Member 99")).toBeTruthy());
    await waitFor(() => expect(screen.queryByDisplayValue("Member 99")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("adopts fresh loader state on VERSION_CONFLICT", async () => {
    const server = mount(seed, "conflict");
    server.conflictState = {
      ...seed,
      members: [
        ...seed.members,
        { id: "d0000000-0000-4000-8000-0000000000ff", name: "Server-added member", calendarId: "standard", dailyCapacityMinutes: 480 },
      ],
    };
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("メンバーを追加"), { target: { value: "Doomed member" } });
    fireEvent.click(screen.getByTestId("master-add-member"));
    await waitFor(() => expect(screen.getByDisplayValue("Doomed member")).toBeTruthy());

    await waitFor(() => expect(server.loaderCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByDisplayValue("Server-added member")).toBeTruthy());
    expect(screen.queryByDisplayValue("Doomed member")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
  });
});
