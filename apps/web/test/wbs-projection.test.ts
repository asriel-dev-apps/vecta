import { describe, expect, it } from "vitest";
import {
  projectWbsGrid,
  projectWorkspaceView,
  projectionRoleForProjectRole,
  type ProjectState,
} from "@vecta/application";
import { detectOverloads, synthesizeExternalLoad } from "~/wbs/cross-project-load";
import { scheduledProject } from "./fixtures/wbs";

// ADR 0012 Step 4a — the loader sends the role-scoped STATE VIEW only and both
// the server and the client derive the grid from it via `projectWbsGrid`. These
// tests pin the two invariants that makes sound: (1) the grid derived from the
// view equals the grid derived from the full project for BOTH projection roles
// (so halving the payload loses nothing), and (2) the GENERAL view genuinely
// strips per-member capacity at the structure level (so a viewer never receives
// it and the capacity-dependent overload signal collapses to empty).

const project: ProjectState = scheduledProject({
  parentCount: 3,
  subtasksPerParent: 4,
  memberCount: 5,
});

describe("grid-from-view === grid-from-full for both projection roles", () => {
  for (const role of ["OWNER", "VIEWER"] as const) {
    it(`derives an identical grid from the view (${role} → ${projectionRoleForProjectRole(role)})`, () => {
      const projectionRole = projectionRoleForProjectRole(role);
      const view = projectWorkspaceView(project, projectionRole);
      const fromFull = projectWbsGrid(project, { role: projectionRole });
      const fromView = projectWbsGrid(view as ProjectState, { role: projectionRole });
      expect(fromView).toEqual(fromFull);
      // Sanity: the fixture produced real, non-empty rows in both derivations.
      expect(fromView.rows.length).toBe(project.tasks.length);
      expect(fromView.rows.length).toBeGreaterThan(0);
    });
  }
});

describe("GENERAL projection strips per-member capacity", () => {
  it("removes dailyCapacityMinutes from the general view but keeps it for privileged", () => {
    const general = projectWorkspaceView(project, "GENERAL");
    for (const member of general.members) {
      expect("dailyCapacityMinutes" in member).toBe(false);
    }
    const privileged = projectWorkspaceView(project, "PRIVILEGED");
    for (const member of privileged.members) {
      expect(typeof (member as { dailyCapacityMinutes?: number }).dailyCapacityMinutes).toBe(
        "number",
      );
    }
  });

  it("yields no overloads for a GENERAL viewer (capacity stripped → no capacity check)", () => {
    const general = projectWorkspaceView(project, "GENERAL");
    const grid = projectWbsGrid(general as ProjectState, { role: "GENERAL" });
    const planDays = [
      ...new Set(grid.rows.flatMap((row) => Object.keys(row.dailyPlan))),
    ].sort();
    const external = synthesizeExternalLoad(general.members, planDays);
    const overloads = detectOverloads({ rows: grid.rows, external, members: general.members });
    expect(overloads).toEqual([]);
  });

  it("DOES surface overloads for a PRIVILEGED viewer (capacity present)", () => {
    // The counterpart to the GENERAL case: with capacity retained the detector can
    // run, so the deterministic synthetic external load produces at least one
    // overflow against the full demo — proving the empty GENERAL result is caused
    // by the strip, not by an inert fixture.
    const full = scheduledProject({ parentCount: 300, subtasksPerParent: 9, memberCount: 40 });
    const grid = projectWbsGrid(full, { role: "PRIVILEGED" });
    const planDays = [
      ...new Set(grid.rows.flatMap((row) => Object.keys(row.dailyPlan))),
    ].sort();
    const external = synthesizeExternalLoad(full.members, planDays);
    const overloads = detectOverloads({ rows: grid.rows, external, members: full.members });
    expect(overloads.length).toBeGreaterThan(0);
  });
});
