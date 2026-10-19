import {
  diffOperation,
  ProjectCommandValidationError,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@vecta/application";

/**
 * An in-memory {@link ProjectCommandUnitOfWork} that mirrors the persistence
 * unit of work's transition: one `diffOperation` (which runs
 * `applyProjectCommand`, including the generateSubtasks scheduler) and a +1
 * revision, or a conflict when `expectedRevision` is stale.
 *
 * It is the "server transition" the convergence test compares the client
 * optimistic transition against, and the persistence seam the action-core test
 * injects so the write path is exercised with no real Postgres. No idempotency
 * ledger: these tests send one operation per id.
 */
export class FakeProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  private currentState: ProjectState;
  private currentRevision: bigint;
  executeCount = 0;

  constructor(state: ProjectState, revision: bigint) {
    this.currentState = state;
    this.currentRevision = revision;
  }

  get state(): ProjectState {
    return this.currentState;
  }

  get revision(): bigint {
    return this.currentRevision;
  }

  async execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution> {
    this.executeCount += 1;
    if (this.currentRevision !== request.expectedRevision) {
      throw new ProjectVersionConflictError(request.expectedRevision, this.currentRevision);
    }
    try {
      this.currentState = diffOperation(this.currentState, request.commands).after;
    } catch (error) {
      if (error instanceof ProjectCommandValidationError) throw error;
      throw new ProjectCommandValidationError(
        error instanceof Error ? error.message : "Project command is invalid",
      );
    }
    this.currentRevision += 1n;
    return { projectId: request.projectId, revision: this.currentRevision, replayed: false };
  }
}
