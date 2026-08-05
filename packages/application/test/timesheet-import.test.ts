import { describe, expect, it } from "vitest";
import {
  applyProjectCommand,
  datedActualKey,
  parseTimesheetCsv,
  timesheetPartitions,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

/**
 * Timesheet import (Design 0011) — the parser and the state transition.
 *
 * The controls Design 0011 §8 requires, and what each one would let through if
 * it were the only one:
 *
 *   * §8 正 1 lives in `packages/domain/test/dated-actuals-evm.test.ts` (AC gains
 *     a time axis) — the arithmetic belongs there.
 *   * 正 2 here: W follows the dated rows, DOWN as well as up. Only the
 *     downward half catches an importer that merges instead of replacing.
 *   * 正 3 here: one person's day is replaced without touching another's.
 *   * 負 1 here: the same file twice has the effect of once.
 *   * 負 2 here: a file with four different faults writes NOTHING and reports all
 *     four with line numbers. Reporting only the first would make the fix loop as
 *     long as the file.
 *   * 負 3 here: a summary row is refused, because actuals on one are counted
 *     twice by every rollup.
 */

const MEMBER_A = "a0000000-0000-4000-8000-000000000001";
const MEMBER_B = "a0000000-0000-4000-8000-000000000002";

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id" | "seq">): ProjectTask {
  return {
    parentId: null,
    sortOrder: 0,
    name: `Task ${overrides.seq}`,
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

/** Parent `1` with leaves `2` and `3`, so a summary row is available to refuse. */
function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
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
    members: [
      { id: MEMBER_A, name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
      { id: MEMBER_B, name: "Member 02", calendarId: "standard", dailyCapacityMinutes: 480 },
    ],
    processes: [],
    products: [],
    templates: [],
    tasks: [
      makeTask({ id: "parent", seq: 1, name: "Phase A" }),
      makeTask({ id: "leaf-1", seq: 2, parentId: "parent", name: "A" }),
      makeTask({ id: "leaf-2", seq: 3, parentId: "parent", name: "B" }),
    ],
    nextTaskSeq: 4,
    nextBaselineVersion: 1,
    ...overrides,
  };
}

const HEADER = "タスクNo,日付,メンバー,工数(時間)";

function importCsv(project: ProjectState, csv: string): ProjectState {
  const parsed = parseTimesheetCsv(csv, project);
  if (!parsed.ok) throw new Error(`unexpected rejection: ${JSON.stringify(parsed.issues)}`);
  return applyProjectCommand(project, { type: "actuals.import", entries: parsed.entries });
}

function taskById(project: ProjectState, id: string): ProjectTask {
  const task = project.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
}

describe("parseTimesheetCsv", () => {
  it("resolves task No + member name to ids, and hours to whole minutes", () => {
    const parsed = parseTimesheetCsv(`${HEADER}\n2,2026-08-03,Member 01,1.5\n`, makeProject());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { taskId: "leaf-1", workDate: "2026-08-03", memberId: MEMBER_A, actualMinutes: 90 },
    ]);
    expect(parsed.summary).toEqual({
      rowCount: 1,
      firstDate: "2026-08-03",
      lastDate: "2026-08-03",
      memberCount: 1,
      taskCount: 1,
      partitionCount: 1,
    });
  });

  it("is deterministic — same text, same project, same output", () => {
    const project = makeProject();
    const csv = `${HEADER}\n3,2026-08-04,Member 02,2\n2,2026-08-03,Member 01,1\n`;
    expect(parseTimesheetCsv(csv, project)).toEqual(parseTimesheetCsv(csv, project));
  });

  it("reads columns by header name, so column order does not matter", () => {
    const reordered = "工数(時間),メンバー,日付,タスクNo\n1.5,Member 01,2026-08-03,2\n";
    const parsed = parseTimesheetCsv(reordered, makeProject());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries[0]?.actualMinutes).toBe(90);
  });

  it("ignores extra columns, which every timesheet export has", () => {
    const withExtras = `${HEADER},部署,承認者\n2,2026-08-03,Member 01,1,Dept,Someone\n`;
    const parsed = parseTimesheetCsv(withExtras, makeProject());
    expect(parsed.ok).toBe(true);
  });

  it("CONTROL 負 2: reports EVERY bad line with its number, and yields no entries", () => {
    const csv = [
      HEADER,
      "99,2026-08-03,Member 01,1", // line 2 — no such task No
      "2,2026-08-32,Member 01,1", // line 3 — not a calendar date
      "2,2026-08-03,Member 99,1", // line 4 — no such member
      "1,2026-08-03,Member 01,1", // line 5 — a summary row
      "2,2026-08-05,Member 01,x", // line 6 — not a number
      "3,2026-08-06,Member 02,1", // line 7 — fine, and still not imported
      "3,2026-08-06,Member 02,2", // line 8 — duplicate of line 7's key
    ].join("\n");
    const parsed = parseTimesheetCsv(csv, makeProject());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.line)).toEqual([2, 3, 4, 5, 6, 8]);
    // Line 5's message must name the reason, not just "invalid": a summary row is
    // a legitimate task No, so "no such task" would send the reader hunting.
    expect(parsed.issues.find((issue) => issue.line === 5)?.message).toContain("サマリ行");
    expect(parsed.issues.find((issue) => issue.line === 8)?.message).toContain("重複");
  });

  it("CONTROL (pair for 負 2): the same file with the faults removed is accepted", () => {
    // Without this, a parser that rejected everything would pass the test above.
    const parsed = parseTimesheetCsv(
      `${HEADER}\n2,2026-08-03,Member 01,1\n3,2026-08-06,Member 02,1\n`,
      makeProject(),
    );
    expect(parsed.ok).toBe(true);
  });

  it("REVIEW 2026-08-06: bounds the hours a row may claim, and refuses odd notations", () => {
    // Found by review. `Number()` reads "0x10" as 16 and "1e3" as 1000, which is
    // this module inventing an interpretation of a timesheet's text. And an
    // unbounded value means one slipped decimal point silently rewrites AC.
    for (const bad of ["0x10", "1e3", "25", "-1", " 1 2"]) {
      const parsed = parseTimesheetCsv(`${HEADER}\n2,2026-08-03,Member 01,${bad}\n`, makeProject());
      expect(parsed.ok, `expected ${bad} to be refused`).toBe(false);
    }
  });

  it("CONTROL (pair): ordinary decimal hours are still accepted", () => {
    // Without this, refusing everything would pass the test above.
    for (const good of ["0", "1", "7.5", "24"]) {
      const parsed = parseTimesheetCsv(`${HEADER}\n2,2026-08-03,Member 01,${good}\n`, makeProject());
      expect(parsed.ok, `expected ${good} to be accepted`).toBe(true);
    }
  });

  it("refuses a member name that two members share, rather than guessing", () => {
    const project = makeProject({
      members: [
        { id: MEMBER_A, name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
        { id: MEMBER_B, name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
      ],
    });
    const parsed = parseTimesheetCsv(`${HEADER}\n2,2026-08-03,Member 01,1\n`, project);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain("同名");
  });

  it("rejects a file whose required columns are missing", () => {
    const parsed = parseTimesheetCsv("タスクNo,日付\n2,2026-08-03\n", makeProject());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain("メンバー");
    expect(parsed.issues[0]?.message).toContain("工数(時間)");
  });

  it("collapses entries to the (date, member) partitions the write will replace", () => {
    const parsed = parseTimesheetCsv(
      `${HEADER}\n2,2026-08-03,Member 01,1\n3,2026-08-03,Member 01,2\n3,2026-08-03,Member 02,1\n`,
      makeProject(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary.partitionCount).toBe(2);
    expect(timesheetPartitions(parsed.entries)).toEqual([
      { workDate: "2026-08-03", memberId: MEMBER_A },
      { workDate: "2026-08-03", memberId: MEMBER_B },
    ]);
  });
});

describe("actuals.import", () => {
  it("CONTROL 正 2: W follows the dated rows, and follows them DOWN", () => {
    const first = importCsv(
      makeProject(),
      `${HEADER}\n2,2026-08-03,Member 01,2\n3,2026-08-03,Member 01,1\n`,
    );
    expect(taskById(first, "leaf-1").actualEffortMinutes).toBe(120);
    expect(taskById(first, "leaf-2").actualEffortMinutes).toBe(60);

    // A correction: the same person-day, now only on leaf-1 and for less time.
    // leaf-2's row must DISAPPEAR even though leaf-2 is not in the file — which
    // is the whole reason the replacement unit is the person-day and not the row.
    const corrected = importCsv(first, `${HEADER}\n2,2026-08-03,Member 01,1\n`);
    expect(taskById(corrected, "leaf-1").actualEffortMinutes).toBe(60);
    expect(taskById(corrected, "leaf-2").actualEffortMinutes).toBe(0);
    expect(taskById(corrected, "leaf-2").datedActuals).toEqual({});
  });

  it("CONTROL 正 3: replacing one person's day leaves another's alone", () => {
    const seeded = importCsv(
      makeProject(),
      `${HEADER}\n2,2026-08-03,Member 01,2\n2,2026-08-03,Member 02,3\n`,
    );
    expect(taskById(seeded, "leaf-1").actualEffortMinutes).toBe(300);

    const onlyA = importCsv(seeded, `${HEADER}\n2,2026-08-03,Member 01,1\n`);
    const actuals = taskById(onlyA, "leaf-1").datedActuals;
    expect(actuals[datedActualKey("2026-08-03", MEMBER_A)]).toBe(60);
    // Member 02's 3 hours are untouched: they were never in the file.
    expect(actuals[datedActualKey("2026-08-03", MEMBER_B)]).toBe(180);
    expect(taskById(onlyA, "leaf-1").actualEffortMinutes).toBe(240);
  });

  it("CONTROL 負 1: importing the same file twice has the effect of importing it once", () => {
    const csv = `${HEADER}\n2,2026-08-03,Member 01,2\n2,2026-08-04,Member 01,1\n`;
    const once = importCsv(makeProject(), csv);
    const twice = importCsv(once, csv);
    expect(twice.tasks).toEqual(once.tasks);
  });

  it("leaves tasks the import says nothing about completely alone", () => {
    // The first import must not zero the hand-entered actuals of every task in
    // the project, which is what "recompute W everywhere" would do.
    const project = makeProject({
      tasks: [
        makeTask({ id: "parent", seq: 1, name: "Phase A" }),
        makeTask({ id: "leaf-1", seq: 2, parentId: "parent" }),
        makeTask({ id: "leaf-2", seq: 3, parentId: "parent", actualEffortMinutes: 999 }),
      ],
    });
    const imported = importCsv(project, `${HEADER}\n2,2026-08-03,Member 01,1\n`);
    expect(taskById(imported, "leaf-2").actualEffortMinutes).toBe(999);
    expect(taskById(imported, "leaf-2").datedActuals).toEqual({});
  });

  it("REVIEW 2026-08-06: an unrelated day does not overwrite a hand-edited W", () => {
    // Found by review. The affected-set test was "does this task have ANY dated
    // actuals", which is not the question: a task imported in March is untouched
    // by an import of April, and recomputing its W anyway silently reverts a hand
    // edit that Design 0011 §4 deliberately allows.
    const march = importCsv(makeProject(), `${HEADER}\n2,2026-03-02,Member 01,2\n`);

    // The user corrects leaf-1's total by hand afterwards.
    const handEdited = applyProjectCommand(march, {
      type: "task.update",
      taskId: "leaf-1",
      changes: { actualEffortMinutes: 999 },
    });
    expect(taskById(handEdited, "leaf-1").actualEffortMinutes).toBe(999);

    // An import of a DIFFERENT day, naming a different task entirely.
    const april = importCsv(handEdited, `${HEADER}\n3,2026-04-06,Member 02,1\n`);
    expect(taskById(april, "leaf-1").actualEffortMinutes).toBe(999);
    // ...and its dated rows are untouched, so the flag still describes reality.
    expect(taskById(april, "leaf-1").datedActuals).toEqual(
      taskById(march, "leaf-1").datedActuals,
    );
  });

  it("CONTROL (pair): the SAME day IS recomputed, hand edit or not", () => {
    // Without this, "never recompute" would pass the test above. When the import
    // does replace a task's person-day, the import is the authority.
    const march = importCsv(makeProject(), `${HEADER}\n2,2026-03-02,Member 01,2\n`);
    const handEdited = applyProjectCommand(march, {
      type: "task.update",
      taskId: "leaf-1",
      changes: { actualEffortMinutes: 999 },
    });
    const corrected = importCsv(handEdited, `${HEADER}\n2,2026-03-02,Member 01,3\n`);
    expect(taskById(corrected, "leaf-1").actualEffortMinutes).toBe(180);
  });

  it("REVIEW 2026-08-06: a member with imported actuals cannot be deleted, and is told why", () => {
    // Found by review. Validation requires every dated-actual key to name a live
    // member, so deleting one used to fail deep inside `validateProject` with an
    // internal key string as the message — and there was no way to clear the rows
    // either, so the member was simply undeletable with no explanation.
    const imported = importCsv(makeProject(), `${HEADER}\n2,2026-08-03,Member 01,2\n`);
    expect(() =>
      applyProjectCommand(imported, { type: "member.delete", memberId: MEMBER_A }),
    ).toThrow(/has imported actuals/u);
  });

  it("CONTROL (pair): a member with NO imported actuals still deletes", () => {
    // Without this, "never delete a member" would pass the test above.
    const imported = importCsv(makeProject(), `${HEADER}\n2,2026-08-03,Member 01,2\n`);
    const after = applyProjectCommand(imported, { type: "member.delete", memberId: MEMBER_B });
    expect(after.members.map((member) => member.id)).toEqual([MEMBER_A]);
  });

  it("CONTROL 負 3: refuses entries aimed at a summary task", () => {
    expect(() =>
      applyProjectCommand(makeProject(), {
        type: "actuals.import",
        entries: [
          { taskId: "parent", workDate: "2026-08-03", memberId: MEMBER_A, actualMinutes: 60 },
        ],
      }),
    ).toThrow(/summary task/u);
  });

  it("refuses entries naming a task or member that does not exist", () => {
    expect(() =>
      applyProjectCommand(makeProject(), {
        type: "actuals.import",
        entries: [{ taskId: "nope", workDate: "2026-08-03", memberId: MEMBER_A, actualMinutes: 60 }],
      }),
    ).toThrow(/unknown task/u);
    expect(() =>
      applyProjectCommand(makeProject(), {
        type: "actuals.import",
        entries: [{ taskId: "leaf-1", workDate: "2026-08-03", memberId: "nope", actualMinutes: 60 }],
      }),
    ).toThrow(/unknown member/u);
  });
});
