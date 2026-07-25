import type {
  ProjectDependency,
  ProjectMember,
  ProjectProcess,
  ProjectProduct,
  ProjectState,
  ProjectTask,
  SubtaskTemplate,
  SubtaskTemplateStep,
} from "@vecta/application";

// Deterministic, browser-safe synthetic fixture for the client preview. It
// mirrors the backend seed (packages/persistence/src/demo-project.ts) but emits
// a ProjectState directly so the preview never pulls the persistence/pg layer
// into the browser bundle. All labels are generic and anonymized ("Phase A",
// "Product 1", "Member 01"); no client/vendor/product/contract names and no
// real values. The reference worksheet under .wbs-private/ is never read.

export interface DemoProjectOptions {
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
// the former builtin catalog). Weights are basis points summing to 10000 so a
// freshly generated parent's children reproduce its planned effort exactly.
const DEFAULT_SUBTASK_TEMPLATES: readonly {
  readonly name: string;
  readonly subtasks: readonly SubtaskTemplateStep[];
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

// Two mid-week holidays early in the horizon. The scheduler skips them, so
// placed rows leave those day columns empty while the showcase row (below) keeps
// its hand-entered early-January plan — a stable anchor for the daily-cell tests.
const DEMO_HOLIDAYS = ["2026-01-07", "2026-01-08"] as const;

// Individual paid-leave (有給) days for the members given their own calendar
// below. 01-06 and 01-09 coincide with the showcase row's columns, so those
// columns exist regardless of scheduling and the violet paid-leave tint is
// guaranteed to show on the paid-leave members' rows; 01-13 adds a third within
// the same early-January window. All synthetic and unrelated to real people.
const DEMO_PAID_LEAVE = ["2026-01-06", "2026-01-09", "2026-01-13"] as const;

// A couple of member array indexes that take an individual calendar (the default
// working week plus DEMO_PAID_LEAVE). Absent in the tiny test fixtures (few
// members), so they only surface in the full preview.
const DEMO_PAID_LEAVE_MEMBER_INDEXES = [3, 7] as const;

// One deterministic showcase leaf (the very first subtask) with a hand-entered
// early-January plan. It gives the preview and the daily-cell tests a stable,
// known set of columns (including effort on a holiday the scheduler never fills).
// Σ daily = plannedEffortMinutes so its estimate and daily plot stay consistent.
const SHOWCASE_DEMO_PLAN: Readonly<Record<string, number>> = {
  "2026-01-05": 240,
  "2026-01-06": 240,
  "2026-01-07": 180,
  "2026-01-09": 120,
};
const SHOWCASE_DEMO_MINUTES = Object.values(SHOWCASE_DEMO_PLAN).reduce((sum, value) => sum + value, 0);
const SHOWCASE_DEMO_START = "2026-01-05";

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

export function createDemoProject(options: DemoProjectOptions = {}): ProjectState {
  const parentCount = options.parentCount ?? 300;
  const subtasksPerParent = options.subtasksPerParent ?? 9;
  const memberCount = options.memberCount ?? 40;
  const random = createRandom(options.seed ?? 0x5eed);

  const projectStart = "2026-01-05"; // a Monday
  const horizon = 260;
  const workingDays = buildWorkingDays(projectStart, horizon);
  const statusDate = workingDays[130]!;

  // A couple of members take an individual (paid-leave) calendar so the preview
  // shows the distinct violet 有給 tint alongside the shared grey weekend/holiday
  // cells. Guarded by memberCount so tiny fixtures keep every member on standard.
  const paidLeaveMembers = DEMO_PAID_LEAVE_MEMBER_INDEXES.filter((index) => index < memberCount).map(
    (index) => ({
      index,
      memberId: makeUuid("c", index + 1),
      calendarId: `leave-${(index + 1).toString().padStart(2, "0")}`,
    }),
  );
  const paidLeaveCalendarByMemberId = new Map(
    paidLeaveMembers.map((entry) => [entry.memberId, entry.calendarId]),
  );

  const members: ProjectMember[] = Array.from({ length: memberCount }, (_, index) => {
    const id = makeUuid("c", index + 1);
    return {
      id,
      name: `Member ${(index + 1).toString().padStart(2, "0")}`,
      calendarId: paidLeaveCalendarByMemberId.get(id) ?? "standard",
      dailyCapacityMinutes: 480,
    };
  });

  // 工程 / プロダクト masters: one row per distinct synthetic phase/product used
  // by the tasks below. Tasks reference these by id (Design 0003 §E-2 / §C-6).
  const processes: ProjectProcess[] = [];
  const processIdByName = new Map<string, string>();
  const products: ProjectProduct[] = [];
  const productIdByName = new Map<string, string>();
  for (let parentIndex = 0; parentIndex < parentCount; parentIndex += 1) {
    const processName = `Phase ${PHASE_LETTERS[parentIndex % PHASE_LETTERS.length]}`;
    if (!processIdByName.has(processName)) {
      const id = makeUuid("7", processes.length + 1);
      processIdByName.set(processName, id);
      processes.push({ id, name: processName, sortOrder: processes.length });
    }
    const productName = `Product ${(parentIndex % 6) + 1}`;
    if (!productIdByName.has(productName)) {
      const id = makeUuid("8", products.length + 1);
      productIdByName.set(productName, id);
      products.push({ id, name: productName, sortOrder: products.length });
    }
  }

  // Subtask-template master seeded with the two project defaults (§E-1).
  const templates: SubtaskTemplate[] = DEFAULT_SUBTASK_TEMPLATES.map((template, index) => ({
    id: makeUuid("6", index + 1),
    name: template.name,
    sortOrder: index,
    subtasks: template.subtasks,
  }));

  const tasks: ProjectTask[] = [];
  let sortOrder = 0;
  // Shared per-project display-No. counter (§F-1): every task and subtask, in
  // creation order, takes the next value; `nextTaskSeq` below is max + 1.
  let nextSeq = 1;
  let leafCounter = 0;

  for (let parentIndex = 0; parentIndex < parentCount; parentIndex += 1) {
    const parentId = makeUuid("d", parentIndex + 1);
    const phase = PHASE_LETTERS[parentIndex % PHASE_LETTERS.length];
    const product = `Product ${(parentIndex % 6) + 1}`;
    tasks.push({
      id: parentId,
      parentId: null,
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
      dependencies: [],
    });

    let previousLeafId: string | null = null;
    for (let subtaskIndex = 0; subtaskIndex < subtasksPerParent; subtaskIndex += 1) {
      leafCounter += 1;
      const leafId = makeUuid("e", leafCounter);
      // The first leaf of the first parent is the deterministic showcase row.
      const showcaseDemo = parentIndex === 0 && subtaskIndex === 0;
      const span = 1 + Math.floor(random() * 8);
      const perDay = pick(PER_DAY_MINUTES, random);
      const startIndex = Math.floor(random() * (horizon - span));
      const scheduledPlan: Record<string, number> = {};
      for (let day = 0; day < span; day += 1) {
        scheduledPlan[workingDays[startIndex + day]!] = perDay;
      }
      const dailyPlan = showcaseDemo ? { ...SHOWCASE_DEMO_PLAN } : scheduledPlan;
      const plannedEffortMinutes = showcaseDemo ? SHOWCASE_DEMO_MINUTES : perDay * span;
      const progressBasisPoints = showcaseDemo ? 4_000 : Math.floor(random() * 10_001);
      const actualEffortMinutes = Math.round(
        (plannedEffortMinutes * progressBasisPoints) / 10_000,
      );
      const actualStart = progressBasisPoints > 0 ? workingDays[startIndex]! : null;
      const actualFinish =
        progressBasisPoints >= 10_000 ? workingDays[startIndex + span - 1]! : null;
      const dependencies: ProjectDependency[] =
        previousLeafId === null
          ? []
          : [{ predecessorId: previousLeafId, type: "FS", lagWorkingDays: 0 }];

      tasks.push({
        id: leafId,
        parentId,
        sortOrder: sortOrder++,
        seq: nextSeq++,
        name: `Subtask ${parentIndex + 1}.${subtaskIndex + 1}`,
        processId: processIdByName.get(`Phase ${phase}`)!,
        productId: productIdByName.get(product)!,
        note: showcaseDemo ? "Hand-entered plan" : subtaskIndex % 3 === 0 ? `Note ${leafCounter}` : "",
        contract: `Contract ${(parentIndex % 4) + 1}`,
        assigneeMemberId: members[leafCounter % memberCount]!.id,
        plannedEffortMinutes,
        progressBasisPoints,
        actualEffortMinutes,
        prorationWeightBp: null,
        dailyPlan,
        actualStart: showcaseDemo ? SHOWCASE_DEMO_START : actualStart,
        actualFinish: showcaseDemo ? null : actualFinish,
        dependencies,
      });
      previousLeafId = leafId;
    }
  }

  return {
    id: makeUuid("b", 1),
    name: "Effort WBS demo",
    projectStart,
    statusDate,
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      {
        id: "standard",
        name: "Standard working week",
        workingWeekdays: [1, 2, 3, 4, 5],
        nonWorkingDates: [...DEMO_HOLIDAYS],
      },
      // Per-member paid-leave calendars: the standard week plus each member's own
      // 有給 days, so those members' rows tint violet on DEMO_PAID_LEAVE dates.
      ...paidLeaveMembers.map((entry) => ({
        id: entry.calendarId,
        name: `Personal calendar ${entry.index + 1}`,
        workingWeekdays: [1, 2, 3, 4, 5],
        nonWorkingDates: [...DEMO_HOLIDAYS, ...DEMO_PAID_LEAVE],
      })),
    ],
    members,
    processes,
    products,
    templates,
    tasks,
    nextTaskSeq: nextSeq,
  };
}
