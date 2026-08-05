import type { RouterContextProvider } from "react-router";
import {
  projectionRoleForProjectRole,
  projectWorkspaceView,
  type ProjectionRole,
  type ProjectState,
} from "@vecta/application";
import type { BaselineSnapshotTask } from "@vecta/persistence";
import {
  requireProjectMembership,
  requireProjectWorkspace,
} from "./project-access.server";

/**
 * ADR 0012 Step 4c — the ONE role-scoped project-view loader, shared by the WBS
 * route and every master route (工程/プロダクト, メンバー, サブタスクテンプレート).
 * Factoring it means no loader can ever bypass the `projectWorkspaceView`
 * projection choke point: every route sends the SAME role-scoped state view over
 * the wire, so a GENERAL viewer never receives per-member `dailyCapacityMinutes`
 * (ADR 0011 D18 — stripped at the structure level, not hidden in the UI).
 *
 * The parent `/projects/:id` access gate has already validated the id +
 * membership and installed the memoised workspace thunk; this reads through it,
 * so the workspace batch is the route's ONLY project round trip (the gate no
 * longer fetches the project row separately — the batch's header IS that row).
 * The grid is NOT sent: it is derived isomorphically from the view on both sides.
 */

/** The role-scoped payload every project-view route returns to its client. */
export interface ProjectViewPayload {
  readonly revision: string;
  readonly stateView: ProjectState;
  readonly projectionRole: ProjectionRole;
  /**
   * The latest published baseline, or `null` when the plan has never been frozen
   * (Design 0009). `sourceRevision` is a string for the same reason `revision` is:
   * a bigint does not survive the loader's JSON.
   *
   * It carries no per-member capacity or rate, so unlike `stateView` it needs no
   * role projection — every column in it is already visible to GENERAL through the
   * grid.
   */
  readonly baseline: BaselineView | null;
}

export interface BaselineView {
  readonly version: number;
  readonly sourceRevision: string;
  readonly publishedAt: string;
  readonly tasks: readonly BaselineSnapshotTask[];
}

export async function loadProjectView(
  context: Readonly<RouterContextProvider>,
): Promise<ProjectViewPayload> {
  const membership = requireProjectMembership(context);
  // A workspace that is gone fails closed inside the gate's thunk with the same
  // opaque 404 the membership denial throws, so there is no `null` to handle and
  // no existence oracle to leak.
  const workspace = await requireProjectWorkspace(context);
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
    baseline:
      workspace.baseline === null
        ? null
        : {
            version: workspace.baseline.version,
            sourceRevision: workspace.baseline.sourceRevision.toString(),
            publishedAt: workspace.baseline.publishedAt,
            tasks: workspace.baseline.tasks,
          },
  };
}
