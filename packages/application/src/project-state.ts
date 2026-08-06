import type { DependencyType } from "@vecta/domain";
import {
  datedActualKey,
  datedActualTotalMinutes,
  parseDatedActualKey,
  replaceDatedActualPartitions,
  touchesDatedActualPartitions,
  type DatedActualEntry,
  type DatedActualKeyParts,
} from "./dated-actuals.js";
import {
  deriveSubtaskId,
  prorateLargestRemainder,
  type SubtaskTemplate,
} from "./subtask-templates.js";

export type { DependencyType, SubtaskTemplate, DatedActualEntry };

export interface ProjectCalendar {
  readonly id: string;
  readonly name: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface ProjectMember {
  readonly id: string;
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
  /**
   * Cost rate in the project's currency's minor unit, per PERSON-HOUR, or `null`
   * when none has been recorded (Design 0010).
   *
   * `null` is not zero, and the difference is the whole point: a zero rate would
   * make a member's work cost nothing and be summed silently, while `null` means
   * "not known" and takes that member's leaves OUT of the money aggregate with a
   * visible count. Same failure shape as the empty daily plot in Design 0009 §3.1.
   *
   * SENSITIVE (ADR 0011 Decision 7). It is removed from the GENERAL read model at
   * the structure level by `stripSensitiveMemberFields`, so a viewer never
   * receives the key at all.
   */
  readonly costRateMinorPerHour: number | null;
}

/** Project-scoped 工程 master (name-only). Supplies the grid's 工程 dropdown. */
export interface ProjectProcess {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

/** Project-scoped プロダクト master (name-only). Supplies the grid's プロダクト dropdown. */
export interface ProjectProduct {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface ProjectDependency {
  readonly predecessorId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface ProjectTask {
  readonly id: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  /**
   * Immutable per-project display No. (Design 0003 §F-1). Assigned from the
   * project's {@link ProjectState.nextTaskSeq} at creation and never renumbered
   * on reorder or delete (gaps are allowed). Tasks and subtasks share the one
   * per-project counter. The internal key stays {@link ProjectTask.id}; `seq` is
   * a display number only.
   */
  readonly seq: number;
  readonly name: string;
  readonly processId: string | null;
  readonly productId: string | null;
  readonly note: string;
  readonly contract: string;
  readonly assigneeMemberId: string | null;
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly actualEffortMinutes: number;
  /**
   * Basis-point proration weight (0–10000) for a template-generated subtask, or
   * null for an ordinary task. When set, the task's planned effort is derived
   * from its parent's planned effort and kept in sync by re-proration.
   */
  readonly prorationWeightBp: number | null;
  readonly dailyPlan: Readonly<Record<string, number>>;
  /**
   * Dated expended effort (Design 0011): `"YYYY-MM-DD|<memberId>"` → person-minutes.
   *
   * The actuals side's `dailyPlan`. Empty for every task that has never been
   * imported — which is all of production — and while it is empty this task's AC
   * behaves exactly as before. When it has entries,
   * {@link ProjectTask.actualEffortMinutes} is their sum, maintained by the
   * import; see `dated-actuals.ts` for why the detail lives in the state.
   */
  readonly datedActuals: Readonly<Record<string, number>>;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
  readonly dependencies: readonly ProjectDependency[];
}

export interface ProjectState {
  readonly id: string;
  readonly name: string;
  readonly projectStart: string;
  readonly statusDate: string;
  readonly currency: "JPY";
  readonly defaultCalendarId: string;
  readonly calendars: readonly ProjectCalendar[];
  readonly members: readonly ProjectMember[];
  readonly processes: readonly ProjectProcess[];
  readonly products: readonly ProjectProduct[];
  readonly templates: readonly SubtaskTemplate[];
  readonly tasks: readonly ProjectTask[];
  /**
   * Next per-project display No. to hand out (Design 0003 §F-1). A task.add or
   * each task.generateSubtasks child takes this value as its `seq`; the counter
   * then advances by the number of tasks created, so a batch of N consumes N
   * numbers and a delete never rewinds it (gaps persist).
   */
  readonly nextTaskSeq: number;
  /**
   * Next baseline version to hand out (Design 0009). Same shape and the same
   * reasoning as `nextTaskSeq`: a counter advanced inside the command's own
   * transaction rather than a database sequence.
   */
  readonly nextBaselineVersion: number;
}

/**
 * Ids of the tasks that are leaves — tasks no other task names as its parent.
 * Non-leaf tasks are summary rows: the effort EVM rollup and the scheduler treat
 * them as aggregators that carry no own effort, so they are neither summed nor
 * placed. Single source of the "leaf" definition (ADR 0011 Decision 5/⑤).
 */
export function leafTaskIds(tasks: readonly ProjectTask[]): ReadonlySet<string> {
  const parentIds = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null) parentIds.add(task.parentId);
  }
  return new Set(tasks.filter((task) => !parentIds.has(task.id)).map((task) => task.id));
}

export interface AddTaskCommand {
  readonly type: "task.add";
  // The client never supplies `seq`: the display No. is assigned server-side from
  // the project's counter (Design 0003 §F-1). `applyProjectCommand` fills it in.
  readonly task: Omit<ProjectTask, "seq">;
}

export interface UpdateTaskCommand {
  readonly type: "task.update";
  readonly taskId: string;
  // `seq` is immutable (Design 0003 §F-1), so it can never be a change target.
  readonly changes: Partial<Omit<ProjectTask, "id" | "seq">>;
}

export interface DeleteTaskCommand {
  readonly type: "task.delete";
  readonly taskId: string;
}

export interface GenerateSubtasksCommand {
  readonly type: "task.generateSubtasks";
  readonly parentTaskId: string;
  readonly templateId: string;
}

export interface AddMemberCommand {
  readonly type: "member.add";
  readonly member: ProjectMember;
}

export interface UpdateMemberCommand {
  readonly type: "member.update";
  readonly memberId: string;
  readonly changes: Partial<Omit<ProjectMember, "id">>;
}

export interface DeleteMemberCommand {
  readonly type: "member.delete";
  readonly memberId: string;
}

export interface AddProcessCommand {
  readonly type: "process.add";
  readonly process: ProjectProcess;
}

export interface UpdateProcessCommand {
  readonly type: "process.update";
  readonly processId: string;
  readonly changes: Partial<Omit<ProjectProcess, "id">>;
}

export interface DeleteProcessCommand {
  readonly type: "process.delete";
  readonly processId: string;
}

export interface AddProductCommand {
  readonly type: "product.add";
  readonly product: ProjectProduct;
}

export interface UpdateProductCommand {
  readonly type: "product.update";
  readonly productId: string;
  readonly changes: Partial<Omit<ProjectProduct, "id">>;
}

export interface DeleteProductCommand {
  readonly type: "product.delete";
  readonly productId: string;
}

export interface AddTemplateCommand {
  readonly type: "template.add";
  readonly template: SubtaskTemplate;
}

export interface UpdateTemplateCommand {
  readonly type: "template.update";
  readonly templateId: string;
  readonly changes: Partial<Omit<SubtaskTemplate, "id">>;
}

export interface DeleteTemplateCommand {
  readonly type: "template.delete";
  readonly templateId: string;
}

/**
 * Freeze the current plan as an approved baseline (Design 0009).
 *
 * It is a ProjectCommand rather than a separate endpoint so that it inherits the
 * revision pin, the idempotency receipt and the audit actor unchanged — the same
 * reasoning that kept the assistant off a second write path. The STATE transition
 * is only the counter; the snapshot rows are written by the unit of work in the
 * same transaction, from the state this command was applied to.
 *
 * `acknowledgeUnplottedTasks` exists because BAC and PV come from the daily plot,
 * not from the estimate (measured 2026-08-05): a task with an estimate and an
 * empty plot contributes ZERO, and freezing that bakes the hole in permanently —
 * every later SV is that much kinder. Publishing such a plan is allowed, but not
 * by accident.
 */
export interface PublishBaselineCommand {
  readonly type: "baseline.publish";
  /**
   * Set only after a human has been shown the count of leaves whose plot is empty
   * or disagrees with their estimate. Absent or false with such leaves present is
   * rejected.
   */
  readonly acknowledgeUnplottedTasks?: boolean;
}

/**
 * Import dated actuals from a timesheet (Design 0011).
 *
 * The entries are ALREADY resolved to task and member ids: the CSV, its header
 * names and every rejection live in `timesheet-import.ts`, which runs before a
 * command exists. This command is therefore about data, not about a file — the
 * same reason `task.update` carries values rather than keystrokes.
 *
 * The replacement unit is one person's one day, computed across the whole batch
 * and applied to EVERY task. It has to be project-wide: if a corrected file moves
 * someone's Tuesday from task X to task Y, X's row for that person-day must go,
 * and X is not in the file.
 */
export interface ImportActualsCommand {
  readonly type: "actuals.import";
  readonly entries: readonly DatedActualEntry[];
}

export type ProjectCommand =
  | PublishBaselineCommand
  | ImportActualsCommand
  | AddTaskCommand
  | UpdateTaskCommand
  | DeleteTaskCommand
  | GenerateSubtasksCommand
  | AddMemberCommand
  | UpdateMemberCommand
  | DeleteMemberCommand
  | AddProcessCommand
  | UpdateProcessCommand
  | DeleteProcessCommand
  | AddProductCommand
  | UpdateProductCommand
  | DeleteProductCommand
  | AddTemplateCommand
  | UpdateTemplateCommand
  | DeleteTemplateCommand;

const DEPENDENCY_TYPES: ReadonlySet<DependencyType> = new Set(["FS", "SS", "FF", "SF"]);

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateWholeNonNegative(value: number, message: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }
}

function validateMembers(project: ProjectState): void {
  const calendarIds = new Set(project.calendars.map((calendar) => calendar.id));
  const memberIds = new Set<string>();
  for (const member of project.members) {
    if (member.id.trim().length === 0 || memberIds.has(member.id)) {
      throw new Error(`Member ID must be unique: ${member.id}`);
    }
    memberIds.add(member.id);
    if (member.name.trim().length === 0) {
      throw new Error(`Member ${member.id} requires a name`);
    }
    if (!calendarIds.has(member.calendarId)) {
      throw new Error(`Member ${member.id} references an unknown calendar: ${member.calendarId}`);
    }
    if (
      !Number.isInteger(member.dailyCapacityMinutes) ||
      member.dailyCapacityMinutes < 1 ||
      member.dailyCapacityMinutes > 1_440
    ) {
      throw new Error(`Member ${member.id} daily capacity must be a whole number from 1 to 1440`);
    }
    // Minor units, so a whole number — money must not carry a binary fraction
    // into a sum (Design 0010 §2). `null` is "not recorded" and is allowed.
    if (
      member.costRateMinorPerHour !== null &&
      (!Number.isInteger(member.costRateMinorPerHour) || member.costRateMinorPerHour < 0)
    ) {
      throw new Error(`Member ${member.id} cost rate must be a whole non-negative amount`);
    }
  }
}

function validateProcesses(project: ProjectState): void {
  const processIds = new Set<string>();
  for (const process of project.processes) {
    if (process.id.trim().length === 0 || processIds.has(process.id)) {
      throw new Error(`Process ID must be unique: ${process.id}`);
    }
    processIds.add(process.id);
    if (process.name.trim().length === 0) {
      throw new Error(`Process ${process.id} requires a name`);
    }
    validateWholeNonNegative(
      process.sortOrder,
      `Process ${process.id} sort order must be a whole number >= 0`,
    );
  }
}

function validateProducts(project: ProjectState): void {
  const productIds = new Set<string>();
  for (const product of project.products) {
    if (product.id.trim().length === 0 || productIds.has(product.id)) {
      throw new Error(`Product ID must be unique: ${product.id}`);
    }
    productIds.add(product.id);
    if (product.name.trim().length === 0) {
      throw new Error(`Product ${product.id} requires a name`);
    }
    validateWholeNonNegative(
      product.sortOrder,
      `Product ${product.id} sort order must be a whole number >= 0`,
    );
  }
}

function validateTemplates(project: ProjectState): void {
  const templateIds = new Set<string>();
  for (const template of project.templates) {
    if (template.id.trim().length === 0 || templateIds.has(template.id)) {
      throw new Error(`Template ID must be unique: ${template.id}`);
    }
    templateIds.add(template.id);
    if (template.name.trim().length === 0) {
      throw new Error(`Template ${template.id} requires a name`);
    }
    validateWholeNonNegative(
      template.sortOrder,
      `Template ${template.id} sort order must be a whole number >= 0`,
    );
    template.subtasks.forEach((step, index) => {
      if (step.name.trim().length === 0) {
        throw new Error(`Template ${template.id} step ${index} requires a name`);
      }
      if (!Number.isInteger(step.weightBp) || step.weightBp < 0 || step.weightBp > 10_000) {
        throw new Error(
          `Template ${template.id} step ${index} weight must be whole basis points from 0 to 10000`,
        );
      }
      if (step.dependsOnPrev !== undefined) {
        if (!DEPENDENCY_TYPES.has(step.dependsOnPrev.type)) {
          throw new Error(
            `Template ${template.id} step ${index} has an invalid dependency type: ${step.dependsOnPrev.type}`,
          );
        }
        validateWholeNonNegative(
          step.dependsOnPrev.lagWorkingDays,
          `Template ${template.id} step ${index} dependency lag must be a whole number >= 0`,
        );
      }
    });
  }
}

function validateParentHierarchy(project: ProjectState, taskIds: ReadonlySet<string>): void {
  const parentById = new Map(project.tasks.map((task) => [task.id, task.parentId]));
  for (const task of project.tasks) {
    if (task.parentId === null) continue;
    if (task.parentId === task.id) {
      throw new Error(`Task ${task.id} cannot be its own parent`);
    }
    if (!taskIds.has(task.parentId)) {
      throw new Error(`Unknown parent task: ${task.parentId}`);
    }
    const visited = new Set<string>([task.id]);
    let parentId: string | null = task.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new Error("Task hierarchy contains a cycle");
      }
      visited.add(parentId);
      parentId = parentById.get(parentId) ?? null;
    }
  }
}

function validateProject(project: ProjectState): void {
  if (!Number.isInteger(project.nextTaskSeq) || project.nextTaskSeq < 1) {
    throw new Error("Project next display number must be a whole number >= 1");
  }
  validateMembers(project);
  validateProcesses(project);
  validateProducts(project);
  validateTemplates(project);
  const memberIds = new Set(project.members.map((member) => member.id));
  const processIds = new Set(project.processes.map((process) => process.id));
  const productIds = new Set(project.products.map((product) => product.id));

  const taskIds = new Set<string>();
  for (const task of project.tasks) {
    if (task.id.trim().length === 0 || taskIds.has(task.id)) {
      throw new Error(`Task ID must be unique: ${task.id}`);
    }
    taskIds.add(task.id);
  }

  for (const task of project.tasks) {
    if (task.name.trim().length === 0) {
      throw new Error(`Task ${task.id} requires a name`);
    }
    if (!Number.isInteger(task.seq) || task.seq < 1) {
      throw new Error(`Task ${task.id} display number must be a whole number >= 1`);
    }
    validateWholeNonNegative(task.sortOrder, `Task ${task.id} sort order must be a whole number >= 0`);
    validateWholeNonNegative(
      task.plannedEffortMinutes,
      `Task ${task.id} planned effort must be whole minutes >= 0`,
    );
    validateWholeNonNegative(
      task.actualEffortMinutes,
      `Task ${task.id} actual effort must be whole minutes >= 0`,
    );
    if (
      !Number.isInteger(task.progressBasisPoints) ||
      task.progressBasisPoints < 0 ||
      task.progressBasisPoints > 10_000
    ) {
      throw new Error(`Task ${task.id} progress must be whole basis points from 0 to 10000`);
    }
    if (
      task.prorationWeightBp !== null &&
      (!Number.isInteger(task.prorationWeightBp) ||
        task.prorationWeightBp < 0 ||
        task.prorationWeightBp > 10_000)
    ) {
      throw new Error(`Task ${task.id} proration weight must be whole basis points from 0 to 10000`);
    }
    if (task.assigneeMemberId !== null && !memberIds.has(task.assigneeMemberId)) {
      throw new Error(`Task ${task.id} references an unknown member: ${task.assigneeMemberId}`);
    }
    if (task.processId !== null && !processIds.has(task.processId)) {
      throw new Error(`Task ${task.id} references an unknown process: ${task.processId}`);
    }
    if (task.productId !== null && !productIds.has(task.productId)) {
      throw new Error(`Task ${task.id} references an unknown product: ${task.productId}`);
    }
    for (const [date, value] of Object.entries(task.dailyPlan)) {
      if (!isIsoDate(date)) {
        throw new Error(`Task ${task.id} daily plan has an invalid date: ${date}`);
      }
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Task ${task.id} daily plan values must be finite and >= 0`);
      }
    }
    // Dated actuals (Design 0011). Validated the same way as `dailyPlan` — same
    // shape, same reasons — plus the one thing the map alone cannot carry: its
    // key must decode to a real date and a member of THIS project.
    //
    // Deliberately NOT validated: that the entries sum to column W. The import
    // sets them equal, but W is an Input column of the reference spreadsheet
    // (Design 0002 §2), and making it conditionally read-only would be exactly
    // the kind of unrequested behaviour change Design 0003 §B-1 exists to
    // forbid. A later hand edit is allowed to disagree, and the grid flags it —
    // the same treatment the existing `estimateVsDailyMismatch` gives L vs Σ
    // daily, which is the same situation one column to the left.
    for (const [key, value] of Object.entries(task.datedActuals)) {
      const parts = parseDatedActualKey(key);
      if (parts === null || !isIsoDate(parts.workDate) || !memberIds.has(parts.memberId)) {
        throw new Error(`Task ${task.id} dated actuals have an invalid key: ${key}`);
      }
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Task ${task.id} dated actuals must be whole minutes >= 0`);
      }
    }
    if (task.actualStart !== null && !isIsoDate(task.actualStart)) {
      throw new Error(`Task ${task.id} has an invalid actual start`);
    }
    if (task.actualFinish !== null && !isIsoDate(task.actualFinish)) {
      throw new Error(`Task ${task.id} has an invalid actual finish`);
    }
    if (
      task.actualStart !== null &&
      task.actualFinish !== null &&
      task.actualFinish < task.actualStart
    ) {
      throw new Error(`Task ${task.id} actual finish must not precede its actual start`);
    }

    const seenEdges = new Set<string>();
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency.predecessorId)) {
        throw new Error(`Task ${task.id} depends on an unknown task: ${dependency.predecessorId}`);
      }
      if (dependency.predecessorId === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
      if (!DEPENDENCY_TYPES.has(dependency.type)) {
        throw new Error(`Task ${task.id} has an invalid dependency type: ${dependency.type}`);
      }
      validateWholeNonNegative(
        dependency.lagWorkingDays,
        `Task ${task.id} dependency lag must be a whole number >= 0`,
      );
      const edge = `${dependency.predecessorId}\u0000${dependency.type}`;
      if (seenEdges.has(edge)) {
        throw new Error(`Task ${task.id} has a duplicate dependency edge`);
      }
      seenEdges.add(edge);
    }
  }

  validateParentHierarchy(project, taskIds);
}

/**
 * Build the subtask rows for `task.generateSubtasks`. Each subtask inherits the
 * parent's assignee, carries the template's basis-point weight, and (for every
 * subtask after the first) depends on the immediately-preceding subtask with the
 * template's relationship and lag. Planned effort is left at 0 here and filled in
 * by re-proration, which is the single source of the parent → child split.
 */
function generateSubtaskTasks(
  state: ProjectState,
  command: GenerateSubtasksCommand,
): Omit<ProjectTask, "seq">[] {
  const parent = state.tasks.find((task) => task.id === command.parentTaskId);
  if (parent === undefined) {
    throw new Error(`Unknown parent task: ${command.parentTaskId}`);
  }
  // Resolve the template from the project-scoped master (Design 0003 §E-1); this
  // is the generate-time validation now that templates are DB state, not builtin.
  const template = state.templates.find((entry) => entry.id === command.templateId);
  if (template === undefined) {
    throw new Error(`Unknown subtask template: ${command.templateId}`);
  }

  const baseSortOrder =
    state.tasks.reduce((max, task) => Math.max(max, task.sortOrder), -1) + 1;
  const childIds = template.subtasks.map((_step, index) =>
    deriveSubtaskId(parent.id, index),
  );

  return template.subtasks.map((step, index): Omit<ProjectTask, "seq"> => ({
    id: childIds[index]!,
    parentId: parent.id,
    sortOrder: baseSortOrder + index,
    name: step.name,
    processId: null,
    productId: null,
    note: "",
    contract: "",
    assigneeMemberId: parent.assigneeMemberId,
    plannedEffortMinutes: 0,
    progressBasisPoints: 0,
    actualEffortMinutes: 0,
    prorationWeightBp: step.weightBp,
    dailyPlan: {},
    datedActuals: {},
    actualStart: null,
    actualFinish: null,
    dependencies:
      index === 0 || step.dependsOnPrev === undefined
        ? []
        : [
            {
              predecessorId: childIds[index - 1]!,
              type: step.dependsOnPrev.type,
              lagWorkingDays: step.dependsOnPrev.lagWorkingDays,
            },
          ],
  }));
}

/**
 * Deterministic re-proration hook. For every parent that has weighted children
 * (tasks with a non-null `prorationWeightBp`), redistribute the parent's planned
 * effort across those children by largest-remainder so Σ(children) = parent L is
 * held exactly. Children are ordered by (sortOrder, id) so the remainder split is
 * independent of array order. This runs after the command is applied and before
 * the scheduler, so it covers parent-effort edits, child-weight edits, and fresh
 * template generation uniformly and idempotently.
 */
function reprorateSubtasks(tasks: readonly ProjectTask[]): readonly ProjectTask[] {
  const childrenByParent = new Map<string, ProjectTask[]>();
  for (const task of tasks) {
    if (task.prorationWeightBp === null || task.parentId === null) continue;
    const group = childrenByParent.get(task.parentId) ?? [];
    group.push(task);
    childrenByParent.set(task.parentId, group);
  }
  if (childrenByParent.size === 0) return tasks;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const effortById = new Map<string, number>();
  for (const [parentId, children] of childrenByParent) {
    const parent = taskById.get(parentId);
    if (parent === undefined) continue; // orphaned weighted child; leave untouched
    const ordered = [...children].sort(
      (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
    );
    const shares = prorateLargestRemainder(
      parent.plannedEffortMinutes,
      ordered.map((child) => child.prorationWeightBp ?? 0),
    );
    ordered.forEach((child, index) => effortById.set(child.id, shares[index]!));
  }

  return tasks.map((task) => {
    const effort = effortById.get(task.id);
    return effort === undefined || effort === task.plannedEffortMinutes
      ? task
      : { ...task, plannedEffortMinutes: effort };
  });
}

/**
 * Leaf tasks whose daily plot would freeze a budget that is not the one the
 * estimate claims — either empty, or disagreeing with `plannedEffortMinutes`.
 *
 * Measured 2026-08-05: BAC and PV are Σ dailyPlan, and `plannedEffortMinutes`
 * never reaches either. A leaf with a 480-minute estimate and an empty plot is
 * worth ZERO to the baseline, so freezing it makes every later SV kinder by that
 * amount, permanently and invisibly. Summary rows are excluded because they do
 * not roll up at all.
 */
export function unplottedLeafTasks(state: ProjectState): readonly ProjectTask[] {
  // The SAME leaf predicate the rollup uses, called rather than copied. It was
  // written out by hand here at first and agreed by transcription; a transcribed
  // agreement is one edit away from a baseline BAC that disagrees with the
  // rollup's, and nothing would say which is right.
  const leaves = leafTaskIds(state.tasks);
  return state.tasks.filter((task) => {
    if (!leaves.has(task.id)) return false;
    const plotted = Object.values(task.dailyPlan).reduce((sum, value) => sum + value, 0);
    // Disagreement is the whole test. An earlier version also flagged any plot
    // summing to zero, which is a false positive on a legitimate leaf: a task
    // estimated at 0 minutes, plotted or not, is worth 0 to the baseline either
    // way and hides nothing. Daily-plan validation permits zero-valued days, so
    // `{ "2026-08-05": 0 }` against an estimate of 0 is valid input that would
    // have raised the acknowledgement prompt for no reason — and a prompt that
    // cries wolf is how the real case gets waved through.
    return plotted !== task.plannedEffortMinutes;
  });
}

export function applyProjectCommand(
  state: ProjectState,
  command: ProjectCommand,
): ProjectState {
  let next: ProjectState;
  if (command.type === "baseline.publish") {
    // The state transition is ONLY the counter. The snapshot rows are written by
    // the unit of work, in the same transaction, from the state this was applied
    // to — so the frozen plan and the revision it is pinned to cannot disagree.
    const unplotted = unplottedLeafTasks(state);
    if (unplotted.length > 0 && command.acknowledgeUnplottedTasks !== true) {
      throw new Error(
        `Cannot publish a baseline while ${unplotted.length} leaf task(s) have an empty or ` +
          "inconsistent daily plot: they would be frozen at zero budget. " +
          "Acknowledge them explicitly to publish anyway.",
      );
    }
    next = { ...state, nextBaselineVersion: state.nextBaselineVersion + 1 };
  } else if (command.type === "actuals.import") {
    // Design 0011. Two passes over the tasks, and the order matters:
    //
    //   1. the replacement partitions are collected across the WHOLE batch, so
    //      moving someone's Tuesday from task X to task Y clears X even though X
    //      never appears in the file;
    //   2. every task then has those partitions cleared and its own entries
    //      written, and its column W is re-derived from what is left.
    //
    // W is re-derived only for tasks that HAD or NOW HAVE dated rows. Touching
    // every task would overwrite the hand-entered actuals of tasks this import
    // says nothing about — the entire project, on the first import.
    const leaves = leafTaskIds(state.tasks);
    const taskById = new Map(state.tasks.map((task) => [task.id, task]));
    const memberIds = new Set(state.members.map((member) => member.id));
    for (const entry of command.entries) {
      const task = taskById.get(entry.taskId);
      if (task === undefined) {
        throw new Error(`Actuals import references an unknown task: ${entry.taskId}`);
      }
      if (!leaves.has(entry.taskId)) {
        // A summary row's effort is carried by its children, so actuals on one
        // would be counted twice by every rollup (ADR 0011 Decision 5).
        throw new Error(`Actuals import targets a summary task: ${entry.taskId}`);
      }
      if (!memberIds.has(entry.memberId)) {
        throw new Error(`Actuals import references an unknown member: ${entry.memberId}`);
      }
      if (!isIsoDate(entry.workDate)) {
        throw new Error(`Actuals import has an invalid date: ${entry.workDate}`);
      }
      validateWholeNonNegative(
        entry.actualMinutes,
        `Actuals import minutes must be whole and >= 0: ${entry.workDate}`,
      );
    }

    const partitions: DatedActualKeyParts[] = [];
    const seenPartitions = new Set<string>();
    const entriesByTask = new Map<string, DatedActualEntry[]>();
    for (const entry of command.entries) {
      // Through `datedActualKey`, not a hand-built template. Two encodings of the
      // same key agree only by transcription, which is what `dated-actuals.ts`
      // exists to prevent — and this file already imports from it.
      const partition = datedActualKey(entry.workDate, entry.memberId);
      if (!seenPartitions.has(partition)) {
        seenPartitions.add(partition);
        partitions.push({ workDate: entry.workDate, memberId: entry.memberId });
      }
      const forTask = entriesByTask.get(entry.taskId);
      if (forTask === undefined) entriesByTask.set(entry.taskId, [entry]);
      else forTask.push(entry);
    }

    next = {
      ...state,
      tasks: state.tasks.map((task) => {
        const mine = entriesByTask.get(task.id) ?? [];
        // "Already has dated actuals" is the WRONG test, and using it overwrote a
        // hand edit on a task the import never mentioned (found by review,
        // 2026-08-06). The affected set is what Design 0011 §4 says: tasks with
        // rows inside a REPLACED partition, plus tasks named in the file. A task
        // imported in March is untouched by an import of April.
        if (mine.length === 0 && !touchesDatedActualPartitions(task.datedActuals, partitions)) {
          return task;
        }
        const datedActuals = replaceDatedActualPartitions(task.datedActuals, partitions, mine);
        return {
          ...task,
          datedActuals,
          actualEffortMinutes: datedActualTotalMinutes(datedActuals),
        };
      }),
    };
  } else if (command.type === "task.add") {
    // Assign the immutable display No. from the project counter, then advance it
    // (Design 0003 §F-1). Server-authoritative: any client-supplied value is
    // impossible (AddTaskCommand.task omits `seq`), and the optimistic client
    // runs this same path against its local counter for a provisional No.
    next = {
      ...state,
      tasks: [...state.tasks, { ...command.task, seq: state.nextTaskSeq }],
      nextTaskSeq: state.nextTaskSeq + 1,
    };
  } else if (command.type === "task.delete") {
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      tasks: state.tasks
        .filter((task) => task.id !== command.taskId)
        .map((task) =>
          task.parentId === command.taskId ? { ...task, parentId: null } : task,
        ),
    };
  } else if (command.type === "task.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Task update requires at least one change");
    }
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === command.taskId ? { ...task, ...command.changes } : task,
      ),
    };
  } else if (command.type === "task.generateSubtasks") {
    // Each generated child draws the next display No. from the shared per-project
    // counter (tasks and subtasks are one sequence); the counter advances by the
    // number of children, so the batch consumes that many numbers (Design §F-1).
    let seq = state.nextTaskSeq;
    const children = generateSubtaskTasks(state, command).map((child): ProjectTask => ({
      ...child,
      seq: seq++,
    }));
    next = { ...state, tasks: [...state.tasks, ...children], nextTaskSeq: seq };
  } else if (command.type === "member.add") {
    next = { ...state, members: [...state.members, command.member] };
  } else if (command.type === "member.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Member update requires at least one change");
    }
    if (!state.members.some((member) => member.id === command.memberId)) {
      throw new Error(`Unknown member: ${command.memberId}`);
    }
    next = {
      ...state,
      members: state.members.map((member) =>
        member.id === command.memberId ? { ...member, ...command.changes } : member,
      ),
    };
  } else if (command.type === "member.delete") {
    if (!state.members.some((member) => member.id === command.memberId)) {
      throw new Error(`Unknown member: ${command.memberId}`);
    }
    if (state.tasks.some((task) => task.assigneeMemberId === command.memberId)) {
      throw new Error(`Member ${command.memberId} is assigned to a task`);
    }
    // Imported actuals reference the member by id, and validation requires every
    // dated-actual key to name a live member — so without this the delete failed
    // deep inside `validateProject` with an internal key string as the message,
    // and there was no way to clear the rows either (found by review, 2026-08-06).
    // Refusing here, in the same shape as the assignee guard, is what Design 0011
    // §3 already chose for the equivalent foreign key: restrict, not cascade.
    if (
      state.tasks.some((task) =>
        Object.keys(task.datedActuals).some(
          (key) => parseDatedActualKey(key)?.memberId === command.memberId,
        ),
      )
    ) {
      throw new Error(`Member ${command.memberId} has imported actuals`);
    }
    next = {
      ...state,
      members: state.members.filter((member) => member.id !== command.memberId),
    };
  } else if (command.type === "process.add") {
    next = { ...state, processes: [...state.processes, command.process] };
  } else if (command.type === "process.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Process update requires at least one change");
    }
    if (!state.processes.some((process) => process.id === command.processId)) {
      throw new Error(`Unknown process: ${command.processId}`);
    }
    next = {
      ...state,
      processes: state.processes.map((process) =>
        process.id === command.processId ? { ...process, ...command.changes } : process,
      ),
    };
  } else if (command.type === "process.delete") {
    if (!state.processes.some((process) => process.id === command.processId)) {
      throw new Error(`Unknown process: ${command.processId}`);
    }
    if (state.tasks.some((task) => task.processId === command.processId)) {
      throw new Error(`Process ${command.processId} is used by a task`);
    }
    next = {
      ...state,
      processes: state.processes.filter((process) => process.id !== command.processId),
    };
  } else if (command.type === "product.add") {
    next = { ...state, products: [...state.products, command.product] };
  } else if (command.type === "product.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Product update requires at least one change");
    }
    if (!state.products.some((product) => product.id === command.productId)) {
      throw new Error(`Unknown product: ${command.productId}`);
    }
    next = {
      ...state,
      products: state.products.map((product) =>
        product.id === command.productId ? { ...product, ...command.changes } : product,
      ),
    };
  } else if (command.type === "product.delete") {
    if (!state.products.some((product) => product.id === command.productId)) {
      throw new Error(`Unknown product: ${command.productId}`);
    }
    if (state.tasks.some((task) => task.productId === command.productId)) {
      throw new Error(`Product ${command.productId} is used by a task`);
    }
    next = {
      ...state,
      products: state.products.filter((product) => product.id !== command.productId),
    };
  } else if (command.type === "template.add") {
    next = { ...state, templates: [...state.templates, command.template] };
  } else if (command.type === "template.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Template update requires at least one change");
    }
    if (!state.templates.some((template) => template.id === command.templateId)) {
      throw new Error(`Unknown template: ${command.templateId}`);
    }
    next = {
      ...state,
      templates: state.templates.map((template) =>
        template.id === command.templateId ? { ...template, ...command.changes } : template,
      ),
    };
  } else {
    // template.delete — a generated task copies its template's step data (no
    // template FK is stored on a task), so a delete never orphans a task and
    // needs no referential guard (Design 0003 §E-1 locked decision 4).
    if (!state.templates.some((template) => template.id === command.templateId)) {
      throw new Error(`Unknown template: ${command.templateId}`);
    }
    next = {
      ...state,
      templates: state.templates.filter((template) => template.id !== command.templateId),
    };
  }
  next = { ...next, tasks: reprorateSubtasks(next.tasks) };
  validateProject(next);
  return next;
}
