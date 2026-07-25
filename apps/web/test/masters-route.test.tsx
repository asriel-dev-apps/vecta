// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutesStub, data } from "react-router";
import type { ProjectCommand, ProjectState } from "@vecta/application";
import ProjectMasters, { shouldRevalidate } from "~/routes/project.masters";
import { toCommand } from "~/wbs/project-command-contract";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4c-1 — the `/projects/:id/masters` route (工程 + プロダクト). These
// drive the REAL route Component through `createRoutesStub` (real fetcher submit,
// real `shouldRevalidate`) against a small mutable "server", so the ported panels,
// the wire dispatch, and the shared optimistic pipeline are exercised end to end.

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });
const empty: ProjectState = createDemoProject({ parentCount: 0, subtasksPerParent: 0, memberCount: 0 });

type ActionMode = "accept" | "conflict" | "forbid";

interface FakeServer {
  revision: string;
  state: ProjectState;
  loaderCalls: number;
  expectedRevisions: string[];
  commands: ProjectCommand[];
  mode: ActionMode;
  /** For the conflict case, the fresh state the loader delivers on resync. */
  conflictState: ProjectState;
  conflictRevision: string;
}

function mount(initial: ProjectState, mode: ActionMode = "accept") {
  const server: FakeServer = {
    revision: "7",
    state: initial,
    loaderCalls: 0,
    expectedRevisions: [],
    commands: [],
    mode,
    conflictState: initial,
    conflictRevision: "9",
  };
  const loader = () => {
    server.loaderCalls += 1;
    return { revision: server.revision, stateView: server.state, projectionRole: "PRIVILEGED" as const };
  };
  const action = async ({ request }: { request: Request }) => {
    const body = (await request.json()) as {
      expectedRevision: string;
      commands: { command: unknown }[];
    };
    server.expectedRevisions.push(body.expectedRevision);
    for (const entry of body.commands) server.commands.push(toCommand(entry.command as never));
    if (server.mode === "conflict") {
      server.revision = server.conflictRevision;
      server.state = server.conflictState;
      return data(
        { ok: false, code: "VERSION_CONFLICT", actualRevision: server.conflictRevision },
        { status: 409 },
      );
    }
    if (server.mode === "forbid") {
      return data({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }
    server.revision = String(Number(server.revision) + 1);
    return data({ ok: true, kind: "masters-save", revision: server.revision });
  };
  const Stub = createRoutesStub([
    { path: "/projects/:id/masters", Component: ProjectMasters, loader, action, shouldRevalidate },
  ]);
  render(<Stub initialEntries={["/projects/p1/masters"]} />);
  return server;
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("master-screen")).toBeTruthy());
}

describe("ProjectMasters — 工程 / プロダクト panels", () => {
  it("renders ONLY the 工程 and プロダクト sections from the loaded project", async () => {
    mount(seed);
    await ready();
    expect(screen.getByTestId("master-section-工程")).toBeTruthy();
    expect(screen.getByTestId("master-section-プロダクト")).toBeTruthy();
    // The masters route hosts neither the member nor the template panel (Option A).
    expect(screen.queryByTestId("master-section-member")).toBeNull();
    expect(screen.queryByTestId("master-section-template")).toBeNull();
    expect(screen.getByDisplayValue("Phase A")).toBeTruthy();
    expect(screen.getByDisplayValue("Product 1")).toBeTruthy();
    expect(screen.getByText("マスタ管理 · 工程 / プロダクト")).toBeTruthy();
  });

  it("shows the （未登録） empty state for an empty master list", async () => {
    mount(empty);
    await ready();
    expect(screen.getAllByText("（未登録）").length).toBe(2);
  });

  it("dispatches process.add (sortOrder appended) and shows it optimistically", async () => {
    const server = mount(seed);
    await ready();
    fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: "Phase Z" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "process.add") throw new Error(`expected process.add, got ${command.type}`);
    expect(command.process.name).toBe("Phase Z");
    expect(command.process.sortOrder).toBe(seed.processes.length);
    // Optimistic: the new 工程 is on screen before the save settles.
    expect(screen.getByDisplayValue("Phase Z")).toBeTruthy();
    expect(server.expectedRevisions[0]).toBe("7");
  });

  it("dispatches product.add from the プロダクト list", async () => {
    const server = mount(seed);
    await ready();
    fireEvent.change(screen.getByLabelText("プロダクトを追加…"), { target: { value: "Product 99" } });
    fireEvent.click(screen.getByTestId("master-add-プロダクト"));

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "product.add") throw new Error(`expected product.add, got ${command.type}`);
    expect(command.product.name).toBe("Product 99");
    expect(command.product.sortOrder).toBe(seed.products.length);
  });

  it("dispatches process.update on rename (Enter-commit)", async () => {
    const server = mount(seed);
    await ready();
    const input = screen.getByDisplayValue("Phase A") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Phase A renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "process.update") throw new Error(`expected process.update, got ${command.type}`);
    expect(command.changes.name).toBe("Phase A renamed");
  });

  it("rejects deleting a 工程 still used by a task locally (notice, no dispatch)", async () => {
    const server = mount(seed);
    await ready();
    // Phase A is referenced by demo tasks, so the optimistic apply throws and the
    // command never reaches the server.
    fireEvent.click(screen.getByLabelText("Phase A を削除"));

    await waitFor(() => expect(screen.getByTestId("master-notice")).toBeTruthy());
    expect(screen.getByTestId("master-notice").textContent).toContain("used by a task");
    expect(server.commands.length).toBe(0);
  });
});

describe("ProjectMasters — shared optimistic pipeline", () => {
  it("on success advances the confirmed revision with NO loader re-run", async () => {
    const server = mount(seed);
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: "Phase Z" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));
    await waitFor(() => expect(server.commands.length).toBe(1));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    // The self-save skipped revalidation: the loader did NOT re-run.
    expect(server.loaderCalls).toBe(1);
    // A second edit dispatches with the ADVANCED confirmed revision (8), proving
    // success advanced it and nothing re-read a stale 7.
    fireEvent.change(screen.getByLabelText("プロダクトを追加…"), { target: { value: "Product 99" } });
    fireEvent.click(screen.getByTestId("master-add-プロダクト"));
    await waitFor(() => expect(server.commands.length).toBe(2));
    expect(server.expectedRevisions[1]).toBe("8");
  });

  it("rolls back the optimistic edit and shows a notice when the save is denied", async () => {
    mount(seed, "forbid");
    await ready();
    fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: "Phase Z" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));

    // Optimistic first, then rolled back on the 403.
    await waitFor(() => expect(screen.getByDisplayValue("Phase Z")).toBeTruthy());
    await waitFor(() => expect(screen.queryByDisplayValue("Phase Z")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("adopts fresh loader state on VERSION_CONFLICT and resumes editing", async () => {
    const server = mount(seed, "conflict");
    // The concurrent writer's fresh state adds an (unreferenced) product, so the
    // adopt is observable as a new row appearing — a consistent structural change,
    // independent of uncontrolled input values.
    server.conflictState = {
      ...seed,
      products: [
        ...seed.products,
        { id: crypto.randomUUID(), name: "Server-added product", sortOrder: seed.products.length },
      ],
    };
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: "Doomed 工程" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));
    await waitFor(() => expect(screen.getByDisplayValue("Doomed 工程")).toBeTruthy());

    // The 409 forced `shouldRevalidate` true → the loader RE-RAN and delivered the
    // fresh server state; the client adopted it (the server-added product appears,
    // the doomed optimistic add is gone).
    await waitFor(() => expect(server.loaderCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByDisplayValue("Server-added product")).toBeTruthy());
    expect(screen.queryByDisplayValue("Doomed 工程")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");

    // Editing resumed (badge cleared) and the confirmed revision advanced to 9.
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    fireEvent.change(screen.getByLabelText("プロダクトを追加…"), { target: { value: "After adopt" } });
    fireEvent.click(screen.getByTestId("master-add-プロダクト"));
    await waitFor(() => expect(server.expectedRevisions.length).toBe(2));
    expect(server.expectedRevisions[1]).toBe("9");
  });

  it("keeps inputs editable (does not disable) while a save is in flight", async () => {
    // A gated action holds the save in flight so the "saving" state is observable.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actionCalls = 0;
    const loader = () => ({ revision: "7", stateView: seed, projectionRole: "PRIVILEGED" as const });
    const action = async () => {
      actionCalls += 1;
      await gate;
      return data({ ok: true, kind: "masters-save", revision: "8" });
    };
    const Stub = createRoutesStub([
      { path: "/projects/:id/masters", Component: ProjectMasters, loader, action, shouldRevalidate },
    ]);
    render(<Stub initialEntries={["/projects/p1/masters"]} />);
    await ready();

    fireEvent.change(screen.getByLabelText("工程を追加…"), { target: { value: "Phase Z" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));

    // Queue-not-block (Step 4d): the badge is "saving" but the inputs no longer flash
    // disabled — a concurrent edit is queued, not blocked (the sanctioned delta).
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saving"));
    expect((screen.getByLabelText("プロダクトを追加…") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("master-add-プロダクト") as HTMLButtonElement).disabled).toBe(false);

    release();
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(actionCalls).toBe(1);
  });
});
