// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import type { ProjectState } from "@vecta/application";
import {
  loadProjectView,
  type ProjectWorkspaceRecord,
} from "~/server/project/load-project-view.server";
import { dbSessionContext, projectAccessContext } from "~/server/context";
import type { DbSession } from "~/server/db-session.server";
import type { ProjectMembershipView } from "~/server/project/project-access";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4c — the shared role-scoped view loader is the projection choke
// point every project route (wbs + masters/members/templates) goes through. These
// tests inject an in-memory workspace loader so the helper runs with no Neon
// connection, and pin the D18 wire invariant: a GENERAL (VIEWER) membership's
// payload carries NO per-member `dailyCapacityMinutes` — stripped at the structure
// level, not merely hidden in the UI — while a PRIVILEGED membership keeps it.

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const project: ProjectState = createDemoProject({
  parentCount: 2,
  subtasksPerParent: 2,
  memberCount: 3,
});

function fakeSession(): DbSession {
  // The injected workspace loader ignores the handle, so it is never touched.
  return {
    read: () => ({}) as never,
    database: () => ({}) as never,
    close: async () => undefined,
  };
}

function contextFor(
  projectRole: ProjectMembershipView["projectRole"],
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(projectAccessContext, async () => ({
    project: { id: PROJECT_ID, tenantId: TENANT_ID, name: "Project 1" },
    membership: { tenantId: TENANT_ID, projectId: PROJECT_ID, projectRole },
  }));
  context.set(dbSessionContext, fakeSession());
  return context;
}

function workspaceLoaderReturning(record: ProjectWorkspaceRecord | null) {
  return () => ({ load: async () => record });
}

describe("loadProjectView — the shared role-scoped view loader (D18)", () => {
  it("strips dailyCapacityMinutes from a GENERAL (VIEWER) membership payload", async () => {
    const payload = await loadProjectView(contextFor("VIEWER"), {
      workspaceLoaderFor: workspaceLoaderReturning({ revision: 7n, current: project }),
    });

    expect(payload.projectionRole).toBe("GENERAL");
    expect(payload.revision).toBe("7");
    // The wire invariant: the capacity KEY is absent (not present-but-undefined) on
    // every member of the state view a viewer receives.
    expect(payload.stateView.members.length).toBeGreaterThan(0);
    for (const member of payload.stateView.members) {
      expect("dailyCapacityMinutes" in member).toBe(false);
    }
  });

  it("keeps dailyCapacityMinutes for a PRIVILEGED (OWNER/EDITOR) membership", async () => {
    const payload = await loadProjectView(contextFor("OWNER"), {
      workspaceLoaderFor: workspaceLoaderReturning({ revision: 12n, current: project }),
    });

    expect(payload.projectionRole).toBe("PRIVILEGED");
    expect(payload.revision).toBe("12");
    for (const member of payload.stateView.members) {
      expect(typeof (member as { dailyCapacityMinutes?: number }).dailyCapacityMinutes).toBe(
        "number",
      );
    }
  });

  it("throws a 404 when the workspace row is not readable", async () => {
    await expect(
      loadProjectView(contextFor("OWNER"), {
        workspaceLoaderFor: workspaceLoaderReturning(null),
      }),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});
