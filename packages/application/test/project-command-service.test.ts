import { describe, expect, it } from "vitest";
import {
  createProjectCommandService,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "../src/index.js";

const initialProject: ProjectState = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Effort project",
  projectStart: "2026-01-05",
  statusDate: "2026-01-20",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      parentId: null,
      sortOrder: 0,
      seq: 1,
      name: "Subtask",
      processId: null,
      productId: null,
      note: "",
      contract: "",
      assigneeMemberId: null,
      plannedEffortMinutes: 480,
      progressBasisPoints: 2_000,
      actualEffortMinutes: 300,
      prorationWeightBp: null,
      dailyPlan: { "2026-01-05": 480 },
      actualStart: "2026-01-05",
      actualFinish: null,
      dependencies: [],
    },
  ],
  nextTaskSeq: 2,
};

class InMemoryProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  private project = initialProject;

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    this.project = transition(this.project);
    return {
      projectId: request.projectId,
      revision: request.expectedRevision + 1n,
      replayed: false,
    };
  }

  readProject(): ProjectState {
    return this.project;
  }
}

describe("ProjectCommandService", () => {
  it("applies a validated project command through the shared transaction boundary", async () => {
    const unitOfWork = new InMemoryProjectCommandUnitOfWork();
    const service = createProjectCommandService(unitOfWork);

    const result = await service.execute({
      tenantId: "00000000-0000-4000-8000-000000000001",
      projectId: initialProject.id,
      expectedRevision: 4n,
      idempotencyKey: "command-001",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.update",
        taskId: initialProject.tasks[0]!.id,
        changes: { progressBasisPoints: 5_500, actualEffortMinutes: 900 },
      },
    });

    expect(result).toEqual({
      projectId: initialProject.id,
      revision: 5n,
      replayed: false,
    });
    expect(unitOfWork.readProject().tasks[0]).toMatchObject({
      progressBasisPoints: 5_500,
      actualEffortMinutes: 900,
    });
  });
});
