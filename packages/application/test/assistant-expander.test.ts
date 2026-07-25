import { describe, expect, it } from "vitest";
import {
  ALLOWED_COMMAND_TYPES,
  ALLOWED_COMMAND_TYPES_BY_MODE,
  DisallowedCommandError,
  FORBIDDEN_COMMAND_TYPES,
  applyProjectCommand,
  assertCommandsAllowed,
  expandIr,
  parseIr,
  type AssistantProjectView,
  type ProjectCommand,
  type ProjectState,
} from "../src/index.js";

/** Deterministic ids, so an expansion can be asserted field by field. */
function sequentialIds(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

const view: AssistantProjectView = {
  defaultCalendarId: "standard",
  members: [
    { id: "member-1", name: "Member 01" },
    { id: "member-2", name: "Member 02" },
  ],
  processes: [
    { id: "process-1", name: "設計", sortOrder: 0 },
    { id: "process-2", name: "テスト", sortOrder: 1 },
  ],
  products: [{ id: "product-1", name: "認証", sortOrder: 0 }],
  templates: [{ id: "template-1", name: "標準3ステップ" }],
  tasks: [
    { id: "task-1", seq: 17, name: "既存タスク", sortOrder: 4 },
    { id: "task-2", seq: 18, name: "もう一つ", sortOrder: 9 },
  ],
};

function expand(mode: "ingest" | "chat", raw: unknown) {
  const parsed = parseIr(mode, raw);
  if (!parsed.ok) throw new Error(`IR did not parse: ${parsed.issues.join("; ")}`);
  return expandIr(mode, parsed.ir, view, { newId: sequentialIds() });
}

describe("expander — the model's hours and names become the contract's minutes and ids", () => {
  it("mints ids, orders tasks after the existing ones, and converts the units", () => {
    const result = expand("ingest", {
      summary: "見積書から",
      tasks: [
        { op: "add", name: "認証基盤の実装", process: "設計", product: "認証", effortHours: 40 },
        { op: "add", name: "OIDC 疎通試験", parent: "認証基盤の実装", process: "テスト", effortHours: 7.5 },
      ],
    });

    expect(result.unresolved).toEqual([]);
    const [first, second] = result.commands as [
      Extract<ProjectCommand, { type: "task.add" }>,
      Extract<ProjectCommand, { type: "task.add" }>,
    ];
    expect(first.task.name).toBe("認証基盤の実装");
    expect(first.task.processId).toBe("process-1");
    expect(first.task.productId).toBe("product-1");
    // 40 h → 2,400 min, and a fractional 7.5 h → 450 min. The model never sees minutes.
    expect(first.task.plannedEffortMinutes).toBe(2_400);
    expect(second.task.plannedEffortMinutes).toBe(450);
    // sortOrder continues past the project's highest (9), in IR order.
    expect(first.task.sortOrder).toBe(10);
    expect(second.task.sortOrder).toBe(11);
    expect(second.task.parentId).toBe(first.task.id);
    // Defaults are the expander's, not the model's (Design 0005 §3.2-5).
    expect(first.task.dailyPlan).toEqual({});
    expect(first.task.dependencies).toEqual([]);
    expect(first.task.progressBasisPoints).toBe(0);
    expect(first.task.actualStart).toBeNull();
  });

  it("creates a parent before its child even when the IR lists them the other way", () => {
    const result = expand("ingest", {
      summary: "",
      tasks: [
        { op: "add", name: "子", parent: "親" },
        { op: "add", name: "親" },
      ],
    });
    const names = result.commands.map((command) =>
      command.type === "task.add" ? command.task.name : command.type,
    );
    expect(names).toEqual(["親", "子"]);
  });

  it("converts percent to basis points on an update", () => {
    const result = expand("chat", {
      summary: "",
      tasks: [{ op: "update", seq: 17, progressPercent: 50 }],
    });
    expect(result.commands).toEqual([
      { type: "task.update", taskId: "task-1", changes: { progressBasisPoints: 5_000 } },
    ]);
  });

  it("applies a template to an existing task by seq", () => {
    const result = expand("chat", {
      summary: "",
      tasks: [{ op: "generateSubtasks", seq: 18, template: "標準3ステップ" }],
    });
    expect(result.commands).toEqual([
      { type: "task.generateSubtasks", parentTaskId: "task-2", templateId: "template-1" },
    ]);
  });

  it("adds a member with the project's calendar and the capacity the user gave", () => {
    const result = expand("chat", {
      summary: "",
      tasks: [],
      masters: [{ kind: "member", op: "add", name: "Member 07", dailyCapacityHours: 7.5 }],
    });
    expect(result.commands).toEqual([
      {
        type: "member.add",
        member: {
          id: "00000000-0000-4000-8000-000000000000",
          name: "Member 07",
          calendarId: "standard",
          dailyCapacityMinutes: 450,
        },
      },
    ]);
  });
});

describe("expander — an unresolvable name is flagged, never guessed (A3)", () => {
  it("leaves the field at its default and reports the gap", () => {
    const result = expand("ingest", {
      summary: "",
      tasks: [{ op: "add", name: "新タスク", process: "存在しない工程" }],
    });
    const [command] = result.commands as [Extract<ProjectCommand, { type: "task.add" }>];
    expect(command.task.processId).toBeNull();
    expect(result.unresolved).toEqual([
      { kind: "process", reference: "存在しない工程", reason: "not-found", at: "tasks[0]" },
    ]);
  });

  it("binds a name to a master added in the same proposal", () => {
    const result = expand("ingest", {
      summary: "",
      tasks: [{ op: "add", name: "新タスク", process: "受入" }],
      masters: [{ kind: "process", op: "add", name: "受入" }],
    });
    expect(result.unresolved).toEqual([]);
    const add = result.commands.find((command) => command.type === "task.add");
    const master = result.commands.find((command) => command.type === "process.add");
    expect(add?.type === "task.add" && add.task.processId).toBe(
      master?.type === "process.add" ? master.process.id : undefined,
    );
  });

  it("does NOT clear an existing value when an update's name fails to resolve", () => {
    // Reading "I could not find that person" as "unassign them" would make a
    // lookup failure destructive.
    const result = expand("chat", {
      summary: "",
      tasks: [{ op: "update", seq: 17, assignee: "いない人", progressPercent: 10 }],
    });
    expect(result.commands).toEqual([
      { type: "task.update", taskId: "task-1", changes: { progressBasisPoints: 1_000 } },
    ]);
    expect(result.unresolved[0]?.kind).toBe("member");
  });

  it("emits no command at all when every field of an update failed to resolve", () => {
    const result = expand("chat", {
      summary: "",
      tasks: [{ op: "update", seq: 17, assignee: "いない人" }],
    });
    expect(result.commands).toEqual([]);
  });

  it("flags an unknown seq instead of updating some other task", () => {
    const result = expand("chat", { summary: "", tasks: [{ op: "update", seq: 999, name: "x" }] });
    expect(result.commands).toEqual([]);
    expect(result.unresolved).toEqual([
      { kind: "task", reference: "999", reason: "not-found", at: "tasks[0]" },
    ]);
  });

  it("refuses to add a member when the capacity was never stated", () => {
    const result = expand("chat", {
      summary: "",
      tasks: [],
      masters: [{ kind: "member", op: "add", name: "Member 07" }],
    });
    expect(result.commands).toEqual([]);
    expect(result.unresolved).toEqual([
      { kind: "member", reference: "Member 07", reason: "missing-field", at: "masters[0]" },
    ]);
  });
});

describe("allowlist — the control the guard needs (A2)", () => {
  // Without these two, an allowlist that had stopped checking would look
  // identical to one that keeps passing.
  it.each(FORBIDDEN_COMMAND_TYPES)("rejects a command list containing %s", (type) => {
    const command = { type, taskId: "task-1", memberId: "m", processId: "p", productId: "d", templateId: "t" } as unknown as ProjectCommand;
    expect(() => assertCommandsAllowed([command], "chat")).toThrow(DisallowedCommandError);
  });

  it("rejects template.update — a subtasks:[] is a delete wearing an update's clothes", () => {
    const command = {
      type: "template.update",
      templateId: "template-1",
      changes: { subtasks: [] },
    } as ProjectCommand;
    expect(() => assertCommandsAllowed([command], "chat")).toThrow(DisallowedCommandError);
  });

  it("accepts the nine the expander can emit", () => {
    expect([...ALLOWED_COMMAND_TYPES].sort()).toEqual(
      [
        "member.add",
        "member.update",
        "process.add",
        "process.update",
        "product.add",
        "product.update",
        "task.add",
        "task.generateSubtasks",
        "task.update",
      ].sort(),
    );
  });

  it("narrows ingest mode to the three that cannot touch an existing row", () => {
    expect([...ALLOWED_COMMAND_TYPES_BY_MODE.ingest].sort()).toEqual([
      "process.add",
      "product.add",
      "task.add",
    ]);
    const update: ProjectCommand = {
      type: "task.update",
      taskId: "task-1",
      changes: { name: "x" },
    };
    expect(() => assertCommandsAllowed([update], "ingest")).toThrow(DisallowedCommandError);
    expect(() => assertCommandsAllowed([update], "chat")).not.toThrow();
  });
});

describe("expander — the expansion is a valid project edit (A1, domain half)", () => {
  const project: ProjectState = {
    id: "project-1",
    name: "Effort WBS",
    projectStart: "2026-01-05",
    statusDate: "2026-01-13",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      { id: "standard", name: "標準", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
    ],
    members: [{ id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 }],
    processes: [{ id: "process-1", name: "設計", sortOrder: 0 }],
    products: [{ id: "product-1", name: "認証", sortOrder: 0 }],
    templates: [],
    tasks: [],
    nextTaskSeq: 1,
  };
  const projectView: AssistantProjectView = {
    defaultCalendarId: project.defaultCalendarId,
    members: project.members,
    processes: project.processes,
    products: project.products,
    templates: project.templates,
    tasks: [],
  };

  it("produces commands the command core accepts, in the order it accepts them", () => {
    const parsed = parseIr("ingest", {
      summary: "",
      tasks: [
        { op: "add", name: "親", process: "設計", assignee: "Member 01", effortHours: 10 },
        { op: "add", name: "子", parent: "親", process: "受入", effortHours: 4 },
      ],
      masters: [{ kind: "process", op: "add", name: "受入" }],
    });
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    const { commands } = expandIr("ingest", parsed.ir, projectView, { newId: sequentialIds() });

    // Applying the whole batch through the real command core is the strongest
    // available statement that the expansion is well-formed: it runs the same
    // referential and hierarchy validation a human edit does.
    const next = commands.reduce(applyProjectCommand, project);
    expect(next.tasks).toHaveLength(2);
    expect(next.processes).toHaveLength(2);
    expect(next.tasks[1]?.parentId).toBe(next.tasks[0]?.id);
    // The display No. is assigned by the core, never by the model or the expander.
    expect(next.tasks.map((task) => task.seq)).toEqual([1, 2]);
  });
});
