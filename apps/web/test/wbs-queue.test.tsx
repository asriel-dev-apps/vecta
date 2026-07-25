// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoutesStub, data } from "react-router";
import { projectWbsGrid, type ProjectCommand, type ProjectState } from "@vecta/application";
import ProjectWbs, { shouldRevalidate } from "~/routes/project.wbs";
import { App as WbsApp, type SaveActionResult } from "~/wbs/wbs-app";
import { scheduledProject } from "./fixtures/wbs";

// ADR 0012 Step 4d — the WBS queue-not-block pipeline. The driven-harness suite
// feeds `saveInFlight`/`saveResult` by hand (a spy `onExecute`) so settle timing
// and coalescing are deterministic; the router suite drives a REAL fetcher through
// `createRoutesStub` to pin the loader-revalidation economy (ZERO re-runs on a
// drained success; exactly ONE on a mid-queue conflict).

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

const nameOf = (command: ProjectCommand): string | undefined =>
  command.type === "task.update" ? (command.changes.name as string | undefined) : undefined;

async function firstNameCell(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-col="name"]')).not.toBeNull());
  return document.querySelector('.grid-row:not(.grid-row--draft) [data-col="name"]') as HTMLElement;
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

// ---- Driven harness (spy onExecute + hand-fed saveInFlight/saveResult) ----------

interface Over {
  state?: ProjectState;
  revision?: string;
  saveInFlight?: boolean;
  saveResult?: SaveActionResult;
}

function propsFor(onExecute: (commands: readonly ProjectCommand[], rev: string) => void) {
  return (over: Over) => (
    <WbsApp
      initialState={over.state ?? project}
      initialRevision={over.revision ?? "7"}
      projectionRole="PRIVILEGED"
      onExecute={onExecute}
      saveInFlight={over.saveInFlight ?? false}
      saveResult={over.saveResult}
    />
  );
}

describe("ADR 0012 Step 4d — WBS queue-not-block (driven harness)", () => {
  it("(1) idle regression: a single edit dispatches immediately with the confirmed revision", async () => {
    const onExecute = vi.fn();
    render(propsFor(onExecute)({ saveInFlight: false }));
    await editFirstName("Solo edit");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0]![1]).toBe("7");
    expect(screen.getByText("Solo edit")).toBeTruthy();
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(2) queues an edit during flight: UI shows it, spy count stays 1, badge stays saving", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("First");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));

    await editFirstName("Queued");
    await waitFor(() => expect(screen.getByText("Queued")).toBeTruthy());
    // Queued, not submitted: the fetcher was never abort-and-replaced.
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(3) CORE: coalesced drain dispatches both gestures FIFO with the SETTLED revision", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));

    await editFirstName("B");
    await editFirstName("C");
    expect(onExecute).toHaveBeenCalledTimes(1); // both queued

    // The in-flight save settles success at revision 8.
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));

    // EXACTLY ONE new dispatch, carrying both queued gestures in FIFO order.
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    const drained = onExecute.mock.calls[1]![0] as ProjectCommand[];
    expect(drained.map(nameOf)).toEqual(["B", "C"]);
    // expectedRevision is the SETTLED revision (8): ≠ loader revision (7) AND ≠ the
    // pre-settle confirmed revision (7) — pins the stale-closure bug.
    expect(onExecute.mock.calls[1]![1]).toBe("8");
    expect(onExecute.mock.calls[1]![1]).not.toBe("7");
    // A save is again on the wire → badge stays "saving".
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(4) badge truthfulness: 'saving' across settle→redispatch, 'saved' only when both slots empty", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    await editFirstName("B");

    // First save settles → drains B → still "saving" (pending promoted to inFlight).
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("save-state").textContent).toBe("saving");

    // The drained batch settles with NO pending → now "saved".
    rerender(props({ saveInFlight: true, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "9" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(onExecute).toHaveBeenCalledTimes(2); // no spurious dispatch on the empty-slot settle
  });

  it("(6) failure mid-queue (INVALID with pending): rolls back to the pre-in-flight snapshot", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    const original = cellText(await firstNameCell());
    await editFirstName("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    await editFirstName("B");
    await editFirstName("C");

    // The in-flight save (A) fails validation while B, C are pending.
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "INVALID", message: "bad value" } }));

    // Rollback target is the confirmed boundary (pre-A): A, B AND C are all gone.
    await waitFor(() => expect(screen.getByText(original)).toBeTruthy());
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.queryByText("C")).toBeNull();
    // No drain dispatch on failure; the notice surfaces the message.
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("bad value");
    expect(screen.getByTestId("save-state").textContent).toBe("error");
  });

  it("(7) success-then-failure: a drained batch that fails rolls back to A, keeping A's edit + revision", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    await editFirstName("B");

    // A succeeds (revision 8) → drains B with the advanced revision 8.
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![1]).toBe("8"); // confirmedRevision advanced to A's

    // The drained B fails → rollback to inFlight.snapshot = state-after-A.
    rerender(props({ saveInFlight: true, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "INVALID", message: "nope" } }));

    // A's edit survives; only B was reverted.
    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("error");
  });

  // Grid coherence (grid ≡ projectWbsGrid(project)) is pinned via a purely DERIVED
  // cell (工数(人日), a function of the row's effort) at both the rollback and the
  // adopt boundaries. Split in two because a rejected save correctly LOCKS the grid
  // ("error"), so the adopt case must start from a fresh flow.
  const grid0 = projectWbsGrid(project, { role: "PRIVILEGED" });
  const coherenceLeaf = grid0.rows.find((row) => row.parentId !== null)!;
  const daysCellFor = (id: string) =>
    (document.querySelector(`[data-row-id="${id}"] [data-col="plannedEffortDays"] .cell-text`)?.textContent ?? "").trim();
  const editEffortFor = (id: string, hours: string) => {
    const cell = document.querySelector(`[data-row-id="${id}"] [data-col="plannedEffortMinutes"]`) as HTMLElement;
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: hours } });
    fireEvent.blur(editor);
  };
  const fmtDays = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

  it("(8a) grid coherence: a derived cell reverts EXACTLY on rollback", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    await waitFor(() => expect(document.querySelector(`[data-row-id="${coherenceLeaf.id}"]`)).not.toBeNull());

    const baseline = daysCellFor(coherenceLeaf.id);
    editEffortFor(coherenceLeaf.id, "199");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(daysCellFor(coherenceLeaf.id)).not.toBe(baseline); // the edit changed the derived cell

    // Failure → rollback: the derived cell returns EXACTLY to baseline, so the grid
    // is coherent with the reverted project (grid ≡ projectWbsGrid(project)).
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "FORBIDDEN" } }));
    await waitFor(() => expect(daysCellFor(coherenceLeaf.id)).toBe(baseline));
  });

  it("(8b) grid coherence: the grid re-derives from the ADOPTED project on conflict", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const freshMinutes = coherenceLeaf.plannedEffortMinutes + 6000;
    const fresh: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === coherenceLeaf.id ? { ...task, plannedEffortMinutes: freshMinutes } : task,
      ),
    };
    const freshDays = projectWbsGrid(fresh, { role: "PRIVILEGED" }).rows.find((r) => r.id === coherenceLeaf.id)!
      .plannedEffortDays;

    const { rerender } = render(props({ saveInFlight: false }));
    await waitFor(() => expect(document.querySelector(`[data-row-id="${coherenceLeaf.id}"]`)).not.toBeNull());

    editEffortFor(coherenceLeaf.id, "50");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    const conflict: SaveActionResult = { ok: false, code: "VERSION_CONFLICT", actualRevision: "9" };
    rerender(props({ saveInFlight: true, saveResult: conflict }));
    rerender(props({ saveInFlight: false, saveResult: conflict }));
    // The revalidation delivers `fresh` at revision 9; the derived cell must equal
    // projectWbsGrid(fresh) — grid re-derived coherently from the ADOPTED project.
    rerender(props({ state: fresh, revision: "9", saveInFlight: false, saveResult: conflict }));
    await waitFor(() => expect(daysCellFor(coherenceLeaf.id)).toBe(fmtDays(freshDays)));
  });

  it("(9) editable gating: edits are accepted in 'saving' and blocked in 'error'", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A");
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saving"));
    // In "saving" the editor still opens (queue-not-block).
    const cell = await firstNameCell();
    fireEvent.doubleClick(cell);
    expect(cell.querySelector("input.cell-editor")).not.toBeNull();
    fireEvent.keyDown(cell.querySelector("input.cell-editor")!, { key: "Escape" });

    // Drive to "error" via a denied save → editing is blocked.
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "FORBIDDEN" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("error"));
    const lockedCell = await firstNameCell();
    fireEvent.doubleClick(lockedCell);
    expect(lockedCell.querySelector("input.cell-editor")).toBeNull();
  });

  it("(10) exactly-once settle: a re-rendered stale result neither re-processes nor re-dispatches", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const success: SaveActionResult = { ok: true, kind: "wbs-save", revision: "8" };
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: success }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    // A spurious re-render carrying the SAME settled result (fetcher.data lingers)
    // must not re-advance the revision or re-dispatch.
    rerender(props({ saveInFlight: false, saveResult: success }));
    expect(onExecute).toHaveBeenCalledTimes(1);

    // The next edit dispatches with the (once-)advanced revision 8, proving the
    // stale re-render did not double-process the settle.
    await editFirstName("B");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![1]).toBe("8");
  });

  it("(11) collapsed transition: a NEW result on an idle→idle re-render still settles", async () => {
    // The P1 regression. RR 8.2.0 wraps the router state update in `startTransition`,
    // so the settle can commit BEFORE the "submitting" render — the "saving" state is
    // never observed. The harness models that by NEVER flipping saveInFlight to true:
    // the save is in flight only in the QUEUE. The OLD in-flight-edge detector missed
    // this settle (it never saw saveInFlight===true), so `inFlight` was never cleared,
    // the badge wedged at "saving" forever, and every later edit queued-but-never-sent.
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    await editFirstName("A"); // dispatched; the "submitting" render collapses
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("save-state").textContent).toBe("saving");

    await editFirstName("B"); // queued while A is (collapsed) in flight
    expect(onExecute).toHaveBeenCalledTimes(1);

    // The settle arrives on an idle→idle re-render carrying a NEW result object while
    // `queueRef.current.inFlight !== null`. It MUST be processed by identity.
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "8" } }));

    // inFlight cleared + confirmedRevision advanced ⇒ the pending B DRAINS as a fresh
    // dispatch carrying the SETTLED revision 8. (Old code: onExecute stuck at 1.)
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect((onExecute.mock.calls[1]![0] as ProjectCommand[]).map(nameOf)).toEqual(["B"]);
    expect(onExecute.mock.calls[1]![1]).toBe("8");
    expect(screen.getByTestId("save-state").textContent).toBe("saving"); // B on the wire

    // The drained B also settles collapsed (idle→idle, NEW object) ⇒ both slots empty.
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "wbs-save", revision: "9" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(onExecute).toHaveBeenCalledTimes(2); // no spurious dispatch on the empty settle
  });
});

// ---- Router suite (real fetcher via createRoutesStub) ---------------------------

describe("ADR 0012 Step 4d — WBS queue economy through the real router", () => {
  it("(12) drains a coalesced batch with ZERO loader re-runs", async () => {
    // Each POST is gated by its own promise and released one at a time, so every
    // submission's in-flight state is observed (as it always is over a real network;
    // a synchronous resolve is an unrealistic test artifact). This keeps the settle
    // edge deterministic while pinning the economy: ZERO loader re-runs on the drain.
    const gates: Array<() => void> = [];
    const gateFor = (n: number) =>
      new Promise<void>((resolve) => {
        gates[n] = resolve;
      });
    const gate1 = gateFor(1);
    const gate2 = gateFor(2);
    let loaderCalls = 0;
    let actionCalls = 0;
    const expectedRevisions: string[] = [];
    const drainedSizes: number[] = [];
    const server = { revision: "7" };

    const loader = () => {
      loaderCalls += 1;
      return { revision: server.revision, stateView: project, projectionRole: "PRIVILEGED" as const };
    };
    const action = async ({ request }: { request: Request }) => {
      actionCalls += 1;
      const mine = actionCalls;
      const body = (await request.json()) as { expectedRevision: string; commands: unknown[] };
      expectedRevisions.push(body.expectedRevision);
      drainedSizes.push(body.commands.length);
      await (mine === 1 ? gate1 : gate2); // hold this POST in flight until released
      server.revision = String(Number(body.expectedRevision) + 1);
      return data({ ok: true, kind: "wbs-save", revision: server.revision });
    };

    const Stub = createRoutesStub([
      { path: "/projects/:id/wbs", Component: ProjectWbs, loader, action, shouldRevalidate },
    ]);
    render(<Stub initialEntries={["/projects/p1/wbs"]} />);
    await waitFor(() => expect(loaderCalls).toBe(1));

    await editFirstName("A"); // dispatched (rev 7), now in flight (gated)
    await waitFor(() => expect(actionCalls).toBe(1));
    await editFirstName("B"); // queued
    await editFirstName("C"); // coalesced with B
    expect(actionCalls).toBe(1);

    gates[1]!();
    // The first save settles → the coalesced [B,C] batch drains as ONE POST, now
    // itself in flight (gated) so the badge is still "saving".
    await waitFor(() => expect(actionCalls).toBe(2));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saving"));

    gates[2]!();
    // The drained batch settles → both slots empty → "saved".
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(expectedRevisions).toEqual(["7", "8"]); // chained off the settled revision
    expect(drainedSizes[1]).toBe(2); // B and C coalesced into one wire batch
    // The whole sequence of successful self-saves triggered ZERO loader re-runs.
    expect(loaderCalls).toBe(1);
  });

  it("(5) mid-queue conflict: exactly ONE loader re-run, queued edits dropped, adopt + resume", async () => {
    const freshProject: ProjectState = {
      ...project,
      tasks: project.tasks.map((task, index) =>
        index === 0 ? { ...task, name: "Fresh from server" } : task,
      ),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaderCalls = 0;
    let actionCalls = 0;
    const expectedRevisions: string[] = [];
    const server = { revision: "7", state: project };

    const loader = () => {
      loaderCalls += 1;
      return { revision: server.revision, stateView: server.state, projectionRole: "PRIVILEGED" as const };
    };
    const action = async ({ request }: { request: Request }) => {
      actionCalls += 1;
      const mine = actionCalls;
      const body = (await request.json()) as { expectedRevision: string };
      expectedRevisions.push(body.expectedRevision);
      if (mine === 1) {
        await gate;
        server.revision = "9";
        server.state = freshProject;
        return data({ ok: false, code: "VERSION_CONFLICT", actualRevision: "9" }, { status: 409 });
      }
      server.revision = "10";
      return data({ ok: true, kind: "wbs-save", revision: "10" });
    };

    const Stub = createRoutesStub([
      { path: "/projects/:id/wbs", Component: ProjectWbs, loader, action, shouldRevalidate },
    ]);
    render(<Stub initialEntries={["/projects/p1/wbs"]} />);
    await waitFor(() => expect(loaderCalls).toBe(1));

    await editFirstName("Doomed A"); // in flight (gated)
    await waitFor(() => expect(actionCalls).toBe(1));
    await editFirstName("Queued B"); // queued behind the doomed save
    expect(actionCalls).toBe(1);

    release();
    // The 409 clears the queue (B dropped) and forces exactly ONE loader re-run.
    await waitFor(() => expect(loaderCalls).toBe(2));
    await waitFor(() => expect(screen.getByText("Fresh from server")).toBeTruthy());
    expect(screen.queryByText("Doomed A")).toBeNull();
    expect(screen.queryByText("Queued B")).toBeNull(); // the queued edit was dropped
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");

    // Editing resumes at the ADOPTED revision (9); the drained-queue POST never fired.
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    await editFirstName("After adopt");
    await waitFor(() => expect(actionCalls).toBe(2));
    expect(expectedRevisions[1]).toBe("9");
    // Still exactly ONE conflict-driven re-run (the post-adopt success does not add one).
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(loaderCalls).toBe(2);
  });
});
