import { describe, expect, it } from "vitest";
import {
  applyProjectCommand,
  applyWbsChange,
  canonicalJson,
  canonicalWbsState,
  creationChange,
  decodeWbsChange,
  deriveSubtaskId,
  diffOperation,
  emptyWbsState,
  hashWbsState,
  readWbsChange,
  WbsChangeCorruptError,
  type JsonValue,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
  type WbsChange,
} from "../src/index.js";

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

/** The whole-row JSON a task insert/delete records (everything except `dependencies`). */
function taskRow(overrides: { readonly [k: string]: JsonValue } & { readonly id: string }): JsonValue {
  const { dependencies, ...rest } = makeTask({ id: overrides.id });
  void dependencies;
  return { ...rest, ...overrides };
}

/** A task as `task.add` takes it: no `seq` (the counter assigns it). */
function newTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id">): Omit<ProjectTask, "seq"> {
  const { seq, ...rest } = makeTask(overrides);
  void seq;
  return rest;
}

const S0: ProjectState = {
  id: "w1",
  name: "W",
  projectStart: "2026-01-05",
  statusDate: "2026-01-05",
  currency: "JPY",
  defaultCalendarId: "std",
  calendars: [{ id: "std", name: "Std", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
  members: [{ id: "m1", name: "M1", calendarId: "std", dailyCapacityMinutes: 480, costRateMinorPerHour: null }],
  processes: [{ id: "pr1", name: "P1", sortOrder: 0 }],
  products: [{ id: "pd1", name: "D1", sortOrder: 0 }],
  templates: [
    {
      id: "tpl",
      name: "Tpl",
      sortOrder: 0,
      subtasks: [
        { name: "A", weightBp: 5000 },
        { name: "B", weightBp: 3000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
        { name: "C", weightBp: 2000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
      ],
    },
  ],
  tasks: [
    makeTask({ id: "t1", seq: 1, sortOrder: 0, name: "T1", plannedEffortMinutes: 100 }),
    makeTask({
      id: "t2",
      seq: 2,
      sortOrder: 1,
      name: "Old",
      plannedEffortMinutes: 480,
      dailyPlan: { "2026-01-05": 480 },
    }),
    makeTask({
      id: "t3",
      seq: 3,
      sortOrder: 2,
      name: "T3",
      dependencies: [{ predecessorId: "t2", type: "FS", lagWorkingDays: 0 }],
    }),
  ],
  nextTaskSeq: 4,
  nextBaselineVersion: 1,
};

const C0 = "302f957f-12dd-5e1e-afa3-742a3f46d1df";
const C1 = "d97b92a4-892e-5778-a543-d663d717853a";
const C2 = "68644f7e-2365-57da-b234-3f4b9623cb7b";

const GENERATE: ProjectCommand = { type: "task.generateSubtasks", parentTaskId: "t1", templateId: "tpl" };

function fold(state: ProjectState, commands: readonly ProjectCommand[]): ProjectState {
  return commands.reduce(applyProjectCommand, state);
}

/** S0 plus the three template children c0/c1/c2 with planned effort 50/30/20. */
const G = fold(S0, [GENERATE]);

/** S0 where t2 and t3 hold dated actuals / are import targets. */
const S18 = fold(S0, [
  {
    type: "task.update",
    taskId: "t2",
    changes: { datedActuals: { "2026-01-05|m1": 100 }, actualEffortMinutes: 100 },
  },
]);

/** S0 plus unused member, process, product, template — so deletes are legal. */
const SX = fold(S0, [
  {
    type: "member.add",
    member: { id: "m2", name: "M2", calendarId: "std", dailyCapacityMinutes: 240, costRateMinorPerHour: null },
  },
  { type: "process.add", process: { id: "pr2", name: "P2", sortOrder: 1 } },
  { type: "product.add", product: { id: "pd2", name: "D2", sortOrder: 1 } },
  {
    type: "template.add",
    template: { id: "tpl2", name: "Tpl2", sortOrder: 1, subtasks: [{ name: "X", weightBp: 10_000 }] },
  },
]);

function isoDay(offset: number): string {
  return new Date(Date.UTC(2026, 1, 1 + offset)).toISOString().slice(0, 10);
}

/** S0 with `tasks - 3` filler tasks and `cells` extra daily cells on t2. */
function big(tasks: number, cells: number): ProjectState {
  const dailyPlan: Record<string, number> = { "2026-01-05": 480 };
  for (let index = 0; index < cells; index += 1) dailyPlan[isoDay(index)] = index % 2 === 0 ? 1 : 0.5;
  const fillers: ProjectTask[] = [];
  for (let index = 1; index <= tasks - 3; index += 1) {
    fillers.push(makeTask({ id: `f${index}`, seq: 3 + index, sortOrder: 2 + index, name: `Filler ${index}` }));
  }
  return {
    ...S0,
    tasks: [...S0.tasks.map((task) => (task.id === "t2" ? { ...task, dailyPlan } : task)), ...fillers],
    nextTaskSeq: 4 + fillers.length,
  };
}

/**
 * Runs the operation and checks the two independent properties every diff must
 * hold: `after` is what the plain transition gives, and replaying the record on
 * `before` gives `after` again. Returns the change for literal assertions.
 */
function run(before: ProjectState, commands: readonly ProjectCommand[]): WbsChange {
  const { after, change } = diffOperation(before, commands);
  expect(canonicalWbsState(after)).toBe(canonicalWbsState(fold(before, commands)));
  expect(canonicalWbsState(applyWbsChange(before, change))).toBe(canonicalWbsState(after));
  return change;
}

function replaysWith(
  apply: (state: ProjectState, change: WbsChange) => ProjectState,
  before: ProjectState,
  commands: readonly ProjectCommand[],
): boolean {
  const { after, change } = diffOperation(before, commands);
  return canonicalWbsState(apply(before, change)) === canonicalWbsState(after);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

describe("canonicalJson", () => {
  it("orders keys by UTF-16 code unit, not by locale", () => {
    expect(canonicalJson({ a: 1, B: 2, é: 3, Z: 0 })).toBe('{"B":2,"Z":0,"a":1,"é":3}');
  });

  it("nests, keeps array order, drops undefined and writes no whitespace", () => {
    expect(canonicalJson({ z: [3, 1, { y: undefined, b: 1, a: [] }], n: null })).toBe(
      '{"n":null,"z":[3,1,{"a":[],"b":1}]}',
    );
  });

  it("writes numbers as the shortest round-trip text, unrounded", () => {
    expect(canonicalJson([0.5, 0.1, 1e21, -0, 100])).toBe("[0.5,0.1,1e+21,0,100]");
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow();
  });
});

describe("canonicalWbsState / hashWbsState", () => {
  const T: ProjectState = {
    id: "w1",
    name: "W",
    projectStart: "2026-01-05",
    statusDate: "2026-01-05",
    currency: "JPY",
    defaultCalendarId: "std",
    calendars: [],
    members: [],
    processes: [],
    products: [],
    templates: [],
    tasks: [],
    nextTaskSeq: 1,
    nextBaselineVersion: 1,
  };
  const T_CANONICAL =
    '{"calendars":[],"canonical":1,"currency":"JPY","defaultCalendarId":"std","id":"w1","members":[],"name":"W","nextBaselineVersion":1,"nextTaskSeq":1,"processes":[],"products":[],"projectStart":"2026-01-05","statusDate":"2026-01-05","tasks":[],"templates":[]}';

  it("has a literal canonical form with the version marker", () => {
    expect(canonicalWbsState(T)).toBe(T_CANONICAL);
  });

  it("hashes the canonical string with SHA-256 as lowercase hex", async () => {
    const hash = await hashWbsState(T);
    expect(hash).toBe("f3f7f22f67860879453d124a21ed3566180a3bf77723597d3d9b59254c5369fb");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(T_CANONICAL));
    expect(hash).toBe([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("orders collections by id and dependencies by (predecessor, type); input order is irrelevant", () => {
    const deps = [
      { predecessorId: "t9", type: "FS" as const, lagWorkingDays: 0 },
      { predecessorId: "t2", type: "SS" as const, lagWorkingDays: 0 },
      { predecessorId: "t2", type: "FS" as const, lagWorkingDays: 0 },
    ];
    const base: ProjectState = {
      ...S0,
      calendars: [
        ...S0.calendars,
        { id: "alt", name: "Alt", workingWeekdays: [1], nonWorkingDates: [] },
      ],
      tasks: [
        ...S0.tasks.map((task) => (task.id === "t3" ? { ...task, dependencies: deps } : task)),
        makeTask({ id: "t9", seq: 9, sortOrder: 9 }),
      ],
    };
    const reversed: ProjectState = {
      ...base,
      calendars: [...base.calendars].reverse(),
      members: [...base.members].reverse(),
      processes: [...base.processes].reverse(),
      products: [...base.products].reverse(),
      templates: [...base.templates].reverse(),
      tasks: [...base.tasks]
        .map((task) => (task.id === "t3" ? { ...task, dependencies: [...deps].reverse() } : task))
        .reverse(),
    };
    expect(canonicalWbsState(reversed)).toBe(canonicalWbsState(base));
    const text = canonicalWbsState(base);
    const fs2 = text.indexOf('{"lagWorkingDays":0,"predecessorId":"t2","type":"FS"}');
    const ss2 = text.indexOf('{"lagWorkingDays":0,"predecessorId":"t2","type":"SS"}');
    const fs9 = text.indexOf('{"lagWorkingDays":0,"predecessorId":"t9","type":"FS"}');
    expect(fs2).toBeGreaterThan(-1);
    expect(ss2).toBeGreaterThan(fs2);
    expect(fs9).toBeGreaterThan(ss2);
    expect(text.indexOf('"id":"alt"')).toBeLessThan(text.indexOf('"id":"std"'));
  });

  it("keeps arrays whose order is data", () => {
    const state: ProjectState = {
      ...S0,
      calendars: [{ id: "std", name: "Std", workingWeekdays: [5, 1, 3], nonWorkingDates: [] }],
      templates: [
        {
          id: "tpl",
          name: "Tpl",
          sortOrder: 0,
          subtasks: [
            { name: "Bstep", weightBp: 5000 },
            { name: "Astep", weightBp: 5000 },
          ],
        },
      ],
    };
    const text = canonicalWbsState(state);
    expect(text).toContain('"workingWeekdays":[5,1,3]');
    expect(text.indexOf('"name":"Bstep"')).toBeGreaterThan(-1);
    expect(text.indexOf('"name":"Bstep"')).toBeLessThan(text.indexOf('"name":"Astep"'));
  });

  it("gives a different hash when any field differs", async () => {
    const base = await hashWbsState(S0);
    const cell = fold(S0, [
      { type: "task.update", taskId: "t2", changes: { dailyPlan: { "2026-01-05": 479 } } },
    ]);
    const note = fold(S0, [{ type: "task.update", taskId: "t2", changes: { note: "x" } }]);
    const cellHash = await hashWbsState(cell);
    const noteHash = await hashWbsState(note);
    expect(cellHash).not.toBe(base);
    expect(noteHash).not.toBe(base);
    expect(cellHash).not.toBe(noteHash);
  });
});

describe("diffOperation: one command", () => {
  it("records a rename as one direct entry", () => {
    expect(run(S0, [{ type: "task.update", taskId: "t2", changes: { name: "New" } }])).toStrictEqual({
      format: 1,
      changes: [{ target: "task:t2", field: "name", before: "Old", after: "New", kind: "direct" }],
    });
  });

  it("keeps a direct write whose value did not change", () => {
    expect(run(S0, [{ type: "task.update", taskId: "t2", changes: { name: "Old" } }]).changes).toStrictEqual([
      { target: "task:t2", field: "name", before: "Old", after: "Old", kind: "direct" },
    ]);
  });

  it("keeps a direct child write that re-proration snaps back, with no derived entry", () => {
    expect(run(G, [{ type: "task.update", taskId: C0, changes: { plannedEffortMinutes: 999 } }]).changes).toStrictEqual([
      { target: `task:${C0}`, field: "plannedEffortMinutes", before: 50, after: 50, kind: "direct" },
    ]);
  });

  it("records daily plan per cell, keeping same-value cells and removing absent ones", () => {
    const written = run(S0, [
      { type: "task.update", taskId: "t2", changes: { dailyPlan: { "2026-01-06": 240, "2026-01-05": 480 } } },
    ]).changes;
    expect(written).toStrictEqual([
      { target: "task:t2", field: "dailyPlan.2026-01-05", before: 480, after: 480, kind: "direct" },
      { target: "task:t2", field: "dailyPlan.2026-01-06", after: 240, kind: "direct" },
    ]);
    expect("before" in written[1]!).toBe(false);

    const cleared = run(S0, [{ type: "task.update", taskId: "t2", changes: { dailyPlan: {} } }]).changes;
    expect(cleared).toStrictEqual([
      { target: "task:t2", field: "dailyPlan.2026-01-05", before: 480, kind: "direct" },
    ]);
    expect("after" in cleared[0]!).toBe(false);
  });

  it("tells null from absent", () => {
    const set = run(S0, [{ type: "task.update", taskId: "t2", changes: { processId: "pr1" } }]).changes;
    expect(set).toStrictEqual([
      { target: "task:t2", field: "processId", before: null, after: "pr1", kind: "direct" },
    ]);
    expect("before" in set[0]!).toBe(true);

    const withProcess = fold(S0, [{ type: "task.update", taskId: "t2", changes: { processId: "pr1" } }]);
    const cleared = run(withProcess, [{ type: "task.update", taskId: "t2", changes: { processId: null } }]).changes;
    expect(cleared).toStrictEqual([
      { target: "task:t2", field: "processId", before: "pr1", after: null, kind: "direct" },
    ]);
    expect("after" in cleared[0]!).toBe(true);
  });

  it("task.add: whole row with its seq, the dependency edge, and the structural counter", () => {
    const added = newTask({
      id: "t4",
      sortOrder: 3,
      name: "T4",
      dailyPlan: { "2026-01-07": 60 },
      dependencies: [{ predecessorId: "t3", type: "SS", lagWorkingDays: 1 }],
    });
    expect(run(S0, [{ type: "task.add", task: added }]).changes).toStrictEqual([
      {
        target: "dependency:t4<-t3:SS",
        field: "",
        after: { predecessorId: "t3", type: "SS", lagWorkingDays: 1 },
        kind: "direct",
      },
      {
        target: "task:t4",
        field: "",
        after: taskRow({ id: "t4", seq: 4, sortOrder: 3, name: "T4", dailyPlan: { "2026-01-07": 60 } }),
        kind: "direct",
      },
      { target: "wbs", field: "nextTaskSeq", before: 4, after: 5, kind: "structural" },
    ]);
  });

  it("task.delete: row delete is direct, children re-parenting is structural", () => {
    expect(run(G, [{ type: "task.delete", taskId: "t1" }]).changes).toStrictEqual([
      { target: `task:${C0}`, field: "parentId", before: "t1", after: null, kind: "structural" },
      { target: `task:${C2}`, field: "parentId", before: "t1", after: null, kind: "structural" },
      { target: `task:${C1}`, field: "parentId", before: "t1", after: null, kind: "structural" },
      {
        target: "task:t1",
        field: "",
        before: taskRow({ id: "t1", seq: 1, name: "T1", plannedEffortMinutes: 100 }),
        kind: "direct",
      },
    ]);
  });

  it("task.delete: the deleted task's own dependency edges are structural", () => {
    expect(run(S0, [{ type: "task.delete", taskId: "t3" }]).changes).toStrictEqual([
      {
        target: "dependency:t3<-t2:FS",
        field: "",
        before: { predecessorId: "t2", type: "FS", lagWorkingDays: 0 },
        kind: "structural",
      },
      {
        target: "task:t3",
        field: "",
        before: taskRow({ id: "t3", seq: 3, sortOrder: 2, name: "T3" }),
        kind: "direct",
      },
    ]);
  });

  it("task.generateSubtasks: structural rows with re-proration inside them, edges and counter", () => {
    expect([C0, C1, C2]).toStrictEqual([0, 1, 2].map((index) => deriveSubtaskId("t1", index)));
    expect(run(S0, [GENERATE]).changes).toStrictEqual([
      {
        target: `dependency:${C2}<-${C1}:FS`,
        field: "",
        after: { predecessorId: C1, type: "FS", lagWorkingDays: 0 },
        kind: "structural",
      },
      {
        target: `dependency:${C1}<-${C0}:FS`,
        field: "",
        after: { predecessorId: C0, type: "FS", lagWorkingDays: 0 },
        kind: "structural",
      },
      {
        target: `task:${C0}`,
        field: "",
        after: taskRow({
          id: C0,
          parentId: "t1",
          sortOrder: 3,
          seq: 4,
          name: "A",
          plannedEffortMinutes: 50,
          prorationWeightBp: 5000,
          dailyPlan: { "2026-01-05": 50 },
        }),
        kind: "structural",
      },
      {
        target: `task:${C2}`,
        field: "",
        after: taskRow({
          id: C2,
          parentId: "t1",
          sortOrder: 5,
          seq: 6,
          name: "C",
          plannedEffortMinutes: 20,
          prorationWeightBp: 2000,
          dailyPlan: { "2026-01-07": 20 },
        }),
        kind: "structural",
      },
      {
        target: `task:${C1}`,
        field: "",
        after: taskRow({
          id: C1,
          parentId: "t1",
          sortOrder: 4,
          seq: 5,
          name: "B",
          plannedEffortMinutes: 30,
          prorationWeightBp: 3000,
          dailyPlan: { "2026-01-06": 30 },
        }),
        kind: "structural",
      },
      { target: "wbs", field: "nextTaskSeq", before: 4, after: 7, kind: "structural" },
    ]);
  });

  it("actuals.import: cells are direct, the derived total is derived", () => {
    expect(
      run(S18, [
        {
          type: "actuals.import",
          entries: [
            { taskId: "t3", workDate: "2026-01-06", memberId: "m1", actualMinutes: 200 },
            { taskId: "t2", workDate: "2026-01-05", memberId: "m1", actualMinutes: 50 },
          ],
        },
      ]).changes,
    ).toStrictEqual([
      { target: "task:t2", field: "actualEffortMinutes", before: 100, after: 50, kind: "derived" },
      { target: "task:t2", field: "datedActuals.2026-01-05|m1", before: 100, after: 50, kind: "direct" },
      { target: "task:t3", field: "actualEffortMinutes", before: 0, after: 200, kind: "derived" },
      { target: "task:t3", field: "datedActuals.2026-01-06|m1", after: 200, kind: "direct" },
    ]);
  });

  it("actuals.import: a cell removed from a replaced partition is a direct removal", () => {
    expect(
      run(S18, [
        {
          type: "actuals.import",
          entries: [{ taskId: "t3", workDate: "2026-01-05", memberId: "m1", actualMinutes: 100 }],
        },
      ]).changes,
    ).toStrictEqual([
      { target: "task:t2", field: "actualEffortMinutes", before: 100, after: 0, kind: "derived" },
      { target: "task:t2", field: "datedActuals.2026-01-05|m1", before: 100, kind: "direct" },
      { target: "task:t3", field: "actualEffortMinutes", before: 0, after: 100, kind: "derived" },
      { target: "task:t3", field: "datedActuals.2026-01-05|m1", after: 100, kind: "direct" },
    ]);
  });

  it("baseline.publish: only the counter, direct", () => {
    expect(run(S0, [{ type: "baseline.publish", acknowledgeUnplottedTasks: true }]).changes).toStrictEqual([
      { target: "wbs", field: "nextBaselineVersion", before: 1, after: 2, kind: "direct" },
    ]);
  });

  describe("master rows", () => {
    const m2 = { id: "m2", name: "M2", calendarId: "std", dailyCapacityMinutes: 240, costRateMinorPerHour: null };

    it("member add / update / delete", () => {
      expect(run(S0, [{ type: "member.add", member: m2 }]).changes).toStrictEqual([
        { target: "member:m2", field: "", after: m2, kind: "direct" },
      ]);
      expect(
        run(S0, [
          { type: "member.update", memberId: "m1", changes: { dailyCapacityMinutes: 360, costRateMinorPerHour: null } },
        ]).changes,
      ).toStrictEqual([
        { target: "member:m1", field: "costRateMinorPerHour", before: null, after: null, kind: "direct" },
        { target: "member:m1", field: "dailyCapacityMinutes", before: 480, after: 360, kind: "direct" },
      ]);
      const removed = run(SX, [{ type: "member.delete", memberId: "m2" }]).changes;
      expect(removed).toStrictEqual([{ target: "member:m2", field: "", before: m2, kind: "direct" }]);
      expect("after" in removed[0]!).toBe(false);
    });

    it("process add / update / delete", () => {
      expect(run(S0, [{ type: "process.add", process: { id: "pr2", name: "P2", sortOrder: 1 } }]).changes).toStrictEqual([
        { target: "process:pr2", field: "", after: { id: "pr2", name: "P2", sortOrder: 1 }, kind: "direct" },
      ]);
      expect(run(S0, [{ type: "process.update", processId: "pr1", changes: { name: "X" } }]).changes).toStrictEqual([
        { target: "process:pr1", field: "name", before: "P1", after: "X", kind: "direct" },
      ]);
      expect(run(SX, [{ type: "process.delete", processId: "pr2" }]).changes).toStrictEqual([
        { target: "process:pr2", field: "", before: { id: "pr2", name: "P2", sortOrder: 1 }, kind: "direct" },
      ]);
    });

    it("product add / update / delete", () => {
      expect(run(S0, [{ type: "product.add", product: { id: "pd2", name: "D2", sortOrder: 1 } }]).changes).toStrictEqual([
        { target: "product:pd2", field: "", after: { id: "pd2", name: "D2", sortOrder: 1 }, kind: "direct" },
      ]);
      expect(run(S0, [{ type: "product.update", productId: "pd1", changes: { sortOrder: 4 } }]).changes).toStrictEqual([
        { target: "product:pd1", field: "sortOrder", before: 0, after: 4, kind: "direct" },
      ]);
      expect(run(SX, [{ type: "product.delete", productId: "pd2" }]).changes).toStrictEqual([
        { target: "product:pd2", field: "", before: { id: "pd2", name: "D2", sortOrder: 1 }, kind: "direct" },
      ]);
    });

    it("template add / update (one whole-array entry) / delete", () => {
      const tpl2 = { id: "tpl2", name: "Tpl2", sortOrder: 1, subtasks: [{ name: "X", weightBp: 10_000 }] };
      expect(run(S0, [{ type: "template.add", template: tpl2 }]).changes).toStrictEqual([
        { target: "template:tpl2", field: "", after: tpl2, kind: "direct" },
      ]);
      expect(
        run(S0, [
          {
            type: "template.update",
            templateId: "tpl",
            changes: {
              subtasks: [
                { name: "A", weightBp: 6000 },
                { name: "B", weightBp: 4000, dependsOnPrev: { type: "SS", lagWorkingDays: 1 } },
              ],
            },
          },
        ]).changes,
      ).toStrictEqual([
        {
          target: "template:tpl",
          field: "subtasks",
          before: [
            { name: "A", weightBp: 5000 },
            { name: "B", weightBp: 3000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
            { name: "C", weightBp: 2000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
          ],
          after: [
            { name: "A", weightBp: 6000 },
            { name: "B", weightBp: 4000, dependsOnPrev: { type: "SS", lagWorkingDays: 1 } },
          ],
          kind: "direct",
        },
      ]);
      expect(run(SX, [{ type: "template.delete", templateId: "tpl2" }]).changes).toStrictEqual([
        { target: "template:tpl2", field: "", before: tpl2, kind: "direct" },
      ]);
    });

    it("calendar target is applied from a hand-built change (no calendar command exists)", () => {
      const next = applyWbsChange(S0, {
        format: 1,
        changes: [
          {
            target: "calendar:std",
            field: "workingWeekdays",
            before: [1, 2, 3, 4, 5],
            after: [1, 2, 3, 4],
            kind: "direct",
          },
        ],
      });
      expect(next.calendars).toStrictEqual([
        { id: "std", name: "Std", workingWeekdays: [1, 2, 3, 4], nonWorkingDates: [] },
      ]);
      expect(S0.calendars[0]!.workingWeekdays).toStrictEqual([1, 2, 3, 4, 5]);
    });
  });

  it("proration is derived: parent edit moves every child", () => {
    expect(run(G, [{ type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 200 } }]).changes).toStrictEqual([
      { target: `task:${C0}`, field: "plannedEffortMinutes", before: 50, after: 100, kind: "derived" },
      { target: `task:${C2}`, field: "plannedEffortMinutes", before: 20, after: 40, kind: "derived" },
      { target: `task:${C1}`, field: "plannedEffortMinutes", before: 30, after: 60, kind: "derived" },
      { target: "task:t1", field: "plannedEffortMinutes", before: 100, after: 200, kind: "direct" },
    ]);
  });

  it("proration by largest remainder records only the sibling that moved", () => {
    expect(run(G, [{ type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 101 } }]).changes).toStrictEqual([
      { target: `task:${C0}`, field: "plannedEffortMinutes", before: 50, after: 51, kind: "derived" },
      { target: "task:t1", field: "plannedEffortMinutes", before: 100, after: 101, kind: "direct" },
    ]);
  });

  describe("dependencies via task.update (decisions: rows it adds/removes/changes are direct)", () => {
    it("adding a second type on the same predecessor is one insert keyed with the type; the unchanged edge has no entry", () => {
      const change = run(S0, [
        {
          type: "task.update",
          taskId: "t3",
          changes: {
            dependencies: [
              { predecessorId: "t2", type: "FS", lagWorkingDays: 0 },
              { predecessorId: "t2", type: "SS", lagWorkingDays: 0 },
            ],
          },
        },
      ]);
      expect(change.changes).toStrictEqual([
        {
          target: "dependency:t3<-t2:SS",
          field: "",
          after: { predecessorId: "t2", type: "SS", lagWorkingDays: 0 },
          kind: "direct",
        },
      ]);
    });

    it("a lag change is one lagWorkingDays entry", () => {
      expect(
        run(S0, [
          {
            type: "task.update",
            taskId: "t3",
            changes: { dependencies: [{ predecessorId: "t2", type: "FS", lagWorkingDays: 2 }] },
          },
        ]).changes,
      ).toStrictEqual([
        { target: "dependency:t3<-t2:FS", field: "lagWorkingDays", before: 0, after: 2, kind: "direct" },
      ]);
    });

    it("removing an edge is a direct row delete", () => {
      expect(run(S0, [{ type: "task.update", taskId: "t3", changes: { dependencies: [] } }]).changes).toStrictEqual([
        {
          target: "dependency:t3<-t2:FS",
          field: "",
          before: { predecessorId: "t2", type: "FS", lagWorkingDays: 0 },
          kind: "direct",
        },
      ]);
    });
  });

  it("sortOrder and parentId written by task.update are direct", () => {
    expect(run(S0, [{ type: "task.update", taskId: "t3", changes: { sortOrder: 0, parentId: "t1" } }]).changes).toStrictEqual([
      { target: "task:t3", field: "parentId", before: null, after: "t1", kind: "direct" },
      { target: "task:t3", field: "sortOrder", before: 2, after: 0, kind: "direct" },
    ]);
  });

  it("orders entries by code unit and is stable across runs", () => {
    const commands: ProjectCommand[] = [
      { type: "task.add", task: newTask({ id: "B1", sortOrder: 3, name: "b" }) },
      { type: "task.add", task: newTask({ id: "a1", sortOrder: 4, name: "a" }) },
      { type: "member.update", memberId: "m1", changes: { name: "Renamed" } },
    ];
    const first = run(S0, commands);
    expect(first.changes.map((entry) => entry.target)).toStrictEqual(["member:m1", "task:B1", "task:a1", "wbs"]);
    expect(run(S0, commands)).toStrictEqual(first);

    const fields = run(S0, [
      {
        type: "task.update",
        taskId: "t2",
        changes: { name: "N", dailyPlan: { "2026-01-05": 480 }, note: "n" },
      },
    ]).changes.map((entry) => entry.field);
    expect(fields).toStrictEqual(["dailyPlan.2026-01-05", "name", "note"]);
  });
});

describe("diffOperation: several commands", () => {
  const rename = (name: string): ProjectCommand => ({ type: "task.update", taskId: "t2", changes: { name } });

  it("reorder: every command's entries are present", () => {
    expect(
      run(S0, [
        { type: "task.update", taskId: "t3", changes: { sortOrder: 0 } },
        { type: "task.update", taskId: "t2", changes: { sortOrder: 2, parentId: "t1" } },
        { type: "task.update", taskId: "t1", changes: { sortOrder: 1 } },
      ]).changes,
    ).toStrictEqual([
      { target: "task:t1", field: "sortOrder", before: 0, after: 1, kind: "direct" },
      { target: "task:t2", field: "parentId", before: null, after: "t1", kind: "direct" },
      { target: "task:t2", field: "sortOrder", before: 1, after: 2, kind: "direct" },
      { target: "task:t3", field: "sortOrder", before: 2, after: 0, kind: "direct" },
    ]);
  });

  it("change then change back keeps one direct entry", () => {
    expect(run(S0, [rename("Mid"), rename("Old")]).changes).toStrictEqual([
      { target: "task:t2", field: "name", before: "Old", after: "Old", kind: "direct" },
    ]);
  });

  it("before is the first command's before, after the last command's after", () => {
    expect(run(S0, [rename("Mid"), rename("New")]).changes).toStrictEqual([
      { target: "task:t2", field: "name", before: "Old", after: "New", kind: "direct" },
    ]);
  });

  it("a derived entry that ends equal disappears while the direct one stays", () => {
    expect(
      run(G, [
        { type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 200 } },
        { type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 100 } },
      ]).changes,
    ).toStrictEqual([
      { target: "task:t1", field: "plannedEffortMinutes", before: 100, after: 100, kind: "direct" },
    ]);
  });

  it("a field written after the row was generated lives inside the structural insert", () => {
    const generated = run(S0, [GENERATE]);
    const renamed = run(S0, [GENERATE, { type: "task.update", taskId: C0, changes: { name: "Renamed" } }]);
    const c0 = renamed.changes.find((entry) => entry.target === `task:${C0}`);
    expect(c0).toStrictEqual({
      target: `task:${C0}`,
      field: "",
      after: taskRow({
        id: C0,
        parentId: "t1",
        sortOrder: 3,
        seq: 4,
        name: "Renamed",
        plannedEffortMinutes: 50,
        prorationWeightBp: 5000,
        dailyPlan: { "2026-01-05": 50 },
      }),
      kind: "structural",
    });
    expect(renamed.changes).toHaveLength(generated.changes.length);
  });

  it("kind merge: derived then direct is direct", () => {
    const changes = run(G, [
      { type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 200 } },
      { type: "task.update", taskId: C0, changes: { plannedEffortMinutes: 100 } },
    ]).changes;
    expect(changes.filter((entry) => entry.target === `task:${C0}`)).toStrictEqual([
      { target: `task:${C0}`, field: "plannedEffortMinutes", before: 50, after: 100, kind: "direct" },
    ]);
    expect(changes.find((entry) => entry.target === `task:${C1}`)).toStrictEqual({
      target: `task:${C1}`,
      field: "plannedEffortMinutes",
      before: 30,
      after: 60,
      kind: "derived",
    });
  });

  it("remove then re-add of one edge records the row and the user's lag as direct", () => {
    expect(
      run(S0, [
        { type: "task.update", taskId: "t3", changes: { dependencies: [] } },
        {
          type: "task.update",
          taskId: "t3",
          changes: { dependencies: [{ predecessorId: "t2", type: "FS", lagWorkingDays: 2 }] },
        },
      ]).changes,
    ).toStrictEqual([
      {
        target: "dependency:t3<-t2:FS",
        field: "",
        before: { predecessorId: "t2", type: "FS", lagWorkingDays: 0 },
        after: { predecessorId: "t2", type: "FS", lagWorkingDays: 2 },
        kind: "direct",
      },
      { target: "dependency:t3<-t2:FS", field: "lagWorkingDays", before: 0, after: 2, kind: "direct" },
    ]);
  });

  it("kind merge: direct then derived stays direct", () => {
    const changes = run(G, [
      { type: "task.update", taskId: C0, changes: { plannedEffortMinutes: 77 } },
      { type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 200 } },
    ]).changes;
    expect(changes.filter((entry) => entry.target === `task:${C0}`)).toStrictEqual([
      { target: `task:${C0}`, field: "plannedEffortMinutes", before: 50, after: 100, kind: "direct" },
    ]);
  });

  it("kind merge: structural insert later re-prorated stays a structural insert with the final values", () => {
    const changes = run(S0, [GENERATE, { type: "task.update", taskId: "t1", changes: { plannedEffortMinutes: 200 } }]).changes;
    expect(changes.find((entry) => entry.target === `task:${C0}`)).toStrictEqual({
      target: `task:${C0}`,
      field: "",
      after: taskRow({
        id: C0,
        parentId: "t1",
        sortOrder: 3,
        seq: 4,
        name: "A",
        plannedEffortMinutes: 100,
        prorationWeightBp: 5000,
        dailyPlan: { "2026-01-05": 50 },
      }),
      kind: "structural",
    });
    expect(changes.find((entry) => entry.target === "task:t1")).toStrictEqual({
      target: "task:t1",
      field: "plannedEffortMinutes",
      before: 100,
      after: 200,
      kind: "direct",
    });
  });

  it("insert then delete in one operation leaves no entry for that row", () => {
    const added = newTask({ id: "t9", sortOrder: 9, name: "Nine" });
    const changes = run(S0, [{ type: "task.add", task: added }, { type: "task.delete", taskId: "t9" }]).changes;
    expect(changes).toStrictEqual([
      { target: "wbs", field: "nextTaskSeq", before: 4, after: 5, kind: "structural" },
    ]);
  });
});

describe("replay over every command type", () => {
  const added = newTask({
    id: "t4",
    sortOrder: 3,
    name: "T4",
    dailyPlan: { "2026-01-07": 60 },
    dependencies: [{ predecessorId: "t3", type: "SS", lagWorkingDays: 1 }],
  });
  const cases: readonly (readonly [string, ProjectState, readonly ProjectCommand[]])[] = [
    ["task.add", S0, [{ type: "task.add", task: added }]],
    ["task.update scalar", S0, [{ type: "task.update", taskId: "t2", changes: { name: "New", note: "n" } }]],
    ["task.update dailyPlan", S0, [{ type: "task.update", taskId: "t2", changes: { dailyPlan: { "2026-01-06": 240 } } }]],
    ["task.update datedActuals", S18, [{ type: "task.update", taskId: "t2", changes: { datedActuals: { "2026-01-05|m1": 150 } } }]],
    [
      "task.update dependencies",
      S0,
      [{ type: "task.update", taskId: "t3", changes: { dependencies: [{ predecessorId: "t2", type: "SS", lagWorkingDays: 2 }] } }],
    ],
    ["task.delete with children", G, [{ type: "task.delete", taskId: "t1" }]],
    ["task.generateSubtasks", S0, [GENERATE]],
    [
      "member.add",
      S0,
      [{ type: "member.add", member: { id: "m2", name: "M2", calendarId: "std", dailyCapacityMinutes: 240, costRateMinorPerHour: 5000 } }],
    ],
    ["member.update", S0, [{ type: "member.update", memberId: "m1", changes: { name: "Renamed" } }]],
    ["member.delete", SX, [{ type: "member.delete", memberId: "m2" }]],
    ["process.add", S0, [{ type: "process.add", process: { id: "pr2", name: "P2", sortOrder: 1 } }]],
    ["process.update", S0, [{ type: "process.update", processId: "pr1", changes: { name: "X" } }]],
    ["process.delete", SX, [{ type: "process.delete", processId: "pr2" }]],
    ["product.add", S0, [{ type: "product.add", product: { id: "pd2", name: "D2", sortOrder: 1 } }]],
    ["product.update", S0, [{ type: "product.update", productId: "pd1", changes: { name: "X" } }]],
    ["product.delete", SX, [{ type: "product.delete", productId: "pd2" }]],
    [
      "template.add",
      S0,
      [{ type: "template.add", template: { id: "tpl3", name: "T3", sortOrder: 2, subtasks: [{ name: "Y", weightBp: 10_000 }] } }],
    ],
    ["template.update", S0, [{ type: "template.update", templateId: "tpl", changes: { name: "Renamed" } }]],
    ["template.delete", SX, [{ type: "template.delete", templateId: "tpl2" }]],
    ["baseline.publish", S0, [{ type: "baseline.publish", acknowledgeUnplottedTasks: true }]],
    [
      "actuals.import",
      S18,
      [{ type: "actuals.import", entries: [{ taskId: "t3", workDate: "2026-01-06", memberId: "m1", actualMinutes: 30 }] }],
    ],
    [
      "multi: reorder",
      S0,
      [
        { type: "task.update", taskId: "t3", changes: { sortOrder: 0 } },
        { type: "task.update", taskId: "t2", changes: { sortOrder: 2, parentId: "t1" } },
      ],
    ],
    [
      "multi: change and back",
      S0,
      [
        { type: "task.update", taskId: "t2", changes: { name: "Mid" } },
        { type: "task.update", taskId: "t2", changes: { name: "Old" } },
      ],
    ],
    [
      "multi: generate then edit child",
      S0,
      [GENERATE, { type: "task.update", taskId: C0, changes: { name: "Renamed" } }],
    ],
    [
      "multi: add then delete",
      S0,
      [{ type: "task.add", task: added }, { type: "task.delete", taskId: "t4" }],
    ],
  ];

  it.each(cases)("%s: the record replays to the transition's state", (_name, before, commands) => {
    const change = run(before, commands);
    expect(change.changes.length).toBeGreaterThan(0);
  });

  it.each(cases.filter(([name]) => !name.includes("change and back") && !name.includes("add then delete")))(
    "%s: the state really changed",
    (_name, before, commands) => {
      expect(canonicalWbsState(diffOperation(before, commands).after)).not.toBe(canonicalWbsState(before));
    },
  );

  it("replays on a structured clone and from a JSON-stored record", () => {
    const commands: ProjectCommand[] = [
      { type: "task.update", taskId: "t2", changes: { dailyPlan: { "2026-01-06": 240 }, processId: "pr1" } },
      { type: "task.update", taskId: "t3", changes: { dependencies: [] } },
    ];
    const { after, change } = diffOperation(S0, commands);
    const viaClone = applyWbsChange(structuredClone(S0), change);
    const viaJson = applyWbsChange(S0, readWbsChange(JSON.parse(JSON.stringify(change))));
    expect(canonicalWbsState(viaClone)).toBe(canonicalWbsState(after));
    expect(canonicalWbsState(viaJson)).toBe(canonicalWbsState(after));
  });
});

describe("size independence", () => {
  const rename: ProjectCommand = { type: "task.update", taskId: "t2", changes: { name: "New" } };

  it("a rename records one entry however many tasks or cells exist", () => {
    const sizes: readonly (readonly [number, number])[] = [
      [3, 45],
      [300, 45],
      [3, 500],
      [300, 500],
    ];
    const lengths = new Set<number>();
    for (const [tasks, cells] of sizes) {
      const change = run(big(tasks, cells), [rename]);
      expect(change).toStrictEqual({
        format: 1,
        changes: [{ target: "task:t2", field: "name", before: "Old", after: "New", kind: "direct" }],
      });
      const length = JSON.stringify(change).length;
      expect(length).toBeLessThan(200);
      lengths.add(length);
    }
    expect(lengths.size).toBe(1);
  });

  it("a daily-plan edit is recorded per cell, never as the whole map", () => {
    const before = big(3, 500);
    const t2 = before.tasks.find((task) => task.id === "t2")!;
    const cell = isoDay(9);
    const original = t2.dailyPlan[cell]!;
    const change = run(before, [
      { type: "task.update", taskId: "t2", changes: { dailyPlan: { ...t2.dailyPlan, [cell]: 2 } } },
    ]);
    expect(change.changes.some((entry) => entry.field === "dailyPlan")).toBe(false);
    expect(change.changes).toHaveLength(501);
    expect(change.changes.every((entry) => entry.kind === "direct" && entry.field.startsWith("dailyPlan."))).toBe(true);
    expect(change.changes.filter((entry) => entry.before !== entry.after)).toStrictEqual([
      { target: "task:t2", field: `dailyPlan.${cell}`, before: original, after: 2, kind: "direct" },
    ]);
  });
});

describe("applyWbsChange guards", () => {
  const rename = run(S0, [{ type: "task.update", taskId: "t2", changes: { name: "New" } }]);

  it("throws when a before value is stale", () => {
    const other = fold(S0, [{ type: "task.update", taskId: "t2", changes: { name: "Other" } }]);
    expect(() => applyWbsChange(other, rename)).toThrow();
  });

  it("throws when an inserted row already exists", () => {
    const insert: WbsChange = {
      format: 1,
      changes: [{ target: "task:t3", field: "", after: taskRow({ id: "t3", seq: 9 }), kind: "direct" }],
    };
    expect(() => applyWbsChange(S0, insert)).toThrow();
  });

  it("throws when a deleted row's before differs from the stored row", () => {
    const remove: WbsChange = {
      format: 1,
      changes: [
        { target: "task:t3", field: "", before: taskRow({ id: "t3", seq: 3, sortOrder: 2, name: "Not T3" }), kind: "direct" },
      ],
    };
    expect(() => applyWbsChange(S0, remove)).toThrow();
  });

  it("does not mutate its input, and accepts a deeply frozen one", () => {
    const frozen = deepFreeze(structuredClone(S0));
    const generate = run(S0, [GENERATE]);
    const before = canonicalWbsState(frozen);
    expect(canonicalWbsState(applyWbsChange(frozen, rename))).not.toBe(before);
    expect(canonicalWbsState(applyWbsChange(frozen, generate))).not.toBe(before);
    expect(canonicalWbsState(frozen)).toBe(before);
  });

  it("rejects a task field the record cannot name, before any value is applied", () => {
    expect(() =>
      decodeWbsChange({
        format: 1,
        changes: [{ target: "task:t2", field: "notAColumn", after: 1, kind: "direct" }],
      }),
    ).toThrow(WbsChangeCorruptError);
  });

  it("an after-less entry removes the cell instead of storing undefined", () => {
    const next = applyWbsChange(S0, {
      format: 1,
      changes: [{ target: "task:t2", field: "dailyPlan.2026-01-05", before: 480, kind: "direct" }],
    });
    expect(Object.keys(next.tasks.find((task) => task.id === "t2")!.dailyPlan)).toStrictEqual([]);
  });
});

describe("negative controls: the replay check can fail", () => {
  const reorderCommands: ProjectCommand[] = [
    { type: "task.update", taskId: "t3", changes: { sortOrder: 0 } },
    { type: "task.update", taskId: "t2", changes: { sortOrder: 2, parentId: "t1" } },
    { type: "task.update", taskId: "t1", changes: { sortOrder: 1 } },
  ];

  function differsOrThrows(before: ProjectState, after: ProjectState, change: WbsChange): boolean {
    try {
      return canonicalWbsState(applyWbsChange(before, change)) !== canonicalWbsState(after);
    } catch {
      return true;
    }
  }

  it.each([
    ["reorder", reorderCommands],
    ["generate", [GENERATE]],
  ] as const)("dropping any single entry of %s is visible", (_name, commands) => {
    const { after, change } = diffOperation(S0, commands);
    expect(change.changes.length).toBeGreaterThan(0);
    let differing = 0;
    change.changes.forEach((_entry, index) => {
      const mutated = { ...change, changes: change.changes.filter((_e, j) => j !== index) };
      if (differsOrThrows(S0, after, mutated)) differing += 1;
    });
    expect(differing).toBe(change.changes.length);
  });

  it("a changed after value is visible", () => {
    const { after, change } = diffOperation(S0, reorderCommands);
    const mutated: WbsChange = {
      ...change,
      changes: change.changes.map((entry) =>
        entry.target === "task:t3" && entry.field === "sortOrder" ? { ...entry, after: 9 } : entry,
      ),
    };
    expect(canonicalWbsState(applyWbsChange(S0, mutated))).not.toBe(canonicalWbsState(after));
  });

  it("the hash sees a dropped entry", async () => {
    const { after, change } = diffOperation(S0, reorderCommands);
    const dropped = applyWbsChange(S0, { ...change, changes: change.changes.slice(1) });
    expect(await hashWbsState(dropped)).not.toBe(await hashWbsState(after));
  });

  it("the replay helper returns false for a no-op apply and true for the real one", () => {
    const commands: ProjectCommand[] = [{ type: "task.update", taskId: "t2", changes: { name: "New" } }];
    expect(replaysWith((state) => state, S0, commands)).toBe(false);
    expect(replaysWith(applyWbsChange, S0, commands)).toBe(true);
  });
});

describe("creationChange", () => {
  it("replays every row of S0 from the empty state", () => {
    const empty = emptyWbsState(S0.id);
    expect(canonicalWbsState(applyWbsChange(empty, creationChange(S0)))).toBe(canonicalWbsState(S0));
  });
});

describe("readWbsChange", () => {
  it("round-trips absent and null through JSON", () => {
    const absent = diffOperation(S0, [
      { type: "task.update", taskId: "t2", changes: { dailyPlan: { "2026-01-06": 240 } } },
    ]).change;
    const nulls = diffOperation(S0, [{ type: "task.update", taskId: "t2", changes: { processId: "pr1" } }]).change;
    for (const change of [absent, nulls]) {
      expect(readWbsChange(JSON.parse(JSON.stringify(change)))).toStrictEqual(change);
    }
    const readAbsent = readWbsChange(JSON.parse(JSON.stringify(absent)));
    expect(readAbsent.changes.map((entry) => "before" in entry)).toStrictEqual([true, false]);
    const readNull = readWbsChange(JSON.parse(JSON.stringify(nulls)));
    expect("before" in readNull.changes[0]!).toBe(true);
    expect(readNull.changes[0]!.before).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["string", "x"],
    ["array", []],
    ["empty object", {}],
    ["no changes", { format: 1 }],
    ["changes not an array", { format: 1, changes: "no" }],
    ["target not a string", { format: 1, changes: [{ target: 1, field: "", kind: "direct" }] }],
    ["unknown kind", { format: 1, changes: [{ target: "wbs", field: "name", kind: "weird" }] }],
    ["no field", { format: 1, changes: [{ target: "wbs", kind: "direct" }] }],
  ])("rejects garbage: %s", (_name, stored) => {
    expect(() => readWbsChange(stored)).toThrow();
  });

  it.each([
    ["future format", { format: 2, changes: [] }],
    ["format zero", { format: 0, changes: [] }],
    ["format as string", { format: "1", changes: [] }],
  ])("rejects an unknown format: %s", (_name, stored) => {
    expect(() => readWbsChange(stored)).toThrow();
  });

  it("accepts an empty format-1 change", () => {
    expect(readWbsChange({ format: 1, changes: [] })).toStrictEqual({ format: 1, changes: [] });
  });
});
