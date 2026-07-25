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

// ADR 0012 Step 4b — the action core (`applyCommands`) authorizes the session
// principal as the actor and drives the batch through the command service with
// optimistic concurrency. These tests inject the in-memory fake unit of work, so
// the whole write path runs with no network/DB: an authorized batch persists and
// advances the revision; a stale expected revision RETURNS a 409-shaped conflict
// (never throws); a VIEWER actor is denied before any command executes.

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
  };
}

function withKeys(commands: readonly ProjectCommand[]) {
  return commands.map((command, index) => ({ command, idempotencyKey: `key-${index}` }));
}

const rename: ProjectCommand = { type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } };
const renameOther: ProjectCommand = {
  type: "task.update",
  taskId: otherLeaf.id,
  changes: { name: "Renamed too" },
};

/**
 * A unit of work that commits normally through {@link FakeProjectCommandUnitOfWork}
 * until the Nth `execute`, then throws a chosen error WITHOUT advancing — modelling
 * the Postgres UoW's one-transaction-per-command semantics, where a failure at
 * command index > 0 leaves the earlier commands already persisted (a partial
 * commit the client must resync, never roll back).
 */
class MidBatchFailureUnitOfWork implements ProjectCommandUnitOfWork {
  private readonly inner: FakeProjectCommandUnitOfWork;
  executeCount = 0;

  constructor(
    state: ProjectState,
    revision: bigint,
    private readonly failAtCall: number,
    private readonly makeError: (request: ProjectCommandRequest, revision: bigint) => Error,
  ) {
    this.inner = new FakeProjectCommandUnitOfWork(state, revision);
  }

  get revision(): bigint {
    return this.inner.revision;
  }

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    this.executeCount += 1;
    if (this.executeCount === this.failAtCall) {
      throw this.makeError(request, this.inner.revision);
    }
    return this.inner.execute(request, transition);
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
        commands: withKeys([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: true, revision: 6n });
    expect(uow.revision).toBe(6n);
    expect(uow.state.tasks.find((task) => task.id === leaf.id)!.name).toBe("Renamed");
  });

  it("chains the revision across a multi-command batch (server-side, one POST)", async () => {
    const uow = new FakeProjectCommandUnitOfWork(project, 5n);
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        commands: withKeys([
          { type: "task.update", taskId: leaf.id, changes: { sortOrder: 3 } },
          { type: "task.update", taskId: otherLeaf.id, changes: { sortOrder: 4 } },
        ]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: true, revision: 7n });
    expect(uow.executeCount).toBe(2);
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
        commands: withKeys([rename]),
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
        commands: withKeys([rename]),
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

describe("applyCommands partial-commit resync (P1-2 batch atomicity)", () => {
  it("a mid-batch conflict AFTER a commit resyncs (409) with the conflict's revision, not a rollback", async () => {
    // Command 0 commits (5 → 6); a concurrent writer then advances the row, so
    // command 1 hits a version conflict. Because command 0 already persisted, the
    // client must ADOPT the server state (resync), never roll back to its pre-batch
    // snapshot — so the core returns a VERSION_CONFLICT (mapped to 409 by the route).
    const uow = new MidBatchFailureUnitOfWork(
      project,
      5n,
      2,
      (request) => new ProjectVersionConflictError(request.expectedRevision, 42n),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        commands: withKeys([rename, renameOther]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", actualRevision: 42n });
    // Exactly one command committed before the failure.
    expect(uow.executeCount).toBe(2);
    expect(uow.revision).toBe(6n);
  });

  it("a mid-batch validation failure AFTER a commit resyncs with the committed revision", async () => {
    // Command 0 commits (5 → 6); command 1 fails validation. A non-conflict error
    // after a partial commit still requires a resync, carrying the revision the
    // partial batch reached (6) so the client adopts rather than rolling back.
    const uow = new MidBatchFailureUnitOfWork(
      project,
      5n,
      2,
      () => new ProjectCommandValidationError("second command is invalid"),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "EDITOR",
        commands: withKeys([rename, renameOther]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", actualRevision: 6n });
    expect(uow.executeCount).toBe(2);
  });

  it("a first-command validation failure (nothing committed) maps to INVALID for rollback", async () => {
    // Failure at index 0 committed nothing, so the client's optimistic edit is
    // untouched on the server — INVALID (422) lets it roll back cleanly.
    const uow = new MidBatchFailureUnitOfWork(
      project,
      5n,
      1,
      () => new ProjectCommandValidationError("first command is invalid"),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        commands: withKeys([rename, renameOther]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "INVALID", message: "first command is invalid" });
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
        commands: withKeys([
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

    expect(result).toEqual({ ok: true, revision: 8n });
    // One DB resolution for the whole batch, but all three commands were authorized
    // and executed.
    expect(resolveCount).toBe(1);
    expect(uow.executeCount).toBe(3);
  });
});

describe("applyCommands error mapping (P2-a)", () => {
  it("maps IdempotencyConflictError (nothing committed) to INVALID", async () => {
    const uow = new MidBatchFailureUnitOfWork(
      project,
      5n,
      1,
      () => new IdempotencyConflictError("k"),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        commands: withKeys([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("maps ProjectNotFoundError to a 404-shaped NOT_FOUND result (not a 500)", async () => {
    const uow = new MidBatchFailureUnitOfWork(
      project,
      5n,
      1,
      () => new ProjectNotFoundError(project.id),
    );
    const result = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: project.id,
        projectRole: "OWNER",
        commands: withKeys([rename]),
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uow },
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
