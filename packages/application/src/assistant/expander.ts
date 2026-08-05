import type { ProjectCommand, ProjectTask } from "../project-state.js";
import { assertCommandsAllowed } from "./allowlist.js";
import type { AssistantIr, AssistantMode, ChatIr, IngestIr } from "./ir.js";

/**
 * IR → `ProjectCommand[]` (Design 0005 §3.2, ADR 0013 Decision 2). Pure
 * TypeScript: no network, no clock, no ambient randomness beyond the injected id
 * factory, so the whole expansion is unit-testable without a model.
 *
 * Everything the model is bad at happens HERE, not there: minting UUIDs,
 * resolving names to ids, assigning `sortOrder`, converting hours to minutes and
 * percent to basis points, and filling the defaults. The model's job is reduced
 * to the one thing it is good at — reading prose.
 */

/** The read-only project facts the expander needs. Both `ProjectState` and the
 * role-projected `ProjectStateView` satisfy it structurally, which is what keeps
 * the expander from ever seeing a field the caller's role may not read. */
export interface AssistantProjectView {
  readonly defaultCalendarId: string;
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly processes: readonly {
    readonly id: string;
    readonly name: string;
    readonly sortOrder: number;
  }[];
  readonly products: readonly {
    readonly id: string;
    readonly name: string;
    readonly sortOrder: number;
  }[];
  readonly templates: readonly { readonly id: string; readonly name: string }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly seq: number;
    readonly name: string;
    readonly sortOrder: number;
  }[];
}

export type UnresolvedKind = "process" | "product" | "member" | "template" | "task" | "parent";
export type UnresolvedReason = "not-found" | "ambiguous" | "missing-field" | "cycle";

/**
 * A reference the expander could not turn into an id. Design 0005 §3.2-1: this is
 * NOT an error. The proposal still goes to the human with the field left at its
 * default and the gap flagged, because "the estimate names a 工程 we don't have
 * yet" is ordinary, and failing the whole import over it would make the feature
 * useless on real documents.
 */
export interface UnresolvedReference {
  readonly kind: UnresolvedKind;
  readonly reference: string;
  readonly reason: UnresolvedReason;
  /** Where in the IR it occurred, e.g. `tasks[3]` — shown next to the proposal. */
  readonly at: string;
}

export interface ExpansionResult {
  readonly commands: readonly ProjectCommand[];
  readonly unresolved: readonly UnresolvedReference[];
}

export interface ExpandOptions {
  /** Injected so tests are deterministic; defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
}

const MINUTES_PER_HOUR = 60;
const BASIS_POINTS_PER_PERCENT = 100;
const MAX_DAILY_CAPACITY_MINUTES = 1_440;

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

/** Index a name→id map, marking a name that occurs twice as ambiguous (id `null`). */
function indexByName(
  entries: readonly { readonly id: string; readonly name: string }[],
): Map<string, string | null> {
  const byName = new Map<string, string | null>();
  for (const entry of entries) {
    const key = entry.name.trim();
    byName.set(key, byName.has(key) ? null : entry.id);
  }
  return byName;
}

function maxSortOrder(entries: readonly { readonly sortOrder: number }[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.sortOrder), -1);
}

/**
 * Defaults for a new task (Design 0005 §3.2-5). Left to the expander rather than
 * the model on purpose: an empty plan a human fills in is honest, whereas a
 * model-invented daily plan reads exactly like a real one.
 */
function newTaskDefaults(): Omit<
  ProjectTask,
  "seq" | "id" | "parentId" | "sortOrder" | "name" | "processId" | "productId" | "assigneeMemberId" | "plannedEffortMinutes"
> {
  return {
    note: "",
    contract: "",
    progressBasisPoints: 0,
    actualEffortMinutes: 0,
    prorationWeightBp: null,
    dailyPlan: {},
    datedActuals: {},
    actualStart: null,
    actualFinish: null,
    dependencies: [],
  };
}

class Resolver {
  readonly unresolved: UnresolvedReference[] = [];

  constructor(
    private readonly processes: Map<string, string | null>,
    private readonly products: Map<string, string | null>,
    private readonly members: Map<string, string | null>,
    private readonly templates: Map<string, string | null>,
  ) {}

  private lookup(
    table: Map<string, string | null>,
    kind: UnresolvedKind,
    reference: string,
    at: string,
  ): string | null {
    const key = reference.trim();
    if (!table.has(key)) {
      this.unresolved.push({ kind, reference: key, reason: "not-found", at });
      return null;
    }
    const id = table.get(key) ?? null;
    if (id === null) {
      this.unresolved.push({ kind, reference: key, reason: "ambiguous", at });
    }
    return id;
  }

  process(reference: string, at: string): string | null {
    return this.lookup(this.processes, "process", reference, at);
  }

  product(reference: string, at: string): string | null {
    return this.lookup(this.products, "product", reference, at);
  }

  member(reference: string, at: string): string | null {
    return this.lookup(this.members, "member", reference, at);
  }

  template(reference: string, at: string): string | null {
    return this.lookup(this.templates, "template", reference, at);
  }

  note(kind: UnresolvedKind, reference: string, reason: UnresolvedReason, at: string): void {
    this.unresolved.push({ kind, reference, reason, at });
  }
}

/** `ProjectTask`'s fields are readonly; the change set is assembled field by field. */
type MutableTaskChanges = {
  -readonly [K in keyof Omit<ProjectTask, "id" | "seq">]?: ProjectTask[K];
};

type IrAddTask = {
  readonly op: "add";
  readonly name: string;
  readonly parent?: string | null | undefined;
  readonly parentSeq?: number | null | undefined;
  readonly process?: string | null | undefined;
  readonly product?: string | null | undefined;
  readonly assignee?: string | null | undefined;
  readonly effortHours?: number | undefined;
  readonly note?: string | undefined;
};

/**
 * Order the proposal's new tasks so a parent is always created before its child.
 * `applyProjectCommand` rejects a task whose parent does not exist yet, and the
 * model has no reason to emit a safe order. A parent link that closes a cycle is
 * dropped (the task becomes a root) and reported, rather than failing the import.
 */
function orderAddsParentFirst(
  adds: readonly { readonly index: number; readonly task: IrAddTask }[],
  parentIndexOf: ReadonlyMap<number, number>,
  onCycle: (index: number, reference: string) => void,
): readonly number[] {
  const ordered: number[] = [];
  const state = new Map<number, "visiting" | "done">();

  const visit = (index: number, stack: readonly number[]): void => {
    const seen = state.get(index);
    if (seen === "done") return;
    if (seen === "visiting") return;
    const parentIndex = parentIndexOf.get(index);
    if (parentIndex !== undefined) {
      if (stack.includes(parentIndex)) {
        onCycle(index, String(parentIndex));
      } else {
        state.set(index, "visiting");
        visit(parentIndex, [...stack, index]);
      }
    }
    state.set(index, "done");
    ordered.push(index);
  };

  for (const { index } of adds) visit(index, [index]);
  return ordered;
}

function expandMasters(
  ir: AssistantIr,
  view: AssistantProjectView,
  newId: () => string,
  processes: Map<string, string | null>,
  products: Map<string, string | null>,
  members: Map<string, string | null>,
  resolver: Resolver,
): ProjectCommand[] {
  const commands: ProjectCommand[] = [];
  let nextProcessSort = maxSortOrder(view.processes) + 1;
  let nextProductSort = maxSortOrder(view.products) + 1;

  (ir.masters ?? []).forEach((master, index) => {
    const at = `masters[${index}]`;
    const name = master.name.trim();
    if (name.length === 0) {
      resolver.note(master.kind, master.name, "missing-field", at);
      return;
    }

    if (master.op === "add") {
      if (master.kind === "process") {
        if (processes.has(name)) return; // already there; nothing to add
        const id = newId();
        processes.set(name, id);
        commands.push({
          type: "process.add",
          process: { id, name, sortOrder: nextProcessSort++ },
        });
        return;
      }
      if (master.kind === "product") {
        if (products.has(name)) return;
        const id = newId();
        products.set(name, id);
        commands.push({
          type: "product.add",
          product: { id, name, sortOrder: nextProductSort++ },
        });
        return;
      }
      // member.add — chat only, and only with a capacity the USER stated. Design
      // 0005 §7.3: the contract makes `calendarId` and `dailyCapacityMinutes`
      // required, so inventing them would be fabrication rather than defaulting.
      // The calendar is not invented either: it resolves to the project default.
      if (members.has(name)) return;
      const hours = "dailyCapacityHours" in master ? master.dailyCapacityHours : undefined;
      if (hours === undefined) {
        resolver.note("member", name, "missing-field", at);
        return;
      }
      const id = newId();
      members.set(name, id);
      commands.push({
        type: "member.add",
        member: {
          id,
          name,
          calendarId: view.defaultCalendarId,
          dailyCapacityMinutes: Math.min(
            MAX_DAILY_CAPACITY_MINUTES,
            Math.max(1, Math.round(hours * MINUTES_PER_HOUR)),
          ),
          // The assistant never sets a rate. A cost rate is commercially
          // sensitive (ADR 0011 Decision 7) and nothing in a third-party CSV
          // establishes one, so a model-supplied figure would be a guess about
          // money — the exact case Design 0005 keeps the model out of.
          costRateMinorPerHour: null,
        },
      });
      return;
    }

    // op === "update" — a rename, and nothing else. The other master fields are
    // absent from the IR by design (§7.2): `dailyCapacityMinutes: 1, costRateMinorPerHour: null` disables a
    // member as effectively as deleting them.
    const newName = master.newName.trim();
    if (newName.length === 0) {
      resolver.note(master.kind, master.newName, "missing-field", at);
      return;
    }
    if (master.kind === "process") {
      const id = resolver.process(name, at);
      if (id !== null) commands.push({ type: "process.update", processId: id, changes: { name: newName } });
      return;
    }
    if (master.kind === "product") {
      const id = resolver.product(name, at);
      if (id !== null) commands.push({ type: "product.update", productId: id, changes: { name: newName } });
      return;
    }
    const id = resolver.member(name, at);
    if (id !== null) commands.push({ type: "member.update", memberId: id, changes: { name: newName } });
  });

  return commands;
}

/**
 * Expand a validated IR. Returns the commands and the references that could not
 * be resolved; throws {@link DisallowedCommandError} only if the expander itself
 * produced a command outside the allowlist, which would be a bug in this file
 * rather than a bad model answer.
 */
export function expandIr(
  mode: AssistantMode,
  ir: AssistantIr,
  view: AssistantProjectView,
  options: ExpandOptions = {},
): ExpansionResult {
  const newId = options.newId ?? defaultNewId;

  const processes = indexByName(view.processes);
  const products = indexByName(view.products);
  const members = indexByName(view.members);
  const templates = indexByName(view.templates);
  const resolver = new Resolver(processes, products, members, templates);

  const taskIdBySeq = new Map<number, string | null>();
  for (const task of view.tasks) {
    taskIdBySeq.set(task.seq, taskIdBySeq.has(task.seq) ? null : task.id);
  }

  const commands: ProjectCommand[] = [
    ...expandMasters(ir, view, newId, processes, products, members, resolver),
  ];

  // New tasks are minted first so a `parent` name can point at a sibling that
  // appears later in the list, then ordered so parents are created first.
  const irTasks = ir.tasks as readonly (
    | IrAddTask
    | ChatIr["tasks"][number]
    | IngestIr["tasks"][number]
  )[];
  const adds: { index: number; task: IrAddTask }[] = [];
  irTasks.forEach((task, index) => {
    if (task.op === "add") adds.push({ index, task: task as IrAddTask });
  });

  const mintedIdByIndex = new Map<number, string>();
  const addIndexByName = new Map<string, number | null>();
  for (const { index, task } of adds) {
    const name = task.name.trim();
    mintedIdByIndex.set(index, newId());
    addIndexByName.set(name, addIndexByName.has(name) ? null : index);
  }

  const parentIndexOf = new Map<number, number>();
  for (const { index, task } of adds) {
    const reference = task.parent;
    if (reference === undefined || reference === null) continue;
    const key = reference.trim();
    if (!addIndexByName.has(key)) {
      resolver.note("parent", key, "not-found", `tasks[${index}]`);
      continue;
    }
    const parentIndex = addIndexByName.get(key) ?? null;
    if (parentIndex === null) {
      resolver.note("parent", key, "ambiguous", `tasks[${index}]`);
      continue;
    }
    if (parentIndex === index) {
      resolver.note("parent", key, "cycle", `tasks[${index}]`);
      continue;
    }
    parentIndexOf.set(index, parentIndex);
  }

  const emissionOrder = orderAddsParentFirst(adds, parentIndexOf, (index, reference) => {
    parentIndexOf.delete(index);
    resolver.note("parent", reference, "cycle", `tasks[${index}]`);
  });

  let nextTaskSort = maxSortOrder(view.tasks) + 1;
  const addByIndex = new Map(adds.map(({ index, task }) => [index, task]));

  for (const index of emissionOrder) {
    const task = addByIndex.get(index);
    if (task === undefined) continue;
    const at = `tasks[${index}]`;
    const name = task.name.trim();
    if (name.length === 0) {
      resolver.note("task", task.name, "missing-field", at);
      continue;
    }

    // A new task's parent is either a sibling in this same proposal (by name) or —
    // chat only — an existing task addressed by `seq`. Either way nothing existing
    // is modified: the link lives on the child being created.
    let parentId: string | null = null;
    const parentIndex = parentIndexOf.get(index);
    if (parentIndex !== undefined) {
      parentId = mintedIdByIndex.get(parentIndex) ?? null;
    } else if (task.parentSeq !== undefined && task.parentSeq !== null) {
      if (!taskIdBySeq.has(task.parentSeq)) {
        resolver.note("parent", String(task.parentSeq), "not-found", at);
      } else {
        parentId = taskIdBySeq.get(task.parentSeq) ?? null;
        if (parentId === null) resolver.note("parent", String(task.parentSeq), "ambiguous", at);
      }
    }

    commands.push({
      type: "task.add",
      task: {
        ...newTaskDefaults(),
        id: mintedIdByIndex.get(index) ?? newId(),
        parentId,
        sortOrder: nextTaskSort++,
        name,
        processId:
          task.process === undefined || task.process === null
            ? null
            : resolver.process(task.process, at),
        productId:
          task.product === undefined || task.product === null
            ? null
            : resolver.product(task.product, at),
        assigneeMemberId:
          task.assignee === undefined || task.assignee === null
            ? null
            : resolver.member(task.assignee, at),
        plannedEffortMinutes: Math.round((task.effortHours ?? 0) * MINUTES_PER_HOUR),
        note: task.note?.trim() ?? "",
      },
    });
  }

  // Updates and template application — chat mode only; the ingest vocabulary
  // cannot express either (ADR 0013 Decision 3).
  irTasks.forEach((task, index) => {
    if (task.op === "add") return;
    const at = `tasks[${index}]`;
    if (!taskIdBySeq.has(task.seq)) {
      resolver.note("task", String(task.seq), "not-found", at);
      return;
    }
    const taskId = taskIdBySeq.get(task.seq) ?? null;
    if (taskId === null) {
      resolver.note("task", String(task.seq), "ambiguous", at);
      return;
    }

    if (task.op === "generateSubtasks") {
      const templateId = resolver.template(task.template, at);
      if (templateId !== null) {
        commands.push({ type: "task.generateSubtasks", parentTaskId: taskId, templateId });
      }
      return;
    }

    // Only the §7.2 fields exist on the IR, so the change set cannot reach
    // structure or actuals. An explicit `null` clears the field; an absent key
    // leaves it alone; a name that fails to resolve leaves it alone AND is
    // reported, because silently clearing an assignee would be a destructive
    // reading of "I couldn't find that person".
    const changes: MutableTaskChanges = {};
    if (task.name !== undefined) {
      const trimmed = task.name.trim();
      if (trimmed.length === 0) resolver.note("task", task.name, "missing-field", at);
      else changes.name = trimmed;
    }
    if (task.process !== undefined) {
      if (task.process === null) changes.processId = null;
      else {
        const id = resolver.process(task.process, at);
        if (id !== null) changes.processId = id;
      }
    }
    if (task.product !== undefined) {
      if (task.product === null) changes.productId = null;
      else {
        const id = resolver.product(task.product, at);
        if (id !== null) changes.productId = id;
      }
    }
    if (task.assignee !== undefined) {
      if (task.assignee === null) changes.assigneeMemberId = null;
      else {
        const id = resolver.member(task.assignee, at);
        if (id !== null) changes.assigneeMemberId = id;
      }
    }
    if (task.effortHours !== undefined) {
      changes.plannedEffortMinutes = Math.round(task.effortHours * MINUTES_PER_HOUR);
    }
    if (task.progressPercent !== undefined) {
      changes.progressBasisPoints = Math.round(task.progressPercent * BASIS_POINTS_PER_PERCENT);
    }
    if (task.note !== undefined) changes.note = task.note.trim();

    // `TaskChangesSchema` requires at least one change; an update whose every
    // field failed to resolve is dropped rather than sent as an empty edit.
    if (Object.keys(changes).length === 0) {
      resolver.note("task", String(task.seq), "missing-field", at);
      return;
    }
    commands.push({ type: "task.update", taskId, changes });
  });

  // Barrier 3 (Design 0005 §7.1), mode-aware. Reached only if this file has a
  // bug — the IR vocabulary already makes a forbidden command unrepresentable —
  // which is precisely why it is here and control-tested.
  assertCommandsAllowed(commands, mode);

  return { commands, unresolved: resolver.unresolved };
}

/** True when the mode's vocabulary forbids touching existing rows (ADR 0013 Decision 3). */
export function isAddOnlyMode(mode: AssistantMode): boolean {
  return mode === "ingest";
}
