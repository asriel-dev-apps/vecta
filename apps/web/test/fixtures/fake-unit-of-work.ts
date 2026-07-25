import {
  applyEffortSchedule,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@vecta/application";

/**
 * An in-memory {@link ProjectCommandUnitOfWork} that mirrors
 * `PostgresProjectCommandUnitOfWork`'s transition semantics EXACTLY
 * (`packages/persistence` project-command-unit-of-work ~124–297) without a
 * database: the optimistic-lock conflict check, the service-supplied transition,
 * and the `task.generateSubtasks`-only scheduler branch over just the
 * newly-created leaf ids, then a +1 revision bump.
 *
 * It is the "server transition" the §0 convergence test compares the client
 * optimistic transition against, and the persistence seam the action-core test
 * injects so the write path is exercised with no real Postgres. No idempotency
 * ledger: block-during-save means one command per key in these tests.
 *
 * Scope: this proves TRANSITION equality — that `transition(state)` (plus the
 * generateSubtasks scheduler branch) yields the same next state the client
 * derives. It deliberately does NOT reload from a store or re-sort by `sortOrder`
 * on the way out, so it does not prove the Postgres UoW's persist→reload→re-sort
 * round trip preserves that state; that round-trip equality is a persistence-layer
 * concern covered by `packages/persistence`'s own tests, not here.
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

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    this.executeCount += 1;
    if (this.currentRevision !== request.expectedRevision) {
      throw new ProjectVersionConflictError(request.expectedRevision, this.currentRevision);
    }
    const transitioned = transition(this.currentState);
    let next: ProjectState;
    if (request.command.type === "task.generateSubtasks") {
      const existing = new Set(this.currentState.tasks.map((task) => task.id));
      const newTaskIds = new Set(
        transitioned.tasks.filter((task) => !existing.has(task.id)).map((task) => task.id),
      );
      next = applyEffortSchedule(transitioned, newTaskIds);
    } else {
      next = transitioned;
    }
    this.currentState = next;
    this.currentRevision += 1n;
    return { projectId: request.projectId, revision: this.currentRevision, replayed: false };
  }
}
