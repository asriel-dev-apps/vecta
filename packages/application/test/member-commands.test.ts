import { describe, expect, it } from "vitest";
import { applyProjectCommand, type ProjectState } from "../src/index.js";

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: "2026-01-05",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    {
      id: "task-1",
      parentId: null,
      sortOrder: 0,
      seq: 1,
      name: "Subtask 1.1",
      processId: null,
      productId: null,
      note: "",
      contract: "",
      assigneeMemberId: null,
      plannedEffortMinutes: 480,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      actualStart: null,
      actualFinish: null,
      dependencies: [],
    },
  ],
  nextTaskSeq: 2,
};

describe("member commands", () => {
  it("adds a member that references a configured calendar", () => {
    const next = applyProjectCommand(project, {
      type: "member.add",
      member: { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    });
    expect(next.members).toEqual([
      { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    ]);
  });

  it("rejects a member without a display name", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "member.add",
        member: { id: "member-1", name: " ", calendarId: "standard", dailyCapacityMinutes: 480 },
      }),
    ).toThrow("Member member-1 requires a name");
  });

  it("rejects a member referencing an unknown calendar", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "member.add",
        member: { id: "member-1", name: "Member 01", calendarId: "missing", dailyCapacityMinutes: 480 },
      }),
    ).toThrow("unknown calendar");
  });

  it("rejects an empty member update", () => {
    const withMember = applyProjectCommand(project, {
      type: "member.add",
      member: { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    });
    expect(() =>
      applyProjectCommand(withMember, { type: "member.update", memberId: "member-1", changes: {} }),
    ).toThrow("Member update requires at least one change");
  });

  it("does not delete a member while it is assigned to a task", () => {
    const withMember = applyProjectCommand(project, {
      type: "member.add",
      member: { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    });
    const assigned = applyProjectCommand(withMember, {
      type: "task.update",
      taskId: "task-1",
      changes: { assigneeMemberId: "member-1" },
    });
    expect(() =>
      applyProjectCommand(assigned, { type: "member.delete", memberId: "member-1" }),
    ).toThrow("assigned to a task");
  });

  it("deletes an unassigned member", () => {
    const withMember = applyProjectCommand(project, {
      type: "member.add",
      member: { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    });
    const next = applyProjectCommand(withMember, { type: "member.delete", memberId: "member-1" });
    expect(next.members).toEqual([]);
  });
});
