// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRoutesStub, data } from "react-router";
import type { ProjectState } from "@vecta/application";
import ProjectWbs, { shouldRevalidate } from "~/routes/project.wbs";
import { scheduledProject } from "./fixtures/wbs";

// ADR 0012 Step 4b — the P0 regression: a rejected save must RESYNC. This drives a
// REAL 409 through the actual router (`createRoutesStub`) against the real wbs
// Component + the real `shouldRevalidate` predicate + a real fetcher submit — NOT
// the hand-fed `rerender` shortcut of `wbs-connected.test.tsx`. RR 8.2.0 defaults
// revalidation to OFF for an action result with `status >= 400`, so unless
// `shouldRevalidate` forces it back on, the wbs loader never re-runs, the adopt
// effect never fires, and the rejected optimistic edit stays on screen forever.
// This test proves the loader re-ran and the client adopted the fresh server state.

// The virtualizer measures via offsetWidth/offsetHeight; happy-dom does no layout,
// so shim them to the grid's `initialRect` and stub the observer (as the other
// grid suites do) so rows materialise.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 720 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1440 });
});

afterEach(() => cleanup());

const project: ProjectState = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });

async function firstNameCell(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-col="name"]')).not.toBeNull());
  return document.querySelector(
    '.grid-row:not(.grid-row--draft) [data-col="name"]',
  ) as HTMLElement;
}

async function editFirstName(value: string): Promise<void> {
  const cell = await firstNameCell();
  fireEvent.doubleClick(cell);
  const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
  expect(editor).not.toBeNull();
  fireEvent.change(editor, { target: { value } });
  fireEvent.blur(editor);
}

describe("ADR 0012 Step 4b — conflict resync runs through the real router (P0)", () => {
  it("re-runs the loader on a 409 and adopts the fresh server state", async () => {
    const freshProject: ProjectState = {
      ...project,
      tasks: project.tasks.map((task, index) =>
        index === 0 ? { ...task, name: "Fresh from server" } : task,
      ),
    };

    // A tiny mutable "server": the loader reads it, the action mutates it (a
    // concurrent writer) and then rejects the save as a conflict.
    const server = { revision: "7", state: project };
    const loaderRevisions: string[] = [];
    const seenExpectedRevisions: string[] = [];
    let actionCalls = 0;

    const loader = () => {
      loaderRevisions.push(server.revision);
      return {
        revision: server.revision,
        stateView: server.state,
        projectionRole: "PRIVILEGED" as const,
      };
    };
    const action = async ({ request }: { request: Request }) => {
      actionCalls += 1;
      const body = (await request.json()) as { expectedRevision: string };
      seenExpectedRevisions.push(body.expectedRevision);
      if (actionCalls === 1) {
        // A concurrent writer advanced the project to revision 9 while this batch
        // was in flight, so the save is rejected as a version conflict (real 409).
        server.revision = "9";
        server.state = freshProject;
        return data({ ok: false, code: "VERSION_CONFLICT", actualRevision: "9" }, { status: 409 });
      }
      // The follow-up edit (post-adopt) is accepted, advancing to revision 10.
      server.revision = "10";
      return data({ ok: true, kind: "wbs-save", revision: "10" });
    };

    const Stub = createRoutesStub([
      { path: "/projects/:id/wbs", Component: ProjectWbs, loader, action, shouldRevalidate },
    ]);
    render(<Stub initialEntries={["/projects/p1/wbs"]} />);

    // The loader ran once on mount (revision 7).
    await waitFor(() => expect(loaderRevisions).toEqual(["7"]));

    // Optimistic edit → dispatches the batch to the action with the confirmed
    // revision 7; the edit is on screen immediately.
    await editFirstName("Doomed edit");
    await waitFor(() => expect(screen.getByText("Doomed edit")).toBeTruthy());
    await waitFor(() => expect(actionCalls).toBe(1));
    expect(seenExpectedRevisions[0]).toBe("7");

    // THE PROOF: the 409 forced `shouldRevalidate` true, so the loader RE-RAN (it
    // did not stay at a single call), delivering the server's fresh state.
    await waitFor(() => expect(loaderRevisions.length).toBeGreaterThanOrEqual(2));
    expect(loaderRevisions[loaderRevisions.length - 1]).toBe("9");

    // The client ADOPTED: the fresh server state replaced the view, the rejected
    // optimistic edit is gone, and the conflict notice is shown.
    await waitFor(() => expect(screen.getByText("Fresh from server")).toBeTruthy());
    expect(screen.queryByText("Doomed edit")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");

    // The badge cleared — editing resumed after the adopt (the grid is not locked).
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    // confirmedRevision advanced to the server's 9: a subsequent edit dispatches
    // with expectedRevision 9 (not the stale 7), and this time the action accepts.
    await editFirstName("After adopt");
    await waitFor(() => expect(actionCalls).toBe(2));
    expect(seenExpectedRevisions[1]).toBe("9");
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
  });
});
