import type { ProjectCommand } from "../project-state.js";

/**
 * The approval diff (Design 0005 §5.2, ADR 0013 Decision 5).
 *
 * The IR carries a free-text `summary`, and showing THAT as the diff is the
 * natural implementation — which is exactly why it must not be built. A proposal
 * can rewrite every task's effort while its summary reads "3 タスクを追加しまし
 * た", and approval would then happen on top of a sentence the attacker wrote.
 * Approval is the last barrier; it has to be looking at the commands.
 *
 * So this module derives the diff deterministically from the expanded
 * `ProjectCommand[]` and the current project. It never reads the summary. An
 * `update` always shows before → after, which is also how §7.2's value-erasure
 * (effort to 0, capacity to 1) becomes visible instead of implicit.
 */

export interface DiffTaskRow {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly processId: string | null;
  readonly productId: string | null;
  readonly assigneeMemberId: string | null;
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly note: string;
}

export interface DiffProjectView {
  readonly tasks: readonly DiffTaskRow[];
  readonly processes: readonly { readonly id: string; readonly name: string }[];
  readonly products: readonly { readonly id: string; readonly name: string }[];
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly templates: readonly { readonly id: string; readonly name: string }[];
}

export type DiffOperation = "add" | "update" | "generate";

export interface DiffFieldChange {
  readonly field: string;
  /** `null` for an addition — there is no previous value to show. */
  readonly before: string | null;
  readonly after: string;
}

export interface ProposalDiffEntry {
  readonly commandType: ProjectCommand["type"];
  readonly operation: DiffOperation;
  /** What is being changed, as the human knows it — e.g. `No.17 認証基盤の実装`. */
  readonly target: string;
  readonly changes: readonly DiffFieldChange[];
}

export interface ProposalDiff {
  readonly entries: readonly ProposalDiffEntry[];
  readonly addedTasks: number;
  readonly updatedTasks: number;
  readonly masterChanges: number;
}

const FIELD_LABELS = {
  name: "タスク名",
  process: "工程",
  product: "プロダクト",
  assignee: "担当",
  plannedEffort: "計画工数",
  progress: "進捗",
  note: "備考",
  masterName: "名称",
  capacity: "1日の稼働",
  parent: "親タスク",
} as const;

function formatHours(minutes: number): string {
  const value = minutes / 60;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} h`;
}

function formatPercent(basisPoints: number): string {
  return `${basisPoints / 100} %`;
}

/**
 * Name lookup that also covers masters CREATED BY THIS PROPOSAL — otherwise a
 * task assigned to a brand-new 工程 would render as a raw UUID, and the reviewer
 * would have no way to check the thing they are approving.
 */
function buildNameTable(view: DiffProjectView, commands: readonly ProjectCommand[]) {
  const processes = new Map(view.processes.map((entry) => [entry.id, entry.name]));
  const products = new Map(view.products.map((entry) => [entry.id, entry.name]));
  const members = new Map(view.members.map((entry) => [entry.id, entry.name]));
  const templates = new Map(view.templates.map((entry) => [entry.id, entry.name]));
  const tasks = new Map(view.tasks.map((task) => [task.id, task]));
  const newTaskNames = new Map<string, string>();

  for (const command of commands) {
    if (command.type === "process.add") processes.set(command.process.id, command.process.name);
    else if (command.type === "product.add") products.set(command.product.id, command.product.name);
    else if (command.type === "member.add") members.set(command.member.id, command.member.name);
    else if (command.type === "task.add") newTaskNames.set(command.task.id, command.task.name);
  }
  return { processes, products, members, templates, tasks, newTaskNames };
}

type NameTable = ReturnType<typeof buildNameTable>;

function nameOr(table: ReadonlyMap<string, string>, id: string | null, fallback = "(未設定)"): string {
  if (id === null) return fallback;
  return table.get(id) ?? "(不明)";
}

function taskLabel(table: NameTable, taskId: string): string {
  const existing = table.tasks.get(taskId);
  if (existing !== undefined) return `No.${existing.seq} ${existing.name}`;
  const created = table.newTaskNames.get(taskId);
  return created === undefined ? "(不明なタスク)" : `新規 ${created}`;
}

function addEntry(command: Extract<ProjectCommand, { type: "task.add" }>, table: NameTable): ProposalDiffEntry {
  const task = command.task;
  const changes: DiffFieldChange[] = [
    { field: FIELD_LABELS.name, before: null, after: task.name },
    { field: FIELD_LABELS.process, before: null, after: nameOr(table.processes, task.processId) },
    { field: FIELD_LABELS.product, before: null, after: nameOr(table.products, task.productId) },
    { field: FIELD_LABELS.assignee, before: null, after: nameOr(table.members, task.assigneeMemberId) },
    { field: FIELD_LABELS.plannedEffort, before: null, after: formatHours(task.plannedEffortMinutes) },
  ];
  if (task.parentId !== null) {
    changes.push({ field: FIELD_LABELS.parent, before: null, after: taskLabel(table, task.parentId) });
  }
  if (task.note.length > 0) {
    changes.push({ field: FIELD_LABELS.note, before: null, after: task.note });
  }
  return { commandType: command.type, operation: "add", target: `新規タスク ${task.name}`, changes };
}

function updateEntry(
  command: Extract<ProjectCommand, { type: "task.update" }>,
  table: NameTable,
): ProposalDiffEntry {
  const current = table.tasks.get(command.taskId);
  const changes: DiffFieldChange[] = [];
  const { changes: edit } = command;

  if (edit.name !== undefined) {
    changes.push({ field: FIELD_LABELS.name, before: current?.name ?? "(不明)", after: edit.name });
  }
  if (edit.processId !== undefined) {
    changes.push({
      field: FIELD_LABELS.process,
      before: nameOr(table.processes, current?.processId ?? null),
      after: nameOr(table.processes, edit.processId),
    });
  }
  if (edit.productId !== undefined) {
    changes.push({
      field: FIELD_LABELS.product,
      before: nameOr(table.products, current?.productId ?? null),
      after: nameOr(table.products, edit.productId),
    });
  }
  if (edit.assigneeMemberId !== undefined) {
    changes.push({
      field: FIELD_LABELS.assignee,
      before: nameOr(table.members, current?.assigneeMemberId ?? null),
      after: nameOr(table.members, edit.assigneeMemberId),
    });
  }
  if (edit.plannedEffortMinutes !== undefined) {
    changes.push({
      field: FIELD_LABELS.plannedEffort,
      before: current === undefined ? "(不明)" : formatHours(current.plannedEffortMinutes),
      after: formatHours(edit.plannedEffortMinutes),
    });
  }
  if (edit.progressBasisPoints !== undefined) {
    changes.push({
      field: FIELD_LABELS.progress,
      before: current === undefined ? "(不明)" : formatPercent(current.progressBasisPoints),
      after: formatPercent(edit.progressBasisPoints),
    });
  }
  if (edit.note !== undefined) {
    changes.push({ field: FIELD_LABELS.note, before: current?.note ?? "(不明)", after: edit.note });
  }
  return {
    commandType: command.type,
    operation: "update",
    target: taskLabel(table, command.taskId),
    changes,
  };
}

/**
 * Build the approval diff. `summary` is not a parameter, which is the point: the
 * caller CANNOT accidentally let the model's prose flow into this output.
 */
export function buildProposalDiff(
  commands: readonly ProjectCommand[],
  view: DiffProjectView,
): ProposalDiff {
  const table = buildNameTable(view, commands);
  const entries: ProposalDiffEntry[] = [];
  let addedTasks = 0;
  let updatedTasks = 0;
  let masterChanges = 0;

  for (const command of commands) {
    if (command.type === "task.add") {
      entries.push(addEntry(command, table));
      addedTasks += 1;
    } else if (command.type === "task.update") {
      entries.push(updateEntry(command, table));
      updatedTasks += 1;
    } else if (command.type === "task.generateSubtasks") {
      entries.push({
        commandType: command.type,
        operation: "generate",
        target: taskLabel(table, command.parentTaskId),
        changes: [
          {
            field: "テンプレート適用",
            before: null,
            after: nameOr(table.templates, command.templateId),
          },
        ],
      });
    } else if (command.type === "process.add" || command.type === "product.add") {
      const master = command.type === "process.add" ? command.process : command.product;
      const kind = command.type === "process.add" ? "工程" : "プロダクト";
      entries.push({
        commandType: command.type,
        operation: "add",
        target: `新規${kind} ${master.name}`,
        changes: [{ field: FIELD_LABELS.masterName, before: null, after: master.name }],
      });
      masterChanges += 1;
    } else if (command.type === "member.add") {
      entries.push({
        commandType: command.type,
        operation: "add",
        target: `新規メンバー ${command.member.name}`,
        changes: [
          { field: FIELD_LABELS.masterName, before: null, after: command.member.name },
          {
            field: FIELD_LABELS.capacity,
            before: null,
            after: formatHours(command.member.dailyCapacityMinutes),
          },
        ],
      });
      masterChanges += 1;
    } else if (
      command.type === "process.update" ||
      command.type === "product.update" ||
      command.type === "member.update"
    ) {
      const table_ =
        command.type === "process.update"
          ? table.processes
          : command.type === "product.update"
            ? table.products
            : table.members;
      const id =
        command.type === "process.update"
          ? command.processId
          : command.type === "product.update"
            ? command.productId
            : command.memberId;
      const before = nameOr(table_, id);
      entries.push({
        commandType: command.type,
        operation: "update",
        target: before,
        changes: [{ field: FIELD_LABELS.masterName, before, after: command.changes.name ?? before }],
      });
      masterChanges += 1;
    }
  }

  return { entries, addedTasks, updatedTasks, masterChanges };
}
