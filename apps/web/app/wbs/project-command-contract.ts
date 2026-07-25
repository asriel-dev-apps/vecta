import type { DependencyType, ProjectCommand, ProjectTask } from "@vecta/application";
import { z } from "zod";

export const UuidSchema = z.string().uuid();
// The revision is a Postgres int64 (bigint) rendered as a decimal string; int64's
// max (9223372036854775807) is 19 digits, so 20 chars caps it with a digit of
// slack while rejecting an unbounded-length numeric string at the boundary.
export const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20);

const IsoDateSchema = z.iso.date();
const MetaTextSchema = z.string().max(2_000);
const EffortMinutesSchema = z.number().int().min(0).max(100_000_000);
const ProgressBasisPointsSchema = z.number().int().min(0).max(10_000);
const ProrationWeightSchema = z.number().int().min(0).max(10_000).nullable();
const SortOrderSchema = z.number().int().min(0);
const CalendarIdSchema = z.string().trim().min(1).max(100);

const DependencySchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int().min(0).max(3_650),
});

// A task's per-day planned minutes, keyed by ISO date. Capped at ~10 years of
// distinct days (365 * 10 ≈ 3,660) so a single task can't smuggle an unbounded
// map through the contract; a real plan spans weeks or months, never a decade.
const DAILY_PLAN_MAX_ENTRIES = 3_660;
const DailyPlanSchema = z
  .record(IsoDateSchema, z.number().nonnegative())
  .refine(
    (plan) => Object.keys(plan).length <= DAILY_PLAN_MAX_ENTRIES,
    `Daily plan may not exceed ${DAILY_PLAN_MAX_ENTRIES} entries`,
  );

const TaskFieldsSchema = z.object({
  parentId: UuidSchema.nullable(),
  sortOrder: SortOrderSchema,
  name: z.string().trim().min(1).max(2_000),
  processId: UuidSchema.nullable(),
  productId: UuidSchema.nullable(),
  note: MetaTextSchema,
  contract: MetaTextSchema,
  assigneeMemberId: UuidSchema.nullable(),
  plannedEffortMinutes: EffortMinutesSchema,
  progressBasisPoints: ProgressBasisPointsSchema,
  actualEffortMinutes: EffortMinutesSchema,
  prorationWeightBp: ProrationWeightSchema,
  dailyPlan: DailyPlanSchema,
  actualStart: IsoDateSchema.nullable(),
  actualFinish: IsoDateSchema.nullable(),
  dependencies: z.array(DependencySchema).max(200),
});

export const TaskSchema = TaskFieldsSchema.extend({ id: UuidSchema }).strict();

export const TaskChangesSchema = TaskFieldsSchema.partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const MemberSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  calendarId: CalendarIdSchema,
  dailyCapacityMinutes: z.number().int().min(1).max(1_440),
}).strict();

export const MemberChangesSchema = MemberSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const ProcessSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  sortOrder: SortOrderSchema,
}).strict();

export const ProcessChangesSchema = ProcessSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const ProductSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  sortOrder: SortOrderSchema,
}).strict();

export const ProductChangesSchema = ProductSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

// A subtask template's ordered steps (Design 0003 §E-1). The step-array shape is
// validated here at the contract boundary (not via DB checks): a name, a
// basis-point weight, and — for steps after the first — an optional dependency on
// the preceding step (absent = the step runs in parallel).
const SubtaskStepSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    weightBp: z.number().int().min(0).max(10_000),
    dependsOnPrev: z
      .object({
        type: z.enum(["FS", "SS", "FF", "SF"]),
        lagWorkingDays: z.number().int().min(0).max(3_650),
      })
      .optional(),
  })
  .strict();

export const TemplateSchema = z
  .object({
    id: UuidSchema,
    name: z.string().trim().min(1).max(200),
    sortOrder: SortOrderSchema,
    subtasks: z.array(SubtaskStepSchema).max(200),
  })
  .strict();

export const TemplateChangesSchema = TemplateSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const ApiCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.add"), task: TaskSchema }),
  z.object({ type: z.literal("task.update"), taskId: UuidSchema, changes: TaskChangesSchema }),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }),
  z.object({
    type: z.literal("task.generateSubtasks"),
    parentTaskId: UuidSchema,
    templateId: UuidSchema,
  }),
  z.object({ type: z.literal("member.add"), member: MemberSchema }),
  z.object({ type: z.literal("member.update"), memberId: UuidSchema, changes: MemberChangesSchema }),
  z.object({ type: z.literal("member.delete"), memberId: UuidSchema }),
  z.object({ type: z.literal("process.add"), process: ProcessSchema }),
  z.object({ type: z.literal("process.update"), processId: UuidSchema, changes: ProcessChangesSchema }),
  z.object({ type: z.literal("process.delete"), processId: UuidSchema }),
  z.object({ type: z.literal("product.add"), product: ProductSchema }),
  z.object({ type: z.literal("product.update"), productId: UuidSchema, changes: ProductChangesSchema }),
  z.object({ type: z.literal("product.delete"), productId: UuidSchema }),
  z.object({ type: z.literal("template.add"), template: TemplateSchema }),
  z.object({ type: z.literal("template.update"), templateId: UuidSchema, changes: TemplateChangesSchema }),
  z.object({ type: z.literal("template.delete"), templateId: UuidSchema }),
]);

// ADR 0012 Step 4b — the write-path batch envelope. The client posts a whole
// multi-command edit (e.g. a sibling reorder = several `task.update`s) as ONE
// action request; the route action chains their revisions server-side. Each
// entry carries a client-generated idempotency key (mirrors the SPA's
// per-command `crypto.randomUUID()`), so a replayed POST dedupes through the
// command receipts. `expectedRevision` is the confirmed revision the batch is
// applied on top of (string on the wire, `bigint` once parsed).
export const CommandEntrySchema = z
  .object({
    command: ApiCommandSchema,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

// The largest single user gesture emits one command per task it touches; the
// worst case is a full sibling-group reorder (`reorderSiblingCommands` renumbers a
// whole sibling group), and the biggest such group in a realistic tree — even the
// SSR stress project's 500 root siblings — stays under this bound. 1,000 covers
// that comfortably while rejecting a payload that could only be a bug or abuse
// (down from the original 5,000, which was sized to the whole-project task cap and
// would fan a pathological batch out into thousands of DB transactions).
const MAX_COMMANDS_PER_BATCH = 1_000;

export const CommandBatchSchema = z
  .object({
    expectedRevision: RevisionSchema,
    commands: z.array(CommandEntrySchema).min(1).max(MAX_COMMANDS_PER_BATCH),
  })
  .strict()
  // Each command carries a client-minted idempotency key; a duplicate within one
  // batch would make the second command replay the first's receipt instead of
  // executing, silently dropping an edit. Reject the batch at the boundary.
  .refine((batch) => {
    const keys = batch.commands.map((entry) => entry.idempotencyKey);
    return new Set(keys).size === keys.length;
  }, "Duplicate idempotency key within one batch");

// The wire never carries `seq`: the display No. is assigned server-side from the
// project counter (§F-1), so the command task omits it.
function toTask(task: z.infer<typeof TaskSchema>): Omit<ProjectTask, "seq"> {
  return {
    id: task.id,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    name: task.name,
    processId: task.processId,
    productId: task.productId,
    note: task.note,
    contract: task.contract,
    assigneeMemberId: task.assigneeMemberId,
    plannedEffortMinutes: task.plannedEffortMinutes,
    progressBasisPoints: task.progressBasisPoints,
    actualEffortMinutes: task.actualEffortMinutes,
    prorationWeightBp: task.prorationWeightBp,
    dailyPlan: { ...task.dailyPlan },
    actualStart: task.actualStart,
    actualFinish: task.actualFinish,
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
  };
}

function toTaskChanges(
  changes: z.infer<typeof TaskChangesSchema>,
): Partial<Omit<ProjectTask, "id">> {
  return {
    ...(changes.parentId === undefined ? {} : { parentId: changes.parentId }),
    ...(changes.sortOrder === undefined ? {} : { sortOrder: changes.sortOrder }),
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.processId === undefined ? {} : { processId: changes.processId }),
    ...(changes.productId === undefined ? {} : { productId: changes.productId }),
    ...(changes.note === undefined ? {} : { note: changes.note }),
    ...(changes.contract === undefined ? {} : { contract: changes.contract }),
    ...(changes.assigneeMemberId === undefined
      ? {}
      : { assigneeMemberId: changes.assigneeMemberId }),
    ...(changes.plannedEffortMinutes === undefined
      ? {}
      : { plannedEffortMinutes: changes.plannedEffortMinutes }),
    ...(changes.progressBasisPoints === undefined
      ? {}
      : { progressBasisPoints: changes.progressBasisPoints }),
    ...(changes.actualEffortMinutes === undefined
      ? {}
      : { actualEffortMinutes: changes.actualEffortMinutes }),
    ...(changes.prorationWeightBp === undefined
      ? {}
      : { prorationWeightBp: changes.prorationWeightBp }),
    ...(changes.dailyPlan === undefined ? {} : { dailyPlan: { ...changes.dailyPlan } }),
    ...(changes.actualStart === undefined ? {} : { actualStart: changes.actualStart }),
    ...(changes.actualFinish === undefined ? {} : { actualFinish: changes.actualFinish }),
    ...(changes.dependencies === undefined
      ? {}
      : { dependencies: changes.dependencies.map((dependency) => ({ ...dependency })) }),
  };
}

// The template payload has the same shape on the wire and in the domain, so one
// set of deep-clones serves both `toCommand` and `fromCommand`. These input types
// accept both directions: `readonly` (domain) and mutable (wire) arrays, and an
// optional `dependsOnPrev` with or without an explicit `undefined`.
interface TemplateStepInput {
  readonly name: string;
  readonly weightBp: number;
  readonly dependsOnPrev?: { readonly type: DependencyType; readonly lagWorkingDays: number } | undefined;
}
interface TemplateInput {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtasks: readonly TemplateStepInput[];
}
interface TemplateChangesInput {
  readonly name?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly subtasks?: readonly TemplateStepInput[] | undefined;
}

function cloneTemplateStep(step: TemplateStepInput) {
  return {
    name: step.name,
    weightBp: step.weightBp,
    ...(step.dependsOnPrev === undefined ? {} : { dependsOnPrev: { ...step.dependsOnPrev } }),
  };
}

function cloneTemplate(template: TemplateInput) {
  return {
    id: template.id,
    name: template.name,
    sortOrder: template.sortOrder,
    subtasks: template.subtasks.map(cloneTemplateStep),
  };
}

function cloneTemplateChanges(changes: TemplateChangesInput) {
  return {
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.sortOrder === undefined ? {} : { sortOrder: changes.sortOrder }),
    ...(changes.subtasks === undefined
      ? {}
      : { subtasks: changes.subtasks.map(cloneTemplateStep) }),
  };
}

export function toCommand(command: z.infer<typeof ApiCommandSchema>): ProjectCommand {
  if (command.type === "task.add") {
    return { type: command.type, task: toTask(command.task) };
  }
  if (command.type === "task.update") {
    return { type: command.type, taskId: command.taskId, changes: toTaskChanges(command.changes) };
  }
  if (command.type === "task.delete") {
    return command;
  }
  if (command.type === "task.generateSubtasks") {
    return { type: command.type, parentTaskId: command.parentTaskId, templateId: command.templateId };
  }
  if (command.type === "member.add") {
    return { type: command.type, member: { ...command.member } };
  }
  if (command.type === "member.update") {
    return {
      type: command.type,
      memberId: command.memberId,
      changes: {
        ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
        ...(command.changes.calendarId === undefined
          ? {}
          : { calendarId: command.changes.calendarId }),
        ...(command.changes.dailyCapacityMinutes === undefined
          ? {}
          : { dailyCapacityMinutes: command.changes.dailyCapacityMinutes }),
      },
    };
  }
  if (command.type === "process.add") {
    return { type: command.type, process: { ...command.process } };
  }
  if (command.type === "process.update") {
    return {
      type: command.type,
      processId: command.processId,
      changes: {
        ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
        ...(command.changes.sortOrder === undefined
          ? {}
          : { sortOrder: command.changes.sortOrder }),
      },
    };
  }
  if (command.type === "product.add") {
    return { type: command.type, product: { ...command.product } };
  }
  if (command.type === "product.update") {
    return {
      type: command.type,
      productId: command.productId,
      changes: {
        ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
        ...(command.changes.sortOrder === undefined
          ? {}
          : { sortOrder: command.changes.sortOrder }),
      },
    };
  }
  if (command.type === "template.add") {
    return { type: command.type, template: cloneTemplate(command.template) };
  }
  if (command.type === "template.update") {
    return {
      type: command.type,
      templateId: command.templateId,
      changes: cloneTemplateChanges(command.changes),
    };
  }
  return command;
}

function fromTask(task: Omit<ProjectTask, "seq">): z.infer<typeof TaskSchema> {
  return {
    id: task.id,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    name: task.name,
    processId: task.processId,
    productId: task.productId,
    note: task.note,
    contract: task.contract,
    assigneeMemberId: task.assigneeMemberId,
    plannedEffortMinutes: task.plannedEffortMinutes,
    progressBasisPoints: task.progressBasisPoints,
    actualEffortMinutes: task.actualEffortMinutes,
    prorationWeightBp: task.prorationWeightBp,
    dailyPlan: { ...task.dailyPlan },
    actualStart: task.actualStart,
    actualFinish: task.actualFinish,
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
  };
}

function fromTaskChanges(
  changes: Partial<Omit<ProjectTask, "id">>,
): z.infer<typeof TaskChangesSchema> {
  return {
    ...(changes.parentId === undefined ? {} : { parentId: changes.parentId }),
    ...(changes.sortOrder === undefined ? {} : { sortOrder: changes.sortOrder }),
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.processId === undefined ? {} : { processId: changes.processId }),
    ...(changes.productId === undefined ? {} : { productId: changes.productId }),
    ...(changes.note === undefined ? {} : { note: changes.note }),
    ...(changes.contract === undefined ? {} : { contract: changes.contract }),
    ...(changes.assigneeMemberId === undefined
      ? {}
      : { assigneeMemberId: changes.assigneeMemberId }),
    ...(changes.plannedEffortMinutes === undefined
      ? {}
      : { plannedEffortMinutes: changes.plannedEffortMinutes }),
    ...(changes.progressBasisPoints === undefined
      ? {}
      : { progressBasisPoints: changes.progressBasisPoints }),
    ...(changes.actualEffortMinutes === undefined
      ? {}
      : { actualEffortMinutes: changes.actualEffortMinutes }),
    ...(changes.prorationWeightBp === undefined
      ? {}
      : { prorationWeightBp: changes.prorationWeightBp }),
    ...(changes.dailyPlan === undefined ? {} : { dailyPlan: { ...changes.dailyPlan } }),
    ...(changes.actualStart === undefined ? {} : { actualStart: changes.actualStart }),
    ...(changes.actualFinish === undefined ? {} : { actualFinish: changes.actualFinish }),
    ...(changes.dependencies === undefined
      ? {}
      : { dependencies: changes.dependencies.map((dependency) => ({ ...dependency })) }),
  };
}

export function fromCommand(command: ProjectCommand): z.infer<typeof ApiCommandSchema> {
  if (command.type === "task.add") {
    return { type: command.type, task: fromTask(command.task) };
  }
  if (command.type === "task.update") {
    return {
      type: command.type,
      taskId: command.taskId,
      changes: fromTaskChanges(command.changes),
    };
  }
  if (command.type === "task.delete") {
    return command;
  }
  if (command.type === "task.generateSubtasks") {
    return { type: command.type, parentTaskId: command.parentTaskId, templateId: command.templateId };
  }
  if (command.type === "member.add") {
    return { type: command.type, member: { ...command.member } };
  }
  if (command.type === "member.update") {
    return {
      type: command.type,
      memberId: command.memberId,
      changes: { ...command.changes },
    };
  }
  if (command.type === "process.add") {
    return { type: command.type, process: { ...command.process } };
  }
  if (command.type === "process.update") {
    return {
      type: command.type,
      processId: command.processId,
      changes: { ...command.changes },
    };
  }
  if (command.type === "product.add") {
    return { type: command.type, product: { ...command.product } };
  }
  if (command.type === "product.update") {
    return {
      type: command.type,
      productId: command.productId,
      changes: { ...command.changes },
    };
  }
  if (command.type === "template.add") {
    return { type: command.type, template: cloneTemplate(command.template) };
  }
  if (command.type === "template.update") {
    return {
      type: command.type,
      templateId: command.templateId,
      changes: cloneTemplateChanges(command.changes),
    };
  }
  return command;
}
