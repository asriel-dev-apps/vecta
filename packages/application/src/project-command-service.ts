import type { ProjectCommand } from "./project-state.js";

export interface AuditActor {
  readonly type: "HUMAN" | "AGENT" | "SYSTEM";
  readonly id: string;
}

export interface ProjectCommandRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly expectedRevision: bigint;
  readonly operationId: string;
  readonly actor: AuditActor;
  readonly commands: readonly ProjectCommand[];
}

export interface ProjectCommandExecution {
  readonly projectId: string;
  readonly revision: bigint;
  readonly replayed: boolean;
}

export interface ProjectCommandUnitOfWork {
  execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution>;
}

export interface ProjectCommandService {
  execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectVersionConflictError extends Error {
  constructor(
    readonly expectedRevision: bigint,
    readonly actualRevision: bigint,
  ) {
    super(`Project revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "ProjectVersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`Idempotency key was reused for a different command: ${operationId}`);
    this.name = "IdempotencyConflictError";
  }
}

export class ProjectCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCommandValidationError";
  }
}

export function createProjectCommandService(
  unitOfWork: ProjectCommandUnitOfWork,
): ProjectCommandService {
  return {
    execute(request) {
      if (
        request.tenantId.trim().length === 0 ||
        request.projectId.trim().length === 0 ||
        request.operationId.trim().length === 0 ||
        request.actor.id.trim().length === 0 ||
        request.expectedRevision < 0n ||
        request.commands.length === 0
      ) {
        throw new Error("Project command envelope is invalid");
      }
      if (request.commands.length > 1 && request.commands.some((command) => command.type !== "task.update")) {
        throw new ProjectCommandValidationError("Only task.update commands may be combined in one operation");
      }

      return unitOfWork.execute(request);
    },
  };
}
