import type {
  AuditEventRecord,
  MemberRecord,
  PersistedProjectRecord,
  ProcessRecord,
  ProductRecord,
  ProjectCalendarRecord,
  SubtaskTemplateStepRecord,
  TaskDependencyRecord,
  TaskRecord,
  TemplateRecord,
} from "./project-record.js";

// Deterministic synthetic fixtures. All labels are generic and anonymized
// ("Phase A", "Product 1", "Member 01"); no client/vendor/product/contract
// names and no real values appear here or in generated data. The reference
// worksheet under .wbs-private/ is never read.

export interface SeedProjectOptions {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly parentCount?: number;
  readonly subtasksPerParent?: number;
  readonly memberCount?: number;
  readonly seed?: number;
}

/** mulberry32 — a small, deterministic PRNG. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeUuid(prefix: string, sequence: number): string {
  return `${prefix}0000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)]!;
}

const PHASE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PER_DAY_MINUTES = [60, 120, 180, 240, 300, 360, 420, 480] as const;

// The two default subtask templates every project starts with (Design 0003 §E-1;
// the former builtin catalog). Generic PM steps; weights are basis points summing
// to 10000 so a freshly generated parent's children reproduce its planned effort.
const DEFAULT_SUBTASK_TEMPLATES: readonly {
  readonly name: string;
  readonly subtasks: readonly SubtaskTemplateStepRecord[];
}[] = [
  {
    name: "Standard build",
    subtasks: [
      { name: "Design", weightBp: 2_000 },
      { name: "Review", weightBp: 1_000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
      { name: "Rework", weightBp: 1_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
      { name: "Build", weightBp: 4_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
      { name: "Test", weightBp: 2_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
    ],
  },
  {
    name: "Design and review",
    subtasks: [
      { name: "Design", weightBp: 7_000 },
      { name: "Review", weightBp: 3_000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
    ],
  },
];

function buildWorkingDays(start: string, count: number): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function createSeedProjectRecord(
  options: SeedProjectOptions = {},
): PersistedProjectRecord {
  const tenantId = options.tenantId ?? makeUuid("a", 1);
  const projectId = options.projectId ?? makeUuid("b", 1);
  const parentCount = options.parentCount ?? 24;
  const subtasksPerParent = options.subtasksPerParent ?? 8;
  const memberCount = options.memberCount ?? 12;
  const random = createRandom(options.seed ?? 0x5eed);

  const projectStart = "2026-01-05"; // a Monday
  const horizon = 260;
  const workingDays = buildWorkingDays(projectStart, horizon);
  const statusDate = workingDays[130]!;

  const calendars: readonly ProjectCalendarRecord[] = [
    {
      tenantId,
      projectId,
      id: "standard",
      name: "Standard working week",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: [],
    },
  ];

  const members: MemberRecord[] = Array.from({ length: memberCount }, (_, index) => ({
    id: makeUuid("c", index + 1),
    tenantId,
    projectId,
    name: `Member ${(index + 1).toString().padStart(2, "0")}`,
    calendarId: "standard",
    dailyCapacityMinutes: 480,
  }));

  // 工程 / プロダクト masters: one row per distinct synthetic phase/product used
  // by the tasks below. Tasks reference these by id (Design 0003 §E-2 / §C-6).
  const processes: ProcessRecord[] = [];
  const processIdByName = new Map<string, string>();
  const products: ProductRecord[] = [];
  const productIdByName = new Map<string, string>();
  for (let parentIndex = 0; parentIndex < parentCount; parentIndex += 1) {
    const processName = `Phase ${PHASE_LETTERS[parentIndex % PHASE_LETTERS.length]}`;
    if (!processIdByName.has(processName)) {
      const id = makeUuid("7", processes.length + 1);
      processIdByName.set(processName, id);
      processes.push({ id, tenantId, projectId, name: processName, sortOrder: processes.length });
    }
    const productName = `Product ${(parentIndex % 6) + 1}`;
    if (!productIdByName.has(productName)) {
      const id = makeUuid("8", products.length + 1);
      productIdByName.set(productName, id);
      products.push({ id, tenantId, projectId, name: productName, sortOrder: products.length });
    }
  }

  // Subtask-template master seeded with the two project defaults (§E-1).
  const templates: TemplateRecord[] = DEFAULT_SUBTASK_TEMPLATES.map((template, index) => ({
    id: makeUuid("6", index + 1),
    tenantId,
    projectId,
    name: template.name,
    sortOrder: index,
    subtasks: template.subtasks,
  }));

  const tasks: TaskRecord[] = [];
  const dependencies: TaskDependencyRecord[] = [];
  let sortOrder = 0;
  // Shared per-project display-No. counter (§F-1): every task and subtask, in
  // creation order, takes the next value; `nextTaskSeq` below is max + 1.
  let nextSeq = 1;
  let leafCounter = 0;
  let dependencyCounter = 0;

  for (let parentIndex = 0; parentIndex < parentCount; parentIndex += 1) {
    const parentId = makeUuid("d", parentIndex + 1);
    const phase = PHASE_LETTERS[parentIndex % PHASE_LETTERS.length];
    const product = `Product ${(parentIndex % 6) + 1}`;
    tasks.push({
      id: parentId,
      tenantId,
      projectId,
      parentTaskId: null,
      sortOrder: sortOrder++,
      seq: nextSeq++,
      name: `Phase ${phase} deliverable ${parentIndex + 1}`,
      processId: processIdByName.get(`Phase ${phase}`)!,
      productId: productIdByName.get(product)!,
      note: "",
      contract: `Contract ${(parentIndex % 4) + 1}`,
      assigneeMemberId: null,
      plannedEffortMinutes: 0,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      actualStart: null,
      actualFinish: null,
    });

    let previousLeafId: string | null = null;
    for (let subtaskIndex = 0; subtaskIndex < subtasksPerParent; subtaskIndex += 1) {
      leafCounter += 1;
      const leafId = makeUuid("e", leafCounter);
      const span = 1 + Math.floor(random() * 8);
      const perDay = pick(PER_DAY_MINUTES, random);
      const startIndex = Math.floor(random() * (horizon - span));
      const dailyPlan: Record<string, number> = {};
      for (let day = 0; day < span; day += 1) {
        dailyPlan[workingDays[startIndex + day]!] = perDay;
      }
      const plannedEffortMinutes = perDay * span;
      const progressBasisPoints = Math.floor(random() * 10_001);
      const actualEffortMinutes = Math.round(
        (plannedEffortMinutes * progressBasisPoints) / 10_000,
      );
      const actualStart = progressBasisPoints > 0 ? workingDays[startIndex]! : null;
      const actualFinish =
        progressBasisPoints >= 10_000 ? workingDays[startIndex + span - 1]! : null;

      tasks.push({
        id: leafId,
        tenantId,
        projectId,
        parentTaskId: parentId,
        sortOrder: sortOrder++,
        seq: nextSeq++,
        name: `Subtask ${parentIndex + 1}.${subtaskIndex + 1}`,
        processId: processIdByName.get(`Phase ${phase}`)!,
        productId: productIdByName.get(product)!,
        note: subtaskIndex % 3 === 0 ? `Note ${leafCounter}` : "",
        contract: `Contract ${(parentIndex % 4) + 1}`,
        assigneeMemberId: members[leafCounter % memberCount]!.id,
        plannedEffortMinutes,
        progressBasisPoints,
        actualEffortMinutes,
        prorationWeightBp: null,
        dailyPlan,
        actualStart,
        actualFinish,
      });

      if (previousLeafId !== null) {
        dependencyCounter += 1;
        dependencies.push({
          id: makeUuid("f", dependencyCounter),
          tenantId,
          projectId,
          predecessorTaskId: previousLeafId,
          successorTaskId: leafId,
          type: "FS",
          lagWorkingDays: 0,
        });
      }
      previousLeafId = leafId;
    }
  }

  const auditEvents: readonly AuditEventRecord[] = [
    {
      id: makeUuid("9", 1),
      tenantId,
      projectId,
      projectRevision: 1n,
      actorType: "HUMAN",
      actorId: "seed-planner",
      commandType: "project.seed",
      payload: {},
      occurredAt: "2026-01-05T00:00:00.000Z",
    },
  ];

  return {
    tenant: { id: tenantId, name: "VECTA demo tenant" },
    project: {
      id: projectId,
      tenantId,
      name: "Effort WBS demo",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      projectStart,
      statusDate,
      defaultCalendarId: "standard",
      revision: 1n,
      nextTaskSeq: nextSeq,
    },
    calendars,
    members,
    processes,
    products,
    templates,
    tasks,
    dependencies,
    auditEvents,
  };
}

export const demoProjectRecord: PersistedProjectRecord = createSeedProjectRecord();
