import {
  calculateEffortEvm,
  type EffortRollup,
  type TaskStatus,
} from "@vecta/domain";
import type { ProjectRole } from "./project-command-authorizer.js";
import { leafTaskIds, type ProjectMember, type ProjectState } from "./project-state.js";

/**
 * Viewer role for the API read models. This module is the single choke point
 * where ⑦ strips role-sensitive member fields (per-resource capacity today; the
 * Phase-2 rate/productivity) for the general role, so no route ever hand-rolls
 * the projection. PRIVILEGED sees every field; GENERAL sees the non-sensitive
 * projection (ADR 0011 Decision 7 / D18: projected out at the API boundary, not
 * merely hidden in the UI).
 */
export type ProjectionRole = "PRIVILEGED" | "GENERAL";

/**
 * Map the persisted project role to the read-model projection role. OWNER and
 * EDITOR are PRIVILEGED; every other role (VIEWER) is GENERAL. Pure so the role
 * decision is unit-testable in isolation from HTTP and auth wiring.
 */
export function projectionRoleForProjectRole(projectRole: ProjectRole): ProjectionRole {
  return projectRole === "OWNER" || projectRole === "EDITOR" ? "PRIVILEGED" : "GENERAL";
}

/**
 * Member as the GENERAL read model sees it: the sensitive per-resource capacity
 * (and future rate/productivity) is absent from the type, so it cannot be
 * emitted downstream. PRIVILEGED keeps the full {@link ProjectMember}.
 */
export type GeneralProjectMember = Omit<ProjectMember, "dailyCapacityMinutes">;
export type ProjectMemberView = ProjectMember | GeneralProjectMember;

/** Project read model with members narrowed to whatever the role may read. */
export interface ProjectStateView extends Omit<ProjectState, "members"> {
  readonly members: readonly ProjectMemberView[];
}

/**
 * Drop the privileged-only member fields, keeping the key absent (not null) so
 * `"dailyCapacityMinutes" in member` is false in the general read model. The one
 * place that enumerates the general-visible member fields.
 */
function stripSensitiveMemberFields(member: ProjectMember): GeneralProjectMember {
  return { id: member.id, name: member.name, calendarId: member.calendarId };
}

/**
 * Role-scoped project read model for the workspace-load endpoint. GENERAL gets a
 * member projection with the sensitive capacity removed at the structure level;
 * PRIVILEGED gets the project unchanged.
 */
export function projectWorkspaceView(
  project: ProjectState,
  role: ProjectionRole,
): ProjectStateView {
  if (role === "PRIVILEGED") return project;
  return { ...project, members: project.members.map(stripSensitiveMemberFields) };
}

export interface WbsGridTaskRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  /** Immutable per-project display No. (Design 0003 §F-1); shown in the No. column. */
  readonly seq: number;
  // Meta columns B/C/D-F/E/G/H/I/J.
  readonly name: string;
  readonly processId: string | null;
  readonly productId: string | null;
  /** Resolved 工程 master name (empty string when unset). */
  readonly processName: string;
  /** Resolved プロダクト master name (empty string when unset). */
  readonly productName: string;
  readonly note: string;
  readonly contract: string;
  readonly assigneeMemberId: string | null;
  readonly assigneeName: string | null;
  // Stored inputs L/T/W/R/S and the daily plot.
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly actualEffortMinutes: number;
  readonly prorationWeightBp: number | null;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
  readonly dailyPlan: Readonly<Record<string, number>>;
  // Non-blocking consistency flags (Design 0003 §C-2). Computed purely from the
  // tree; the grid surfaces them as row-level warnings and never overwrites.
  /** Summary (non-leaf) task whose L ≠ Σ of its direct children's L. */
  readonly parentEffortMismatch: boolean;
  /** Leaf task whose L ≠ Σ of its daily-plan minutes. */
  readonly estimateVsDailyMismatch: boolean;
  // Derived columns K/M/N/O/P/Q/T/U/V/W(hours)/X (from the effort EVM module).
  readonly plannedEffortDays: number;
  readonly plannedEffortHours: number;
  readonly plannedEarnedHours: number;
  readonly plannedProgress: number;
  readonly plannedStart: string | null;
  readonly plannedFinish: string | null;
  readonly progress: number;
  readonly status: TaskStatus;
  readonly earnedEffortHours: number;
  readonly actualEffortHours: number;
  readonly costVarianceHours: number;
}

export interface WbsGridProjection {
  readonly projectId: string;
  readonly statusDate: string;
  readonly rows: readonly WbsGridTaskRow[];
  readonly rollup: EffortRollup;
}

export interface WbsGridProjectionOptions {
  readonly role?: ProjectionRole;
}

export function projectWbsGrid(
  project: ProjectState,
  options: WbsGridProjectionOptions = {},
): WbsGridProjection {
  const role = options.role ?? "PRIVILEGED";
  // ⑦ role projection: member data reaches the grid only through the role-scoped
  // read model (the single choke point), so a general grid can never carry a
  // privileged-only member field — today the grid surfaces the non-sensitive
  // assignee name only, and any future rate/productivity column stays absent for
  // GENERAL by construction.
  const scopedMembers = projectWorkspaceView(project, role).members;
  const memberNameById = new Map(scopedMembers.map((member) => [member.id, member.name]));
  const processNameById = new Map(project.processes.map((process) => [process.id, process.name]));
  const productNameById = new Map(project.products.map((product) => [product.id, product.name]));

  const leaves = leafTaskIds(project.tasks);
  // Σ of each parent's direct children's planned effort, for the parent-vs-child
  // consistency flag. Built once over the flat task list (O(tasks)).
  const directChildEffortByParent = new Map<string, number>();
  for (const task of project.tasks) {
    if (task.parentId === null) continue;
    directChildEffortByParent.set(
      task.parentId,
      (directChildEffortByParent.get(task.parentId) ?? 0) + task.plannedEffortMinutes,
    );
  }
  const effort = calculateEffortEvm({
    statusDate: project.statusDate,
    tasks: project.tasks.map((task) => ({
      id: task.id,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      dailyPlan: task.dailyPlan,
      isLeaf: leaves.has(task.id),
    })),
  });
  const metricsById = new Map(effort.tasks.map((metrics) => [metrics.id, metrics]));

  const rows = project.tasks
    .map((task): WbsGridTaskRow => {
      const metrics = metricsById.get(task.id);
      if (metrics === undefined) {
        throw new Error(`Missing effort metrics for task ${task.id}`);
      }
      const isLeaf = leaves.has(task.id);
      const dailyPlanMinutes = Object.values(task.dailyPlan).reduce(
        (sum, minutes) => sum + minutes,
        0,
      );
      return {
        id: task.id,
        parentId: task.parentId,
        sortOrder: task.sortOrder,
        seq: task.seq,
        name: task.name,
        processId: task.processId,
        productId: task.productId,
        processName: task.processId === null ? "" : processNameById.get(task.processId) ?? "",
        productName: task.productId === null ? "" : productNameById.get(task.productId) ?? "",
        note: task.note,
        contract: task.contract,
        assigneeMemberId: task.assigneeMemberId,
        assigneeName:
          task.assigneeMemberId === null
            ? null
            : memberNameById.get(task.assigneeMemberId) ?? null,
        plannedEffortMinutes: task.plannedEffortMinutes,
        progressBasisPoints: task.progressBasisPoints,
        actualEffortMinutes: task.actualEffortMinutes,
        prorationWeightBp: task.prorationWeightBp,
        actualStart: task.actualStart,
        actualFinish: task.actualFinish,
        dailyPlan: task.dailyPlan,
        parentEffortMismatch:
          !isLeaf &&
          task.plannedEffortMinutes !== (directChildEffortByParent.get(task.id) ?? 0),
        estimateVsDailyMismatch: isLeaf && task.plannedEffortMinutes !== dailyPlanMinutes,
        plannedEffortDays: metrics.plannedEffortDays,
        plannedEffortHours: metrics.plannedEffortHours,
        plannedEarnedHours: metrics.plannedEarnedHours,
        plannedProgress: metrics.plannedProgress,
        plannedStart: metrics.plannedStart,
        plannedFinish: metrics.plannedFinish,
        progress: metrics.progress,
        status: metrics.status,
        earnedEffortHours: metrics.earnedEffortHours,
        actualEffortHours: metrics.actualEffortHours,
        costVarianceHours: metrics.costVarianceHours,
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  return {
    projectId: project.id,
    statusDate: project.statusDate,
    rows,
    rollup: effort.rollup,
  };
}
