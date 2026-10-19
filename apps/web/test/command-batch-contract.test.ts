// @vitest-environment node

import {
  ProjectCommandValidationError,
  type ProjectAccessGrant,
  type ProjectCommand,
} from "@vecta/application";
import { RouterContextProvider } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  dbSessionContext,
  principalContext,
  projectMembershipContext,
} from "~/server/context.server";
import type { AuthenticatedPrincipal } from "~/server/auth/principal-directory.server";
import type { DbSession } from "~/server/db-session.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { applyCommands } from "~/server/project/apply-commands.server";
import { CommandBatchSchema } from "~/wbs/project-command-contract";
import {
  TENANT_ID as API_TENANT_ID,
  apiEnv,
  buildApiApp,
  fakeGrantResolver,
  fakeSession,
} from "./fixtures/api";
import { FakeProjectCommandUnitOfWork } from "./fixtures/fake-unit-of-work";
import { scheduledProject } from "./fixtures/wbs";

/**
 * The wire contract of one operation (M1 #2 unit 4): `{ expectedRevision,
 * operationId, commands }`, where 2+ commands are only allowed when every one is
 * `task.update` (a reorder or a paste). Asserted on the parser itself, on the two
 * HTTP surfaces that use it, and on the action core that must call the service
 * exactly once.
 */

const TASK_A = "e0000000-0000-4000-8000-000000000001";
const TASK_B = "e0000000-0000-4000-8000-000000000002";
const MEMBER = "c0000000-0000-4000-8000-000000000001";
const TEMPLATE = "60000000-0000-4000-8000-000000000001";

const update = (taskId = TASK_A, name = "Renamed") => ({ type: "task.update", taskId, changes: { name } });
const add = {
  type: "task.add",
  task: {
    id: "e0000000-0000-4000-8000-00000000aaaa", parentId: null, sortOrder: 5, name: "Added", processId: null,
    productId: null, note: "", contract: "", assigneeMemberId: null, plannedEffortMinutes: 0,
    progressBasisPoints: 0, actualEffortMinutes: 0, prorationWeightBp: null, dailyPlan: {},
    actualStart: null, actualFinish: null, dependencies: [],
  },
};
const memberUpdate = { type: "member.update", memberId: MEMBER, changes: { name: "M" } };
const templateUpdate = { type: "template.update", templateId: TEMPLATE, changes: { name: "T" } };

const batch = (commands: unknown[], extra: Record<string, unknown> = {}) => ({
  expectedRevision: "1",
  operationId: "op-10",
  commands,
  ...extra,
});

describe("CommandBatchSchema (one operation)", () => {
  it("accepts the base shape and parses expectedRevision to a bigint-able string and the operation id", () => {
    const parsed = CommandBatchSchema.safeParse(batch([update()]));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.operationId).toBe("op-10");
    expect(parsed.data.expectedRevision).toBe("1");
    expect(parsed.data.commands).toHaveLength(1);
  });

  it.each([
    ["2 task.update", [update(TASK_A), update(TASK_B)]],
    ["20 task.update", Array.from({ length: 20 }, (_, index) => update(TASK_A, `n${index}`))],
    ["the same task updated twice", [update(TASK_A, "one"), update(TASK_A, "two")]],
    ["a single task.add", [add]],
    ["a single member.update", [memberUpdate]],
  ])("accepts %s", (_label, commands) => {
    expect(CommandBatchSchema.safeParse(batch(commands)).success).toBe(true);
  });

  it("accepts exactly 1000 task.update commands and rejects 1001 (cap unchanged)", () => {
    const many = (count: number) => Array.from({ length: count }, () => update());
    expect(CommandBatchSchema.safeParse(batch(many(1_000))).success).toBe(true);
    expect(CommandBatchSchema.safeParse(batch(many(1_001))).success).toBe(false);
  });

  it.each([
    ["task.update + task.add", [update(), add]],
    ["task.add + task.update", [add, update()]],
    ["task.add + task.add", [add, { ...add, task: { ...add.task, id: "e0000000-0000-4000-8000-00000000bbbb" } }]],
    ["task.update + member.update", [update(), memberUpdate]],
    ["template.update + template.update", [templateUpdate, templateUpdate]],
    ["baseline.publish + task.update", [{ type: "baseline.publish" }, update()]],
  ])("rejects the mixed operation %s", (_label, commands) => {
    expect(CommandBatchSchema.safeParse(batch(commands)).success).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["blanks only", "   "],
    ["201 characters", "x".repeat(201)],
  ])("rejects an operationId that is %s", (_label, operationId) => {
    expect(CommandBatchSchema.safeParse(batch([update()], { operationId })).success).toBe(false);
  });

  it("accepts a 200-character operationId, rejects a missing one", () => {
    expect(CommandBatchSchema.safeParse(batch([update()], { operationId: "x".repeat(200) })).success).toBe(true);
    const withoutId: Record<string, unknown> = batch([update()]);
    delete withoutId.operationId;
    expect(CommandBatchSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects the old per-command envelope { command, idempotencyKey }", () => {
    expect(
      CommandBatchSchema.safeParse({
        expectedRevision: "1",
        commands: [{ command: update(), idempotencyKey: "k-1" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty commands array and an unknown top-level key (.strict() stays)", () => {
    expect(CommandBatchSchema.safeParse(batch([])).success).toBe(false);
    expect(CommandBatchSchema.safeParse(batch([update()], { idempotencyKey: "legacy" })).success).toBe(false);
  });
});

describe("the HTTP surfaces refuse a mixed operation before anything executes", () => {
  const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });

  const grant: ProjectAccessGrant = {
    principalId: "principal-1",
    principalType: "HUMAN",
    projectRole: "EDITOR",
    allowedScopes: [],
  };

  it("REST /api: 2 non-update commands answer 400 and the unit of work is never built", async () => {
    const unitOfWorkFor = vi.fn(() => new FakeProjectCommandUnitOfWork(project, 5n));
    const { app } = buildApiApp({ grantResolver: fakeGrantResolver(grant), unitOfWorkFor });
    const response = await app.request(
      `/api/tenants/${API_TENANT_ID}/projects/${project.id}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch([add, memberUpdate], { expectedRevision: "5" })),
      },
      apiEnv(),
    );
    expect(response.status).toBe(400);
    expect(unitOfWorkFor).not.toHaveBeenCalled();
  });

  it("cookie action: 2 non-update commands answer 422 INVALID, and the old shape does too", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const principal: AuthenticatedPrincipal = {
      principal: { id: "principal-1", issuer: "https://identity.example.invalid/", subject: "s-1", displayName: "T", type: "HUMAN" },
      tenantMemberships: [{ tenantId, role: "MEMBER" }],
      projectMemberships: [{ tenantId, projectId, role: "EDITOR" }],
    };
    const context = new RouterContextProvider();
    context.set(principalContext, async () => principal);
    context.set(projectMembershipContext, { tenantId, projectId, projectRole: "EDITOR", tenantRole: "MEMBER" });
    context.set(dbSessionContext, {
      database: vi.fn(() => ({})),
      read: () => { throw new Error("unexpected read"); },
      close: async () => {},
    } as unknown as DbSession);

    const post = (body: unknown) =>
      runCommandAction(
        {
          request: new Request(`https://vecta.example.com/projects/${projectId}/wbs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          context,
        },
        "wbs-save",
      );

    const mixed = await post(batch([update(), add]));
    expect(mixed.init?.status).toBe(422);
    expect(mixed.data).toEqual({ ok: false, code: "INVALID", message: "Command batch is malformed" });

    const legacy = await post({ expectedRevision: "1", commands: [{ command: update(), idempotencyKey: "k" }] });
    expect(legacy.init?.status).toBe(422);
  });
});

describe("applyCommands calls the service once for the whole operation", () => {
  const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
  const leaves = project.tasks.filter((task) => task.parentId !== null);
  const updates: ProjectCommand[] = leaves.slice(0, 3).map((leaf, index) => ({
    type: "task.update",
    taskId: leaf.id,
    changes: { sortOrder: 10 + index },
  }));
  const input = (expectedRevision: bigint) => ({
    session: fakeSession(),
    actor: { principalId: "p-1", principalType: "HUMAN" as const },
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: project.id,
    projectRole: "EDITOR" as const,
    operationId: "op-13",
    commands: updates,
    expectedRevision,
  });

  beforeAll(() => {
    expect(updates).toHaveLength(3);
  });

  it("3 task.update in one request: ONE execute carrying all 3 and the operation id; revision +1", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const execute = vi.spyOn(uow, "execute");
    const result = await applyCommands(input(5n), { unitOfWorkFor: () => uow });

    expect(result).toEqual({ ok: true, revision: 6n });
    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]![0];
    expect(request.commands).toHaveLength(3);
    expect(request.operationId).toBe("op-13");
    expect(request.expectedRevision).toBe(5n);
    expect(uow.revision).toBe(6n);
  });

  it("a validation error from that one execute is INVALID with the revision unchanged (no partial-commit conflict)", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    vi.spyOn(uow, "execute").mockRejectedValue(new ProjectCommandValidationError("third command is invalid"));
    const result = await applyCommands(input(5n), { unitOfWorkFor: () => uow });
    expect(result).toEqual({ ok: false, code: "INVALID", message: "third command is invalid" });
    expect(uow.revision).toBe(5n);
  });

  it("a stale expectedRevision is a 409-shaped VERSION_CONFLICT carrying the actual revision", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(input(4n), { unitOfWorkFor: () => uow });
    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", actualRevision: 5n });
    expect(uow.revision).toBe(5n);
  });
});
