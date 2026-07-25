// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "@vecta/application";
import { App as WbsApp, type SaveActionResult } from "~/wbs/wbs-app";
import { scheduledProject } from "./fixtures/wbs";

// The virtualizer measures via offsetWidth/offsetHeight; happy-dom does no layout,
// so shim them to the grid's `initialRect` and stub the observer (as the 4a suite
// does), so rows materialise and match the SSR window.
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

function cellText(cell: HTMLElement): string {
  return (cell.querySelector(".cell-text")?.textContent ?? "").trim();
}

async function editFirstName(value: string): Promise<void> {
  const cell = await firstNameCell();
  fireEvent.doubleClick(cell);
  const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
  expect(editor).not.toBeNull();
  fireEvent.change(editor, { target: { value } });
  fireEvent.blur(editor);
}

describe("ADR 0012 Step 4b — connected optimistic pipeline", () => {
  it("applies optimistically and dispatches with the confirmed revision", async () => {
    const onExecute = vi.fn();
    render(
      <WbsApp
        initialState={project}
        initialRevision="7"
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
        saveInFlight={false}
        saveResult={undefined}
      />,
    );

    await editFirstName("Renamed A");

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    // Dispatched with the confirmed revision (seeded from the loader), not stale.
    expect(onExecute.mock.calls[0]![1]).toBe("7");
    // The edit is visible immediately — optimistic, before any save result.
    expect(screen.getByText("Renamed A")).toBeTruthy();
  });

  it("on success advances the confirmed revision with NO reload/re-settle", async () => {
    const onExecute = vi.fn();
    const props = (over: Partial<{ saveInFlight: boolean; saveResult?: SaveActionResult }>) => (
      <WbsApp
        initialState={project}
        initialRevision="7"
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
        saveInFlight={over.saveInFlight ?? false}
        saveResult={over.saveResult}
      />
    );
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("Renamed A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));

    // Fetcher: submitting → settled with success at revision 8.
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));

    // No re-settle: initialState/initialRevision never changed, so the optimistic
    // edit is still on screen (nothing reloaded it away).
    await waitFor(() => expect(screen.getByText("Renamed A")).toBeTruthy());

    // A second edit dispatches with the ADVANCED confirmed revision (8), proving
    // the success result advanced it (and that we did not re-read a stale 7).
    await editFirstName("Renamed B");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![1]).toBe("8");
  });

  it("rolls back state + grid and shows a notice when the save is rejected", async () => {
    const onExecute = vi.fn();
    const props = (over: Partial<{ saveInFlight: boolean; saveResult?: SaveActionResult }>) => (
      <WbsApp
        initialState={project}
        initialRevision="7"
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
        saveInFlight={over.saveInFlight ?? false}
        saveResult={over.saveResult}
      />
    );
    const { rerender } = render(props({ saveInFlight: false }));

    const originalName = cellText(await firstNameCell());
    await editFirstName("Rejected edit");
    await waitFor(() => expect(screen.getByText("Rejected edit")).toBeTruthy());

    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "FORBIDDEN" } }));

    // Rollback: the optimistic edit is gone, the original value restored.
    await waitFor(() => expect(screen.queryByText("Rejected edit")).toBeNull());
    expect(screen.getByText(originalName)).toBeTruthy();
    // And the existing notice surfaces the failure.
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("adopts fresh loader data on VERSION_CONFLICT without remounting", async () => {
    const onExecute = vi.fn();
    const freshProject: ProjectState = {
      ...project,
      tasks: project.tasks.map((task, index) =>
        index === 0 ? { ...task, name: "Fresh from server" } : task,
      ),
    };
    const props = (over: {
      state: ProjectState;
      revision: string;
      saveInFlight: boolean;
      saveResult?: SaveActionResult;
    }) => (
      <WbsApp
        initialState={over.state}
        initialRevision={over.revision}
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
        saveInFlight={over.saveInFlight}
        saveResult={over.saveResult}
      />
    );
    const { rerender } = render(props({ state: project, revision: "7", saveInFlight: false }));

    const gridBefore = screen.getByTestId("wbs-grid");
    await editFirstName("Doomed edit");
    await waitFor(() => expect(screen.getByText("Doomed edit")).toBeTruthy());

    // Fetcher settles with a conflict (server is ahead at revision 9).
    const conflict: SaveActionResult = { ok: false, code: "VERSION_CONFLICT", actualRevision: "9" };
    rerender(props({ state: project, revision: "7", saveInFlight: true, saveResult: conflict }));
    rerender(props({ state: project, revision: "7", saveInFlight: false, saveResult: conflict }));

    // Revalidation then delivers the fresh loader data (state view + revision 9);
    // the effect adopts it into component state.
    rerender(props({ state: freshProject, revision: "9", saveInFlight: false, saveResult: conflict }));

    await waitFor(() => expect(screen.getByText("Fresh from server")).toBeTruthy());
    // The rejected optimistic edit is gone (fresh view replaced it).
    expect(screen.queryByText("Doomed edit")).toBeNull();
    // The conflict notice is shown.
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
    // No remount: the same grid DOM node persists across the adopt (scroll /
    // selection / focus survive — the ADR's explicit no-key requirement).
    expect(screen.getByTestId("wbs-grid")).toBe(gridBefore);
  });

  it("queues (does not drop) a concurrent edit while a save is in flight", async () => {
    const onExecute = vi.fn();
    render(
      <WbsApp
        initialState={project}
        initialRevision="7"
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
        saveInFlight={false}
        saveResult={undefined}
      />,
    );

    await editFirstName("First edit");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));

    // Queue-not-block (Step 4d): the badge is "saving" but editing is still allowed;
    // a second edit opens its editor and applies optimistically, yet does NOT submit
    // (queued behind the in-flight save — the fetcher is never abort-and-replaced).
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
    await editFirstName("Second edit");
    await waitFor(() => expect(screen.getByText("Second edit")).toBeTruthy());
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });
});

describe("ADR 0012 Step 4b — scheduler-throw is caught (pins 4a's P0 fix)", () => {
  it("surfaces a notice and leaves state unchanged when placement fails", async () => {
    // A project whose calendars have NO working days: a generateSubtasks placement
    // (the scheduler branch that now lives INSIDE executeCommands' try) throws.
    // Preview mode exercises the same catch as connected mode.
    const small = scheduledProject({ parentCount: 1, subtasksPerParent: 2, memberCount: 2 });
    const unplaceable: ProjectState = {
      ...small,
      calendars: small.calendars.map((calendar) => ({ ...calendar, workingWeekdays: [] })),
    };
    const leaf = unplaceable.tasks.find((task) => task.parentId !== null)!;
    render(<WbsApp initialState={unplaceable} initialRevision="1" projectionRole="PRIVILEGED" />);

    await waitFor(() => expect(document.querySelector('[data-col="name"]')).not.toBeNull());
    const rowsBefore = document.querySelectorAll("[data-row-id]").length;

    // Open the row menu on the leaf → templates → generate from the first template.
    const menuButton = document.querySelector(
      `[data-testid="row-menu-button"][data-task-id="${leaf.id}"]`,
    ) as HTMLElement;
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByTestId("row-menu-templates"));
    const templateButton = document.querySelector('[data-testid="row-menu-template"]') as HTMLElement;
    expect(templateButton).not.toBeNull();
    fireEvent.click(templateButton);

    // The throw became a notice (no uncaught error), and no children were added.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(document.querySelectorAll("[data-row-id]").length).toBe(rowsBefore);
  });
});
