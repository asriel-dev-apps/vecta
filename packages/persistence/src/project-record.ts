export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly projectStart: string;
  readonly statusDate: string;
  readonly defaultCalendarId: string;
  readonly revision: bigint;
  /** Next per-project display No. to hand out (Design 0003 §F-1). */
  readonly nextTaskSeq: number;
}

export interface ProjectCalendarRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly name: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface MemberRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
}

export interface ProcessRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface ProductRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder: number;
}

/** One ordered step of a subtask template (matches the jsonb column shape). */
export interface SubtaskTemplateStepRecord {
  readonly name: string;
  readonly weightBp: number;
  readonly dependsOnPrev?: {
    readonly type: DependencyType;
    readonly lagWorkingDays: number;
  };
}

export interface TemplateRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtasks: readonly SubtaskTemplateStepRecord[];
}

export interface TaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly sortOrder: number;
  /** Immutable per-project display No. (Design 0003 §F-1). */
  readonly seq: number;
  readonly name: string;
  readonly processId: string | null;
  readonly productId: string | null;
  readonly note: string;
  readonly contract: string;
  readonly assigneeMemberId: string | null;
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly actualEffortMinutes: number;
  /** Basis-point proration weight (0–10000) for template-generated subtasks; null otherwise. */
  readonly prorationWeightBp: number | null;
  readonly dailyPlan: Readonly<Record<string, number>>;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
}

export interface TaskDependencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly predecessorTaskId: string;
  readonly successorTaskId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectRevision: bigint;
  readonly actorType: "HUMAN" | "AGENT" | "SYSTEM";
  readonly actorId: string;
  readonly commandType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface PersistedProjectRecord {
  readonly tenant: TenantRecord;
  readonly project: ProjectRecord;
  readonly calendars: readonly ProjectCalendarRecord[];
  readonly members: readonly MemberRecord[];
  readonly processes: readonly ProcessRecord[];
  readonly products: readonly ProductRecord[];
  readonly templates: readonly TemplateRecord[];
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
  readonly auditEvents: readonly AuditEventRecord[];
}
