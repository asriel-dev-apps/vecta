import { applyEffortSchedule, type ProjectState } from "@vecta/application";
import { createDemoProject, type DemoProjectOptions } from "./demo-project";

/**
 * A synthetic, fully-scheduled {@link ProjectState} for the Step-4a tests. Mirrors
 * the SPA's `demoProjectScheduled`: `createDemoProject` (deterministic, anonymised
 * — "Phase A" / "Product 1" / "Member 01", no real values) then a one-shot
 * `applyEffortSchedule` so every leaf carries a daily plan and the grid's day axis
 * is non-empty. No `.wbs-private/` data is ever read.
 */
export function scheduledProject(options: DemoProjectOptions): ProjectState {
  return applyEffortSchedule(createDemoProject(options));
}
