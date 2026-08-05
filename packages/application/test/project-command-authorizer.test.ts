import { describe, expect, it } from "vitest";
import {
  AgentPlanApprovalRequiredError,
  createProjectCommandAuthorizer,
  createProjectQueryAuthorizer,
  ProjectAccessDeniedError,
  type ProjectAccessGrantResolver,
} from "../src/index.js";

describe("ProjectCommandAuthorizer", () => {
  it("authorizes a human editor as the stable internal audit actor", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000001",
        principalType: "HUMAN",
        projectRole: "EDITOR",
        allowedScopes: [],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "human-editor", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "task.delete", taskId: "task-1" },
      }),
    ).resolves.toEqual({ type: "HUMAN", id: "90000000-0000-4000-8000-000000000001" });
  });

  it("authorizes an agent progress update only when both grant and token carry the scope", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "progress-agent",
          scopes: ["project:progress:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { progressBasisPoints: 7_500 },
        },
      }),
    ).resolves.toEqual({ type: "AGENT", id: "90000000-0000-4000-8000-000000000002" });
  });

  it("authorizes an agent progress and actuals update carrying every applicable scope", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write", "project:actuals:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "progress-agent",
          scopes: ["project:progress:write", "project:actuals:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { progressBasisPoints: 7_500, actualEffortMinutes: 480 },
        },
      }),
    ).resolves.toMatchObject({ type: "AGENT" });
  });

  it("requires human approval instead of directly applying an agent plan change", async () => {
    const authorizer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: [],
      }),
    });

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "planning-agent", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "task.update", taskId: "task-1", changes: { plannedEffortMinutes: 600 } },
      }),
    ).rejects.toBeInstanceOf(AgentPlanApprovalRequiredError);
  });

  it("requires human approval for an agent member change", async () => {
    const authorizer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: [],
      }),
    });

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "planning-agent", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "member.add",
          member: { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
        },
      }),
    ).rejects.toBeInstanceOf(AgentPlanApprovalRequiredError);
  });

  it("requires human approval to publish a baseline (Design 0009, ADR 0007)", async () => {
    // An approved baseline is a plan decision, and ADR 0007 makes publishing a
    // HUMAN command. Today that holds by DEFAULT rather than by intent:
    // `isAgentPlanChange` treats everything that is not a narrowly-scoped
    // `task.update` as a plan change, so a new command type is fail-closed the
    // moment it is added. This pins it, because the day someone loosens that
    // default is the day publishing silently opens to agents — and nothing else in
    // the suite would notice.
    const authorizer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000003",
        principalType: "AGENT",
        projectRole: "OWNER", // even the highest project role does not help
        allowedScopes: ["project:progress:write", "project:actuals:write"],
      }),
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "planning-agent",
          scopes: ["project:progress:write", "project:actuals:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "baseline.publish" },
      }),
    ).rejects.toBeInstanceOf(AgentPlanApprovalRequiredError);
  });

  it("CONTROL: a HUMAN owner may publish, so the rejection above is about the agent", async () => {
    const authorizer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000004",
        principalType: "HUMAN",
        projectRole: "OWNER",
        allowedScopes: [],
      }),
    });

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "human", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "baseline.publish" },
      }),
    ).resolves.toEqual({ type: "HUMAN", id: "90000000-0000-4000-8000-000000000004" });
  });

  it("denies an agent when the token omits a scope allowed by its stored grant", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "progress-agent", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "task.update", taskId: "task-1", changes: { progressBasisPoints: 7_500 } },
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it("denies a human viewer and an identity without a project grant", async () => {
    const viewer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000003",
        principalType: "HUMAN",
        projectRole: "VIEWER",
        allowedScopes: [],
      }),
    });
    const unprovisioned = createProjectCommandAuthorizer({ resolve: async () => null });
    const request = {
      identity: { issuer: "https://identity.example.test/", subject: "viewer", scopes: [] },
      tenantId: "00000000-0000-4000-8000-000000000001",
      projectId: "10000000-0000-4000-8000-000000000001",
      command: { type: "task.delete" as const, taskId: "task-1" },
    };

    await expect(viewer.authorize(request)).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(unprovisioned.authorize(request)).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});

describe("ProjectQueryAuthorizer", () => {
  it("allows every provisioned project role to read the grid", async () => {
    const grant = {
      principalId: "90000000-0000-4000-8000-000000000003",
      principalType: "HUMAN" as const,
      projectRole: "VIEWER" as const,
      allowedScopes: [],
    };
    const authorizer = createProjectQueryAuthorizer({ resolve: async () => grant });

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "viewer", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual(grant);
  });

  it("denies an identity without a project grant", async () => {
    const authorizer = createProjectQueryAuthorizer({ resolve: async () => null });
    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "missing", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});
