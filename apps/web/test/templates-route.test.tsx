// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub, data } from "react-router";
import type { ProjectCommand, ProjectState, SubtaskTemplate } from "@vecta/application";
import ProjectTemplates, { shouldRevalidate } from "~/routes/project.templates";
import { TemplateSection } from "~/masters/template-section";
import { toCommand } from "~/wbs/project-command-contract";
import { createDemoProject } from "./fixtures/demo-project";

// ADR 0012 Step 4c-1 — the `/projects/:id/templates` route = the SPA's
// サブタスクテンプレート master. The step-editor landmines (weight %→bp clamp, lag
// Math.trunc, first-step dependency stripping on move/remove, `—` first-step
// marker, Σ重み, empty states) are pinned by driving `TemplateSection` directly
// with a spy `executeCommand` (as the SPA's own unit tests did); the route
// pipeline (add-selects-it + optimistic/success/conflict through the real fetcher)
// is pinned through `createRoutesStub`.

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });
const standardBuild = seed.templates.find((template) => template.name === "Standard build")!;

describe("TemplateSection — list + step editor (ported byte-faithful)", () => {
  it("renders the template list and the default-selected template's steps", () => {
    render(<TemplateSection templates={seed.templates} editable executeCommand={vi.fn()} />);
    expect(screen.getByTestId("template-screen")).toBeTruthy();
    expect(screen.getByDisplayValue("Standard build")).toBeTruthy();
    expect(screen.getByDisplayValue("Design and review")).toBeTruthy();
    // First template selected by default; "Rework" is unique to Standard build.
    expect(screen.getByDisplayValue("Rework")).toBeTruthy();
    // Σ重み = 2000+1000+1000+4000+2000 bp = 100%.
    expect(screen.getByTestId("template-weight-sum").textContent).toContain("Σ重み 100%");
  });

  it("dispatches template.add (sortOrder appended, empty subtasks)", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    fireEvent.change(screen.getByLabelText("テンプレートを追加"), { target: { value: "Spike template" } });
    fireEvent.click(screen.getByTestId("template-add"));

    expect(executeCommand).toHaveBeenCalledOnce();
    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.add") throw new Error(`expected template.add, got ${command.type}`);
    expect(command.template.name).toBe("Spike template");
    expect(command.template.sortOrder).toBe(seed.templates.length);
    expect(command.template.subtasks).toEqual([]);
  });

  it("dispatches template.delete", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    fireEvent.click(screen.getByLabelText("Standard build を削除"));

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.delete") throw new Error(`expected template.delete, got ${command.type}`);
    expect(command.templateId).toBe(standardBuild.id);
  });

  it("dispatches template.update appending a {name:'Step', weightBp:0} step", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    fireEvent.click(screen.getByTestId("template-step-add"));

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    expect(command.templateId).toBe(standardBuild.id);
    expect(command.changes.subtasks).toHaveLength(standardBuild.subtasks.length + 1);
    expect(command.changes.subtasks!.at(-1)).toEqual({ name: "Step", weightBp: 0 });
  });

  it("clamps weight % to basis points (0..10000) on the selected step", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    const weight = screen.getAllByLabelText("重み%")[0] as HTMLInputElement;
    fireEvent.change(weight, { target: { value: "150" } });
    fireEvent.blur(weight);

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    // 150% → 15000 bp → clamped to the 10000 ceiling on step 0.
    expect(command.changes.subtasks![0]!.weightBp).toBe(10_000);
  });

  it("sets a step dependency type (keeping the existing lag)", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    // Step 0 shows the `—` marker (no dependency select), so the first 依存 select
    // is step index 1 (Review, currently FS lag 1).
    const dep = screen.getAllByLabelText("依存")[0]!;
    fireEvent.change(dep, { target: { value: "SS" } });

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    expect(command.changes.subtasks![1]!.dependsOnPrev).toEqual({ type: "SS", lagWorkingDays: 1 });
  });

  it("truncates a fractional lag to an integer ≥ 0", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    const lag = screen.getAllByLabelText("ラグ(営業日)")[0] as HTMLInputElement;
    fireEvent.change(lag, { target: { value: "3.9" } });
    fireEvent.blur(lag);

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    expect(command.changes.subtasks![1]!.dependsOnPrev!.lagWorkingDays).toBe(3);
  });

  it("strips the first step's dependency when a step is moved into first place", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    // Move step index 1 (Review, has a dependency) up into first place.
    fireEvent.click(screen.getAllByLabelText("上へ移動")[1]!);

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    const steps = command.changes.subtasks!;
    expect(steps[0]!.name).toBe("Review");
    expect(steps[0]!.dependsOnPrev).toBeUndefined();
  });

  it("strips the new first step's dependency when the first step is removed", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);
    // Remove step index 0 (Design); the new first step (Review) must lose its dep.
    fireEvent.click(screen.getAllByTestId("template-step-delete")[0]!);

    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") throw new Error(`expected template.update, got ${command.type}`);
    const steps = command.changes.subtasks!;
    expect(steps[0]!.name).toBe("Review");
    expect(steps[0]!.dependsOnPrev).toBeUndefined();
  });

  it("shows the （未登録） / selection-prompt empty state with no templates", () => {
    render(<TemplateSection templates={[]} editable executeCommand={vi.fn()} />);
    expect(screen.getByText("（未登録）")).toBeTruthy();
    expect(screen.getByText("左のリストからテンプレートを選択してください。")).toBeTruthy();
  });

  it("shows the （ステップ未登録） empty state for a template with no steps", () => {
    const emptyTemplate: SubtaskTemplate = { id: "t-empty", name: "Empty", sortOrder: 0, subtasks: [] };
    render(<TemplateSection templates={[emptyTemplate]} editable executeCommand={vi.fn()} />);
    expect(screen.getByText("（ステップ未登録）")).toBeTruthy();
  });
});

// ---- The route pipeline through the real fetcher --------------------------------

type ActionMode = "accept" | "conflict" | "forbid";

interface FakeServer {
  revision: string;
  state: ProjectState;
  loaderCalls: number;
  expectedRevisions: string[];
  commands: ProjectCommand[];
  mode: ActionMode;
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
    return data({ ok: true, kind: "templates-save", revision: server.revision });
  };
  const Stub = createRoutesStub([
    { path: "/projects/:id/templates", Component: ProjectTemplates, loader, action, shouldRevalidate },
  ]);
  render(<Stub initialEntries={["/projects/p1/templates"]} />);
  return server;
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("master-section-template")).toBeTruthy());
}

describe("ProjectTemplates — the route pipeline", () => {
  it("renders ONLY the template section (subtitle + no other master panels)", async () => {
    mount(seed);
    await ready();
    expect(screen.getByText("マスタ管理 · サブタスクテンプレート")).toBeTruthy();
    expect(screen.queryByTestId("master-section-工程")).toBeNull();
    expect(screen.queryByTestId("master-section-member")).toBeNull();
  });

  it("adds a template and selects it (its empty step editor is shown)", async () => {
    const server = mount(seed);
    await ready();
    fireEvent.change(screen.getByLabelText("テンプレートを追加"), { target: { value: "New tmpl" } });
    fireEvent.click(screen.getByTestId("template-add"));

    await waitFor(() => expect(server.commands.length).toBe(1));
    const command = server.commands[0]!;
    if (command.type !== "template.add") throw new Error(`expected template.add, got ${command.type}`);
    // Optimistic add + selection: the new template's step editor (empty) is shown.
    await waitFor(() => expect(screen.getByRole("heading", { name: "New tmpl" })).toBeTruthy());
    expect(screen.getByText("（ステップ未登録）")).toBeTruthy();
  });

  it("on success advances the confirmed revision with NO loader re-run", async () => {
    const server = mount(seed);
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("テンプレートを追加"), { target: { value: "New tmpl" } });
    fireEvent.click(screen.getByTestId("template-add"));
    await waitFor(() => expect(server.commands.length).toBe(1));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(server.loaderCalls).toBe(1);
    expect(server.expectedRevisions[0]).toBe("7");
  });

  it("rolls back and shows a notice when the save is denied", async () => {
    mount(seed, "forbid");
    await ready();
    fireEvent.change(screen.getByLabelText("テンプレートを追加"), { target: { value: "Doomed tmpl" } });
    fireEvent.click(screen.getByTestId("template-add"));

    await waitFor(() => expect(screen.getByDisplayValue("Doomed tmpl")).toBeTruthy());
    await waitFor(() => expect(screen.queryByDisplayValue("Doomed tmpl")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("adopts fresh loader state on VERSION_CONFLICT", async () => {
    const server = mount(seed, "conflict");
    server.conflictState = {
      ...seed,
      templates: [
        ...seed.templates,
        { id: "t-server", name: "Server-added tmpl", sortOrder: seed.templates.length, subtasks: [] },
      ],
    };
    await ready();
    await waitFor(() => expect(server.loaderCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("テンプレートを追加"), { target: { value: "Doomed tmpl" } });
    fireEvent.click(screen.getByTestId("template-add"));
    await waitFor(() => expect(screen.getByDisplayValue("Doomed tmpl")).toBeTruthy());

    await waitFor(() => expect(server.loaderCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByDisplayValue("Server-added tmpl")).toBeTruthy());
    expect(screen.queryByDisplayValue("Doomed tmpl")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
  });
});
