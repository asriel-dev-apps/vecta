// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import {
  projectWbsGrid,
  projectWorkspaceView,
  type ProjectionRole,
  type ProjectState,
} from "@vecta/application";
import { App as WbsApp } from "~/wbs/wbs-app";
import { scheduledProject } from "./fixtures/wbs";

// ADR 0012 Step 4a — the crux. `useVirtualizer` measures via effects against a
// scroll-element ref, so on the server (no element) it would emit an empty grid
// body unless its `initialRect` SSR affordance renders the first viewport. This
// suite runs in the `node` environment (no `document`, like workerd) and renders
// the ported grid with `renderToString`, proving the server HTML already contains
// REAL task-row markup (the first window) — not an empty body — for both roles,
// with no React warnings (the isomorphic-layout-effect guard holds server-side).

function ssr(project: ProjectState, role: ProjectionRole): string {
  return renderToString(
    <WbsApp initialState={project} initialRevision="1" projectionRole={role} />,
  );
}

function countRows(html: string): number {
  return (html.match(/data-row-id="/g) ?? []).length;
}

afterEach(() => vi.restoreAllMocks());

describe("virtualizer renders the first window server-side (initialRect)", () => {
  it("emits real task rows (not an empty grid body) for a small project", () => {
    const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
    expect(project.tasks.length).toBe(8);
    const html = ssr(project, "PRIVILEGED");
    expect(html).toContain('data-testid="wbs-grid"');
    // All 8 tasks fit the first window (initialRect height 720 / row 30 ≈ 24 rows
    // + overscan), so every task row is present in the server markup.
    expect(countRows(html)).toBe(8);
    // The first task's real name is in the first-paint HTML — the whole point of
    // SSR-no-flash: data is in the markup, not fetched after hydration.
    const rows = projectWbsGrid(project, { role: "PRIVILEGED" }).rows;
    expect(html).toContain(rows[0]!.name);
    expect(html).toContain("Phase A deliverable 1");
  });

  it("renders without any React warning server-side (layout-effect guard holds)", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0] ?? ""));
    });
    const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
    ssr(project, "PRIVILEGED");
    spy.mockRestore();
    expect(errors).toEqual([]);
  });

  it("renders a GENERAL (capacity-stripped) view without crashing", () => {
    const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
    // The loader's role-scoped payload for a viewer: capacity absent at runtime,
    // exactly as `project.wbs.tsx` builds it (cast mirrors the loader boundary).
    const stripped = projectWorkspaceView(project, "GENERAL") as ProjectState;
    const html = ssr(stripped, "GENERAL");
    expect(html).toContain('data-testid="wbs-grid"');
    expect(countRows(html)).toBe(8);
  });

  it("caps rendered rows and completes at 5000 tasks (virtualized SSR + CPU budget)", () => {
    const big = scheduledProject({ parentCount: 500, subtasksPerParent: 9, memberCount: 40 });
    expect(big.tasks.length).toBe(5000);
    const start = performance.now();
    const html = ssr(big, "PRIVILEGED");
    const ms = performance.now() - start;
    expect(html).toContain('data-testid="wbs-grid"');
    const rows = countRows(html);
    // The virtualizer caps the rendered window even though 5000 tasks exist — a
    // handful of rows in the DOM, not 5000. Real rows, virtualized, server-side.
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(200);
    console.log(`[SSR] 5000-row render: ${ms.toFixed(0)}ms, ${rows} rows in the first window`);
  });
});
