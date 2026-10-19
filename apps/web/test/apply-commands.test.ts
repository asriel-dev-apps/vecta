import { describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectAccessGrant,
  type ProjectAccessGrantResolver,
  type ProjectCommand,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@vecta/application";
import { applyCommands } from "~/server/project/apply-commands.server";
import type { DbSession } from "~/server/db-session.server";
import { FakeProjectCommandUnitOfWork } from "./fixtures/fake-unit-of-work";
import { scheduledProject } from "./fixtures/wbs";

// The action core (`applyCommands`) authorizes the session principal as the actor
// and drives the operation through the command service once, with optimistic
// concurrency. These tests inject the in-memory fake unit of work, so the whole
// write path runs with no network/DB: an authorized operation persists and
// advances the revision by one; a stale expected revision RETURNS a 409-shaped
// conflict (never throws); a VIEWER actor is denied before anything executes.

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const project: ProjectState = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
const leaf = project.tasks.find((task) => task.parentId !== null)!;
const otherLeaf = project.tasks.find((task) => task.parentId !== null && task.id !== leaf.id)!;

function fakeSession(): DbSession {
  // `unitOfWorkFor` is injected below, so the database handle is never touched.
  return {
    read: () => ({}) as never,
    database: () => ({}) as never,
    close: async () => undefined,
    timings: () => ({ readCount: 0, readMs: 0, writeCount: 0, writeMs: 0 }),
  };
}

function operation(commands: readonly ProjectCommand[], operationId = "op-1") {
  return { operationId, commands };
}

const rename: ProjectCommand = { type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } };
const renameOther: ProjectCommand = {
  type: "task.update",
  taskId: otherLeaf.id,
  changes: { name: "Renamed too" },
};

/** Throws from the single `execute`, so the operation commits nothing. */
class FailingUnitOfWork implements ProjectCommandUnitOfWork {
  readonly revision: bigint;
  executeCount = 0;

  constructor(
    revision: bigint,
    private readonly makeError: (request: ProjectCommandRequest) => Error,
  ) {
    this.revision = revision;
  }

  async execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution> {
    this.executeCount += 1;
    throw this.makeError(request);
  }
}

describe("applyCommands action core", () => {
  it("authorized OWNER batch persists and returns the advanced revision", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        ...operation([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: true, revision: 6n });
    expect(uow.revision).toBe(6n);
    expect(uow.state.tasks.find((task) => task.id === leaf.id)!.name).toBe("Renamed");
  });

  it("applies a multi-command reorder as one revision", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        ...operation([
          { type: "task.update", taskId: leaf.id, changes: { sortOrder: 3 } },
          { type: "task.update", taskId: otherLeaf.id, changes: { sortOrder: 4 } },
        ]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: true, revision: 6n });
    expect(uow.executeCount).toBe(1);
    expect(uow.state.tasks.find((task) => task.id === leaf.id)!.sortOrder).toBe(3);
    expect(uow.state.tasks.find((task) => task.id === otherLeaf.id)!.sortOrder).toBe(4);
  });

  it("RETURNS a 409-shaped VERSION_CONFLICT on a stale expected revision (does not throw)", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        ...operation([rename]),
        expectedRevision: 4n, // behind the fake's actual revision of 5
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", actualRevision: 5n });
    // State untouched: the conflict was detected before the transition committed.
    expect(uow.revision).toBe(5n);
  });

  it("denies a VIEWER actor (FORBIDDEN) before any command executes", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "viewer-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "VIEWER",
        ...operation([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    // Fail-closed: nothing was executed for a denied actor.
    expect(uow.executeCount).toBe(0);
    expect(uow.revision).toBe(5n);
  });
});

describe("applyCommands is one transaction", () => {
  it("a version conflict from the one execute maps to VERSION_CONFLICT and does not advance", async () => {
    const uow = new FailingUnitOfWork(
      5n,
      (request) => new ProjectVersionConflictError(request.expectedRevision, 42n),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        ...operation([rename, renameOther]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", actualRevision: 42n });
    expect(uow.executeCount).toBe(1);
    expect(uow.revision).toBe(5n);
  });

  it("a validation failure maps to INVALID and leaves the revision unchanged", async () => {
    const uow = new FailingUnitOfWork(5n, () => new ProjectCommandValidationError("second command is invalid"));
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        ...operation([rename, renameOther]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "INVALID", message: "second command is invalid" });
    expect(uow.executeCount).toBe(1);
    expect(uow.revision).toBe(5n);
  });
});

describe("applyCommands grant resolution (per-batch memo)", () => {
  it("resolves the injected grant ONCE for a multi-command batch, yet authorizes every command", async () => {
    // The token surface injects a Postgres grant resolver; the authorizer resolves
    // once per command, but the resolve key (identity, tenant, project) is constant
    // across the batch, so the per-request memo must collapse N commands to ONE
    // resolution — while still executing (i.e. authorizing) all of them.
    let resolveCount = 0;
    const grant: ProjectAccessGrant = {
      principalId: "p-1",
      principalType: "HUMAN",
      projectRole: "EDITOR",
      allowedScopes: [],
    };
    const grantResolver: ProjectAccessGrantResolver = {
      async resolve() {
        resolveCount += 1;
        return grant;
      },
    };
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        tenantId: TENANT_ID,
        projectId: project.id,
        ...operation([
          { type: "task.update", taskId: leaf.id, changes: { sortOrder: 3 } },
          { type: "task.update", taskId: otherLeaf.id, changes: { sortOrder: 4 } },
          { type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } },
        ]),
        expectedRevision: 5n,
      },
      {
        grantResolver,
        identity: { issuer: "https://issuer.example.test", subject: "sub-1", scopes: [] },
        unitOfWorkFor: () => uow,
      },
    );

    expect(result).toEqual({ ok: true, revision: 6n });
    // One DB resolution for the whole operation. Every command was authorized;
    // the unit of work ran once.
    expect(resolveCount).toBe(1);
    expect(uow.executeCount).toBe(1);
    expect(uow.state.tasks.find((task) => task.id === leaf.id)!.name).toBe("Renamed");
  });
});

describe("applyCommands error mapping (P2-a)", () => {
  it("maps IdempotencyConflictError (nothing committed) to INVALID", async () => {
    const uow = new FailingUnitOfWork(5n, () => new IdempotencyConflictError("k"));
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        ...operation([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("maps ProjectNotFoundError to a 404-shaped NOT_FOUND result (not a 500)", async () => {
    const uow = new FailingUnitOfWork(5n, () => new ProjectNotFoundError(project.id));
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        ...operation([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
