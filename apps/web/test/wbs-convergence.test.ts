import { describe, expect, it } from "vitest";
import {
  createProjectCommandService,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import { deriveOptimisticState } from "~/wbs/wbs-app";
import { applyCommands } from "~/server/project/apply-commands.server";
import { ApiCommandSchema } from "~/wbs/project-command-contract";
import type { DbSession } from "~/server/db-session.server";
import { FakeProjectCommandUnitOfWork } from "./fixtures/fake-unit-of-work";
import { scheduledProject } from "./fixtures/wbs";

// ADR 0012 §0 — THE convergence invariant, and the single most important Step-4
// test. For every command type the client-optimistic transition
// (`deriveOptimisticState`, which folds `applyProjectCommand` and, only for
// `task.generateSubtasks`, `applyEffortSchedule` over the new leaf ids) must equal
// the server unit-of-work's transition (the same fold, driven through
// `createProjectCommandService` + the fake UoW that mirrors
// `PostgresProjectCommandUnitOfWork` ~285–297) — PRIVILEGED role, including seq
// assignment and the generateSubtasks scheduler branch over the new task ids.
// Any divergence means a future server-only derivation could silently drift, and
// "instant save, no re-settle" would corrupt state; this is the loud tripwire.
//
// For GENERAL the invariant is FALSE by construction (a capacity-stripped view is
// not the server's full-capacity scheduling), so we do NOT assert equivalence:
// we assert the write path is SERVER-DENIED instead (the authorizer 403s a VIEWER).

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

// Augment the demo with spare, unreferenced masters so the *.delete commands are
// valid (member/process/product deletes are guarded against in-use references).
function baseState(): ProjectState {
  const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
  return {
    ...project,
    members: [
      ...project.members,
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Spare member",
        calendarId: "standard",
        dailyCapacityMinutes: 480,
      },
    ],
    processes: [
      ...project.processes,
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Spare process", sortOrder: 900 },
    ],
    products: [
      ...project.products,
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Spare product", sortOrder: 900 },
    ],
  };
}

const base = baseState();
const parent = base.tasks.find((task) => task.parentId === null)!;
const leaf = base.tasks.find((task) => task.parentId !== null)!;
// A leaf no other task depends on (the demo chains siblings with FS deps, so the
// first leaf is a predecessor): deleting it can't orphan a dependency.
const deletableLeaf = base.tasks.find(
  (task) =>
    task.parentId !== null &&
    !base.tasks.some((other) =>
      other.dependencies.some((dependency) => dependency.predecessorId === task.id),
    ),
)!;
const maxSortOrder = base.tasks.reduce((max, task) => Math.max(max, task.sortOrder), -1);
const SPARE_MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPARE_PROCESS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPARE_PRODUCT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// The server transition: run the command through the real command service over
// the fake UoW (which reproduces the persistence UoW's transition + scheduler
// branch), then read the resulting state.
async function serverState(command: ProjectCommand): Promise<ProjectState> {
  const uow = new FakeProjectCommandUnitOfWork(base, 1n);
  const service = createProjectCommandService(uow);
  await service.execute({
    tenantId: TENANT_ID,
    projectId: base.id,
    expectedRevision: 1n,
    idempotencyKey: "convergence-key",
    actor: { type: "HUMAN", id: "principal-1" },
    command,
  });
  return uow.state;
}

const cases: ReadonlyArray<readonly [string, ProjectCommand]> = [
  [
    "task.add",
    {
      type: "task.add",
      task: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
        parentId: null,
        sortOrder: maxSortOrder + 1,
        name: "New root task",
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
        actualStart: null,
        actualFinish: null,
        dependencies: [],
      },
    },
  ],
  ["task.update", { type: "task.update", taskId: leaf.id, changes: { plannedEffortMinutes: 240 } }],
  ["task.delete", { type: "task.delete", taskId: deletableLeaf.id }],
  [
    "task.generateSubtasks",
    { type: "task.generateSubtasks", parentTaskId: leaf.id, templateId: base.templates[0]!.id },
  ],
  [
    "member.add",
    {
      type: "member.add",
      member: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddd02",
        name: "Added member",
        calendarId: "standard",
        dailyCapacityMinutes: 300,
      },
    },
  ],
  ["member.update", { type: "member.update", memberId: base.members[0]!.id, changes: { name: "M-renamed" } }],
  ["member.delete", { type: "member.delete", memberId: SPARE_MEMBER }],
  [
    "process.add",
    { type: "process.add", process: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddd03", name: "Added process", sortOrder: 10 } },
  ],
  ["process.update", { type: "process.update", processId: base.processes[0]!.id, changes: { name: "P-renamed" } }],
  ["process.delete", { type: "process.delete", processId: SPARE_PROCESS }],
  [
    "product.add",
    { type: "product.add", product: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddd04", name: "Added product", sortOrder: 10 } },
  ],
  ["product.update", { type: "product.update", productId: base.products[0]!.id, changes: { name: "Pr-renamed" } }],
  ["product.delete", { type: "product.delete", productId: SPARE_PRODUCT }],
  [
    "template.add",
    {
      type: "template.add",
      template: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddd05",
        name: "Added template",
        sortOrder: 10,
        subtasks: [{ name: "Step", weightBp: 10_000 }],
      },
    },
  ],
  ["template.update", { type: "template.update", templateId: base.templates[0]!.id, changes: { name: "T-renamed" } }],
  ["template.delete", { type: "template.delete", templateId: base.templates[0]!.id }],
  // Design 0009. Its state transition is only the baseline counter, so client and
  // server converge trivially — but it is IN the union, and this suite exists to
  // make sure nothing in the union escapes the invariant unexamined. The snapshot
  // rows it writes are the unit of work's business and are covered against a real
  // database in `packages/persistence/test/baseline-publish.test.ts`; the client
  // never derives them, which is precisely why the optimistic states still match.
  ["baseline.publish", { type: "baseline.publish", acknowledgeUnplottedTasks: true }],
];

describe("§0 convergence: client transition === server transition (PRIVILEGED)", () => {
  it("covers every command type in the discriminated union", () => {
    // Guards against a new command type silently escaping the invariant. The
    // expected set is DERIVED from the wire command union (its discriminant
    // literals), so adding a command type there without a case here fails loudly
    // instead of being silently skipped by a hardcoded count.
    const covered = new Set(cases.map(([, command]) => command.type));
    const allCommandTypes = new Set(
      ApiCommandSchema.options.map((option) => option.shape.type.value),
    );
    expect(covered).toEqual(allCommandTypes);
    expect(parent.parentId).toBeNull();
  });

  it.each(cases)("%s: optimistic state equals the unit-of-work state", async (_name, command) => {
    const client = deriveOptimisticState(base, [command]);
    const server = await serverState(command);
    expect(client).toEqual(server);
  });
});

describe("§0 GENERAL: the write path is server-denied (no equivalence assertion)", () => {
  it("a VIEWER (GENERAL projection) write is FORBIDDEN by the authorizer", async () => {
    const uow = new FakeProjectCommandUnitOfWork(base, 1n);
    const session: DbSession = {
      read: () => ({}) as never,
      database: () => ({}) as never,
      close: async () => undefined,
    };
    const result = await applyCommands(
      {
        session,
        actor: { principalId: "viewer-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: base.id,
        projectRole: "VIEWER",
        commands: [{ command: { type: "task.update", taskId: leaf.id, changes: { name: "x" } }, idempotencyKey: "k" }],
        expectedRevision: 1n,
      },
      { unitOfWorkFor: () => uow },
    );
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(uow.executeCount).toBe(0);
  });
});
