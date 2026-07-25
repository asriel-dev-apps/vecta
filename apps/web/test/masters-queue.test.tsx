// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub, data } from "react-router";
import type { ProjectCommand, ProjectState } from "@vecta/application";
import ProjectMasters, { shouldRevalidate } from "~/routes/project.masters";
import { MasterApp, type MasterSaveResult } from "~/masters/master-app";
import { MasterList } from "~/masters/master-list";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4d — the MASTERS pipeline shares the pure queue machine with WBS.
// The driven-harness suite feeds `saveInFlight`/`saveResult` by hand (a spy
// `onExecute`) so settle timing + coalescing are deterministic; the router suite
// pins the drain economy (ZERO loader re-runs) through the real fetcher.

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });

const nextSortOrder = (items: readonly { readonly sortOrder: number }[]): number =>
  items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

const processName = (command: ProjectCommand): string | undefined =>
  command.type === "process.add" ? command.process.name : undefined;

interface Over {
  state?: ProjectState;
  revision?: string;
  saveInFlight?: boolean;
  saveResult?: MasterSaveResult;
}

function propsFor(onExecute: (commands: readonly ProjectCommand[], rev: string) => void) {
  return (over: Over) => (
    <MasterApp
      initialState={over.state ?? seed}
      initialRevision={over.revision ?? "7"}
      subtitle="マスタ管理 · 工程 / プロダクト"
      onExecute={onExecute}
      saveInFlight={over.saveInFlight ?? false}
      saveResult={over.saveResult}
    >
      {({ project, editable, executeCommand }) => (
        <div className="master-grid">
          <MasterList
            title="工程"
            addLabel="工程を追加…"
            items={project.processes}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "process.add",
                process: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.processes) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "process.update", processId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "process.delete", processId: id })}
          />
          <MasterList
            title="プロダクト"
            addLabel="プロダクトを追加…"
            items={project.products}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "product.add",
                product: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.products) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "product.update", productId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "product.delete", productId: id })}
          />
        </div>
      )}
    </MasterApp>
  );
}

function addProcess(name: string): void {
  fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: name } });
  fireEvent.click(screen.getByTestId("master-add-工程"));
}

describe("ADR 0012 Step 4d — masters queue-not-block (driven harness)", () => {
  it("(1) idle regression: a single edit dispatches immediately with the confirmed revision", async () => {
    const onExecute = vi.fn();
    render(propsFor(onExecute)({ saveInFlight: false }));
    addProcess("Solo");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0]![1]).toBe("7");
    expect(screen.getByDisplayValue("Solo")).toBeTruthy();
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(2) queues an edit during flight: UI shows it, spy count stays 1, badge stays saving", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("First");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));

    addProcess("Queued");
    await waitFor(() => expect(screen.getByDisplayValue("Queued")).toBeTruthy());
    expect(onExecute).toHaveBeenCalledTimes(1); // queued, not submitted
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(3) CORE: coalesced drain dispatches both gestures FIFO with the SETTLED revision", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));

    addProcess("B");
    addProcess("C");
    expect(onExecute).toHaveBeenCalledTimes(1);

    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    const drained = onExecute.mock.calls[1]![0] as ProjectCommand[];
    expect(drained.map(processName)).toEqual(["B", "C"]); // FIFO
    // Settled revision (8): ≠ loader revision (7) AND ≠ pre-settle confirmed (7).
    expect(onExecute.mock.calls[1]![1]).toBe("8");
    expect(onExecute.mock.calls[1]![1]).not.toBe("7");
    expect(screen.getByTestId("save-state").textContent).toBe("saving");
  });

  it("(4) badge truthfulness: 'saving' across settle→redispatch, 'saved' only when both slots empty", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    addProcess("B");

    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("save-state").textContent).toBe("saving"); // drained batch on the wire

    rerender(props({ saveInFlight: true, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "9" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(onExecute).toHaveBeenCalledTimes(2);
  });

  it("(6) failure mid-queue (INVALID with pending): rolls back to the pre-in-flight snapshot", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    addProcess("B");
    addProcess("C");

    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "INVALID", message: "bad value" } }));

    // Rollback to the confirmed boundary (pre-A): A, B AND C are all gone.
    await waitFor(() => expect(screen.queryByDisplayValue("A")).toBeNull());
    expect(screen.queryByDisplayValue("B")).toBeNull();
    expect(screen.queryByDisplayValue("C")).toBeNull();
    expect(onExecute).toHaveBeenCalledTimes(1); // no drain on failure
    expect(screen.getByRole("alert").textContent).toContain("bad value");
    expect(screen.getByTestId("save-state").textContent).toBe("error");
  });

  it("(7) success-then-failure: a drained batch that fails rolls back to A, keeping A + its revision", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    addProcess("B");

    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![1]).toBe("8"); // confirmedRevision advanced to A's

    rerender(props({ saveInFlight: true, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "INVALID", message: "nope" } }));

    await waitFor(() => expect(screen.getByDisplayValue("A")).toBeTruthy()); // A preserved
    expect(screen.queryByDisplayValue("B")).toBeNull(); // only B reverted
    expect(screen.getByTestId("save-state").textContent).toBe("error");
  });

  it("(9) editable gating: inputs stay enabled in 'saving' and are disabled in 'error'", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saving"));
    // "saving" is editable — the add input is NOT disabled (queue-not-block).
    expect((screen.getByLabelText("プロダクトを追加…") as HTMLInputElement).disabled).toBe(false);

    // Drive to "error" via a denied save → inputs lock.
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: { ok: false, code: "FORBIDDEN" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("error"));
    expect((screen.getByLabelText("プロダクトを追加…") as HTMLInputElement).disabled).toBe(true);
  });

  it("(10) exactly-once settle: a re-rendered stale result neither re-processes nor re-dispatches", async () => {
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const success: MasterSaveResult = { ok: true, kind: "masters-save", revision: "8" };
    const { rerender } = render(props({ saveInFlight: false }));
    addProcess("A");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    rerender(props({ saveInFlight: true }));
    rerender(props({ saveInFlight: false, saveResult: success }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    rerender(props({ saveInFlight: false, saveResult: success })); // spurious stale re-render
    expect(onExecute).toHaveBeenCalledTimes(1);

    addProcess("B");
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![1]).toBe("8"); // advanced-once revision
  });

  it("(11) collapsed transition: a NEW result on an idle→idle re-render still settles", async () => {
    // The P1 regression (mirrors the WBS pipeline). RR 8.2.0 wraps the router state
    // update in `startTransition`, so the settle can commit BEFORE the "submitting"
    // render — the "saving" state is never observed. The harness models that by NEVER
    // flipping saveInFlight to true: the save is in flight only in the QUEUE. The OLD
    // in-flight-edge detector missed this settle, wedging the badge at "saving" and
    // queueing every later edit forever.
    const onExecute = vi.fn();
    const props = propsFor(onExecute);
    const { rerender } = render(props({ saveInFlight: false }));

    addProcess("A"); // dispatched; the "submitting" render collapses
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("save-state").textContent).toBe("saving");

    addProcess("B"); // queued while A is (collapsed) in flight
    expect(onExecute).toHaveBeenCalledTimes(1);

    // NEW result on an idle→idle re-render while `queueRef.current.inFlight !== null`:
    // it MUST be processed by identity (old code left onExecute stuck at 1).
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "8" } }));

    // inFlight cleared + confirmedRevision advanced ⇒ pending B DRAINS with rev 8.
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect((onExecute.mock.calls[1]![0] as ProjectCommand[]).map(processName)).toEqual(["B"]);
    expect(onExecute.mock.calls[1]![1]).toBe("8");
    expect(screen.getByTestId("save-state").textContent).toBe("saving"); // B on the wire

    // The drained B also settles collapsed (idle→idle, NEW object) ⇒ both slots empty.
    rerender(props({ saveInFlight: false, saveResult: { ok: true, kind: "masters-save", revision: "9" } }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(onExecute).toHaveBeenCalledTimes(2); // no spurious dispatch on the empty settle
  });
});

// ---- Router suite (real fetcher) ------------------------------------------------

describe("ADR 0012 Step 4d — masters queue economy through the real router", () => {
  it("(12) drains a coalesced batch with ZERO loader re-runs", async () => {
    const gates: Array<() => void> = [];
    const gate1 = new Promise<void>((r) => { gates[1] = r; });
    const gate2 = new Promise<void>((r) => { gates[2] = r; });
    let loaderCalls = 0;
    let actionCalls = 0;
    const expectedRevisions: string[] = [];
    const drainedSizes: number[] = [];
    const server = { revision: "7" };

    const loader = () => {
      loaderCalls += 1;
      return { revision: server.revision, stateView: seed, projectionRole: "PRIVILEGED" as const };
    };
    const action = async ({ request }: { request: Request }) => {
      actionCalls += 1;
      const mine = actionCalls;
      const body = (await request.json()) as { expectedRevision: string; commands: unknown[] };
      expectedRevisions.push(body.expectedRevision);
      drainedSizes.push(body.commands.length);
      await (mine === 1 ? gate1 : gate2);
      server.revision = String(Number(body.expectedRevision) + 1);
      return data({ ok: true, kind: "masters-save", revision: server.revision });
    };
    const Stub = createRoutesStub([
      { path: "/projects/:id/masters", Component: ProjectMasters, loader, action, shouldRevalidate },
    ]);
    render(<Stub initialEntries={["/projects/p1/masters"]} />);
    await waitFor(() => expect(screen.getByTestId("master-screen")).toBeTruthy());
    await waitFor(() => expect(loaderCalls).toBe(1));

    addProcess("A"); // in flight (gated)
    await waitFor(() => expect(actionCalls).toBe(1));
    addProcess("B"); // queued
    addProcess("C"); // coalesced
    expect(actionCalls).toBe(1);

    gates[1]!();
    await waitFor(() => expect(actionCalls).toBe(2));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saving"));

    gates[2]!();
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(expectedRevisions).toEqual(["7", "8"]); // chained off the settled revision
    expect(drainedSizes[1]).toBe(2); // B and C coalesced into one wire batch
    expect(loaderCalls).toBe(1); // ZERO re-runs across the drained sequence
  });
});
