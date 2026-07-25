// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "@vecta/application";
import { App as WbsApp } from "~/wbs/wbs-app";
import { scheduledProject } from "./fixtures/wbs";

// The virtualizer measures via offsetWidth/offsetHeight; happy-dom does no layout,
// so shim them to the grid's `initialRect` (1440×720). That makes the post-mount
// measurement equal the first-render window, so nothing re-renders after hydration
// and any warning we observe is a genuine hydration mismatch, not measurement churn.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 720 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1440 });
});

afterEach(() => vi.restoreAllMocks());

// React logs hydration mismatches through console.error with these markers. (The
// happy-dom-only "useLayoutEffect does nothing on the server" notice — an artifact
// of document existing during renderToString here — is deliberately NOT in this
// set; the node SSR suite proves that warning is absent in a real server env.)
const MISMATCH = /hydrat|did not match|server rendered|server HTML|text content does not match/i;

function hydrationMismatches(project: ProjectState): string[] {
  const el = <WbsApp initialState={project} initialRevision="1" projectionRole="PRIVILEGED" />;
  const html = renderToString(el);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
  act(() => {
    hydrateRoot(container, el);
  });
  spy.mockRestore();
  container.remove();
  return errors.filter((message) => MISMATCH.test(message));
}

describe("client hydration matches the server render (no mismatch)", () => {
  it("hydrates a small (8-task) fixture with no mismatch", () => {
    const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
    expect(project.tasks.length).toBe(8);
    expect(hydrationMismatches(project)).toEqual([]);
  });

  it("hydrates a large (5000-task) fixture with no mismatch", () => {
    const project = scheduledProject({ parentCount: 500, subtasksPerParent: 9, memberCount: 40 });
    expect(project.tasks.length).toBe(5000);
    expect(hydrationMismatches(project)).toEqual([]);
  });
});
