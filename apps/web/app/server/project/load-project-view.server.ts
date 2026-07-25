import { data, type RouterContextProvider } from "react-router";
import {
  projectionRoleForProjectRole,
  projectWorkspaceView,
  type ProjectionRole,
  type ProjectState,
} from "@vecta/application";
import {
  NeonHttpProjectWorkspaceReader,
  type NeonHttpReadDatabase,
} from "@vecta/persistence";
import { requireProjectAccess } from "./project-access";
import { dbSessionContext } from "../context";

/**
 * ADR 0012 Step 4c — the ONE role-scoped project-view loader, shared by the WBS
 * route and every master route (工程/プロダクト, メンバー, サブタスクテンプレート).
 * Factoring it means no loader can ever bypass the `projectWorkspaceView`
 * projection choke point: every route sends the SAME role-scoped state view over
 * the wire, so a GENERAL viewer never receives per-member `dailyCapacityMinutes`
 * (ADR 0011 D18 — stripped at the structure level, not hidden in the UI).
 *
 * It mirrors the pre-4c `project.wbs.tsx` loader exactly: the parent
 * `/projects/:id` access gate has already validated the id + membership, so this
 * reads the persisted workspace through the SHARED per-request DB session
 * (§4-pre — one Neon connection for principal + project row + workspace) and
 * returns `{ revision (bigint→string), stateView, projectionRole }`. The grid is
 * NOT sent: it is derived isomorphically from the view on both sides.
 */

/** The workspace snapshot a loader reads: the current state + its bigint revision. */
export interface ProjectWorkspaceRecord {
  readonly revision: bigint;
  readonly current: ProjectState;
}

/** The persistence seam a loader reads the workspace through (fakeable in tests). */
export interface ProjectWorkspaceLoader {
  load(tenantId: string, projectId: string): Promise<ProjectWorkspaceRecord | null>;
}

/** The role-scoped payload every project-view route returns to its client. */
export interface ProjectViewPayload {
  readonly revision: string;
  readonly stateView: ProjectState;
  readonly projectionRole: ProjectionRole;
}

export interface LoadProjectViewDeps {
  /**
   * Build the workspace loader over the request's read handle. Production wraps
   * the shared session's `NeonHttpProjectWorkspaceReader`; tests inject an
   * in-memory fake so the loader runs with no real Neon endpoint.
   */
  readonly workspaceLoaderFor?: (database: NeonHttpReadDatabase) => ProjectWorkspaceLoader;
}

export async function loadProjectView(
  context: Readonly<RouterContextProvider>,
  deps: LoadProjectViewDeps = {},
): Promise<ProjectViewPayload> {
  const { project, membership } = await requireProjectAccess(context);
  const session = context.get(dbSessionContext);
  const workspaceLoaderFor =
    deps.workspaceLoaderFor ?? ((database) => new NeonHttpProjectWorkspaceReader(database));
  const workspace = await workspaceLoaderFor(session.read()).load(
    membership.tenantId,
    project.id,
  );
  if (workspace === null) {
    // The gate confirmed the membership, but the project row was not readable for
    // the workspace load (e.g. deleted between the access check and this read).
    // Surface the layout gate's opaque 404 rather than a 500.
    throw data(null, { status: 404 });
  }
  const projectionRole = projectionRoleForProjectRole(membership.projectRole);
  // The role-scoped read model (ADR 0011 D18 / ⑦): GENERAL drops per-member
  // capacity at the STRUCTURE level, so a viewer never receives it on the wire.
  // The view is the only project payload sent to the client; the cast to
  // `ProjectState` mirrors the SPA's connected mode (which typed the general view
  // the same way and guards the absent capacity at runtime via `typeof`).
  const stateView = projectWorkspaceView(workspace.current, projectionRole) as ProjectState;
  return {
    revision: workspace.revision.toString(),
    stateView,
    projectionRole,
  };
}
