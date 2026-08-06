// @vitest-environment node

import { describe, expect, it } from "vitest";
import { data, RouterContextProvider } from "react-router";
import type { ProjectState } from "@vecta/application";
import { loadProjectView } from "~/server/project/load-project-view.server";
import {
  projectMembershipContext,
  projectWorkspaceContext,
} from "~/server/context.server";
import type {
  ProjectMembershipView,
  ProjectWorkspaceRecord,
} from "~/server/project/project-access.server";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4c — the shared role-scoped view loader is the projection choke
// point every project route (wbs + masters/members/templates) goes through. These
// tests seed the gate's memoised workspace thunk in memory so the helper runs with
// no Neon connection, and pin the D18 wire invariant: a GENERAL (VIEWER)
// membership's payload carries NO per-member `dailyCapacityMinutes` — stripped at
// the structure level, not merely hidden in the UI — while a PRIVILEGED
// membership keeps it.

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const project: ProjectState = createDemoProject({
  parentCount: 2,
  subtasksPerParent: 2,
  memberCount: 3,
});

function contextFor(
  projectRole: ProjectMembershipView["projectRole"],
  workspace: () => Promise<ProjectWorkspaceRecord>,
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(projectMembershipContext, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    projectRole,
  });
  context.set(projectWorkspaceContext, workspace);
  return context;
}

function workspaceReturning(record: ProjectWorkspaceRecord) {
  return async () => record;
}

describe("loadProjectView — the shared role-scoped view loader (D18)", () => {
  it("strips dailyCapacityMinutes from a GENERAL (VIEWER) membership payload", async () => {
    const payload = await loadProjectView(
      contextFor("VIEWER", workspaceReturning({ revision: 7n, current: project , baseline: null })),
    );

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
    const payload = await loadProjectView(
      contextFor("OWNER", workspaceReturning({ revision: 12n, current: project , baseline: null })),
    );

    expect(payload.projectionRole).toBe("PRIVILEGED");
    expect(payload.revision).toBe("12");
    for (const member of payload.stateView.members) {
      expect(typeof (member as { dailyCapacityMinutes?: number }).dailyCapacityMinutes).toBe(
        "number",
      );
    }
  });

  it("propagates the gate's 404 when the workspace row is not readable", async () => {
    // The unreadable-workspace 404 now lives in the gate's thunk (the same place
    // the membership denial throws), so the view loader has no `null` branch of
    // its own — it must surface the gate's failure untouched.
    await expect(
      loadProjectView(
        contextFor("OWNER", async () => {
          throw data(null, { status: 404 });
        }),
      ),
    ).rejects.toMatchObject({ init: { status: 404 }, data: null });
  });
});
