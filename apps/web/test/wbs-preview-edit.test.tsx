// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "@vecta/application";
import { App as WbsApp } from "~/wbs/wbs-app";
import { scheduledProject } from "./fixtures/wbs";

// TanStack Virtual measures the scroll element via offsetWidth/offsetHeight and a
// ResizeObserver; happy-dom performs no layout, so give elements the same size as
// the grid's `initialRect` and stub the observer, so the row/column virtualizers
// materialise rows (matching the SSR window exactly — no post-mount churn).
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 720 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1440 });
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const project: ProjectState = scheduledProject({
  parentCount: 2,
  subtasksPerParent: 3,
  memberCount: 3,
});

async function firstNameCell(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-col="name"]')).not.toBeNull());
  const cell = document.querySelector(
    '.grid-row:not(.grid-row--draft) [data-col="name"]',
  ) as HTMLElement;
  expect(cell).not.toBeNull();
  return cell;
}

describe("Step 4a preview: edits apply locally, nothing persists", () => {
  it("applies an inline edit to local state without any persistence", async () => {
    render(<WbsApp initialState={project} initialRevision="7" projectionRole="PRIVILEGED" />);
    const nameCell = await firstNameCell();

    fireEvent.doubleClick(nameCell);
    const editor = nameCell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "Renamed locally" } });
    fireEvent.blur(editor);

    // The edit shows immediately (local optimistic recompute), and the badge stays
    // "preview" — 4a never transitions to "saving"/"saved".
    await waitFor(() => expect(screen.getByText("Renamed locally")).toBeTruthy());
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
    // Nothing was persisted anywhere: no localStorage mirror (Design 0003 §A-1).
    expect(localStorage.length).toBe(0);
  });

  it("forwards the command batch (with the expected revision) to the 4b onExecute seam", async () => {
    const onExecute = vi.fn();
    render(
      <WbsApp
        initialState={project}
        initialRevision="7"
        projectionRole="PRIVILEGED"
        onExecute={onExecute}
      />,
    );
    const nameCell = await firstNameCell();

    fireEvent.doubleClick(nameCell);
    const editor = nameCell.querySelector("input.cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "Renamed with seam" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    const [commands, expectedRevision] = onExecute.mock.calls[0]!;
    expect(expectedRevision).toBe("7");
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("task.update");
    expect(commands[0]).toMatchObject({ changes: { name: "Renamed with seam" } });
    // Even with the seam wired, 4a still persists nothing itself.
    expect(localStorage.length).toBe(0);
  });
});
