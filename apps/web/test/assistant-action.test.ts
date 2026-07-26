// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import type { ProjectState, ProposalModel, ProposalPrompt } from "@vecta/application";
import { ProposalModelError } from "@vecta/application";
import { runAssistantAction } from "~/server/project/assistant-action.server";
import {
  appContext,
  principalContext,
  projectMembershipContext,
  projectWorkspaceContext,
} from "~/server/context";
import type { ProjectWorkspaceRecord } from "~/server/project/project-access";
import {
  DEFAULT_PROPOSAL_PROVIDER,
  UnknownProposalProviderError,
  selectProposalModel,
} from "~/server/llm/select-model.server";
import { createDemoProject } from "./fixtures/demo-project";

// The assistant's proposal endpoint. These tests run the whole action with a FAKE
// model, so what is exercised is the real authorization, the real projection, the
// real expansion and the real re-validation against the wire contract — with no
// network and no database.

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";

const project: ProjectState = createDemoProject({
  parentCount: 2,
  subtasksPerParent: 2,
  memberCount: 3,
});
const workspace: ProjectWorkspaceRecord = { revision: 7n, current: project };

function fakeModel(answer: unknown): ProposalModel & { prompts: ProposalPrompt[] } {
  const prompts: ProposalPrompt[] = [];
  return {
    id: "fake:test",
    contextTokenBudget: 24_000,
    isFreeTier: true,
    egress: "in-account",
    prompts,
    propose(prompt: ProposalPrompt) {
      prompts.push(prompt);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        raw: answer,
        usage: { unit: "tokens", input: 100, output: 20 },
      });
    },
  };
}

function contextFor(
  projectRole: "OWNER" | "EDITOR" | "VIEWER",
  options: { readonly rateLimitOk?: boolean } = {},
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(principalContext, async () => ({
    principal: { id: PRINCIPAL_ID, type: "HUMAN" },
  }) as never);
  context.set(projectMembershipContext, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    projectRole,
  });
  context.set(projectWorkspaceContext, async () => workspace);
  context.set(appContext, {
    env: {
      COMPUTE_RATE_LIMIT: { limit: async () => ({ success: options.rateLimitOk ?? true }) },
    },
    ctx: {},
  } as never);
  return context;
}

function requestWith(body: unknown): Request {
  return new Request("https://example.invalid/projects/x/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run(
  role: "OWNER" | "EDITOR" | "VIEWER",
  body: unknown,
  model: ProposalModel,
  options: { readonly rateLimitOk?: boolean } = {},
) {
  const result = await runAssistantAction({
    request: requestWith(body),
    context: contextFor(role, options),
    model,
  });
  return result as unknown as { data: Record<string, unknown>; init?: { status?: number } };
}

/** The first task's display No., which the chat vocabulary addresses tasks by. */
const firstSeq = project.tasks[0]!.seq;

interface ProposalPayload {
  readonly expectedRevision: string;
  readonly commands: readonly { readonly type: string; readonly changes?: Record<string, unknown> }[];
  readonly diff: {
    readonly addedTasks: number;
    readonly updatedTasks: number;
    readonly entries: readonly {
      readonly changes: readonly { readonly field: string; readonly before: string | null; readonly after: string }[];
    }[];
  };
  readonly summary: string;
  readonly unresolved: readonly unknown[];
  readonly csv?: {
    readonly rowCount: number;
    readonly mapped: readonly {
      readonly columnIndex: number;
      readonly columnName: string;
      readonly field: string;
    }[];
    readonly unmappedColumns: readonly string[];
    readonly issues: readonly { readonly field: string; readonly reason: string }[];
  };
}

function proposalOf(result: { data: Record<string, unknown> }): ProposalPayload {
  return result.data.proposal as ProposalPayload;
}

describe("proposal API — authorization is tested even though it only reads (A15)", () => {
  it("refuses a VIEWER", async () => {
    const model = fakeModel({ summary: "", tasks: [] });
    const result = await run("VIEWER", { mode: "chat", input: "何かして" }, model);
    expect(result.init?.status).toBe(403);
    expect(result.data.code).toBe("FORBIDDEN");
    // The model is never reached, so a viewer cannot spend the account's neurons.
    expect(model.prompts).toHaveLength(0);
  });

  it.each(["OWNER", "EDITOR"] as const)("admits %s", async (role) => {
    const model = fakeModel({ summary: "", tasks: [] });
    const result = await run(role, { mode: "chat", input: "何かして" }, model);
    expect(result.data.ok).toBe(true);
  });
});

describe("proposal API — a proposal, not a write (ADR 0013 Decision 1)", () => {
  it("returns the commands, the derived diff, and the revision they were built on", async () => {
    const model = fakeModel({
      summary: "1 件の進捗を更新します",
      tasks: [{ op: "update", seq: firstSeq, progressPercent: 50 }],
    });
    const result = await run("EDITOR", { mode: "chat", input: `No.${firstSeq} を 50% に` }, model);

    expect(result.data.ok).toBe(true);
    const proposal = proposalOf(result);
    // The revision travels with the proposal, so an apply that lands after
    // somebody else's edit is rejected by the existing conflict path.
    expect(proposal.expectedRevision).toBe("7");
    expect(proposal.commands).toHaveLength(1);
    expect(proposal.commands[0]).toMatchObject({
      type: "task.update",
      changes: { progressBasisPoints: 5_000 },
    });
    // The diff carries before → after, derived from the command and the state.
    expect(proposal.diff.entries[0]?.changes).toEqual([
      { field: "進捗", before: "0 %", after: "50 %" },
    ]);
  });

  it("returns a proposal whose commands satisfy the same wire contract a hand edit does (A1)", async () => {
    const model = fakeModel({
      summary: "",
      tasks: [{ op: "add", name: "新しい作業", effortHours: 8 }],
    });
    const result = await run("EDITOR", { mode: "ingest", input: "見積書のテキスト" }, model);
    // Reaching `ok: true` means every expanded command re-parsed cleanly through
    // `ApiCommandSchema` inside the action — that check is the gate, not this
    // assertion, which only proves the gate was passed rather than skipped.
    expect(result.data.ok).toBe(true);
    expect(proposalOf(result).commands[0]).toMatchObject({ type: "task.add" });
  });

  it("keeps the model's summary out of the diff (A16)", async () => {
    const model = fakeModel({
      summary: "3 タスクを追加しました",
      tasks: [{ op: "update", seq: firstSeq, effortHours: 0 }],
    });
    const result = await run("EDITOR", { mode: "chat", input: "x" }, model);
    const proposal = proposalOf(result);
    expect(proposal.summary).toBe("3 タスクを追加しました");
    expect(proposal.diff.addedTasks).toBe(0);
    expect(proposal.diff.updatedTasks).toBe(1);
    expect(proposal.diff.entries[0]?.changes[0]?.field).toBe("計画工数");
  });

  it("sends the role-projected snapshot and no privileged field (Design 0005 §6)", async () => {
    const model = fakeModel({ summary: "", tasks: [] });
    await run("VIEWER", { mode: "chat", input: "x" }, model).catch(() => undefined);
    const editorModel = fakeModel({ summary: "", tasks: [] });
    await run("EDITOR", { mode: "chat", input: "x" }, editorModel);
    expect(editorModel.prompts[0]?.system).toContain("Current WBS");
    expect(editorModel.prompts[0]?.system).not.toContain("dailyCapacityMinutes");
  });

  // A18 — the document's injected "zero every existing task" cannot survive,
  // because the ingest vocabulary has no word for it.
  it("emits no proposal when an ingest answer contains an update", async () => {
    const model = fakeModel({
      summary: "3 タスクを追加しました",
      tasks: [
        { op: "add", name: "本物の作業" },
        { op: "update", seq: firstSeq, effortHours: 0 },
      ],
    });
    const result = await run("EDITOR", { mode: "ingest", input: "見積書" }, model);
    expect(result.init?.status).toBe(502);
    expect(result.data.code).toBe("MODEL_SCHEMA_UNMET");
  });
});

describe("proposal API — provider failures are outcomes, not crashes (A9, A10)", () => {
  it.each([
    ["QUOTA_EXHAUSTED", 503, "MODEL_QUOTA_EXHAUSTED"],
    ["SCHEMA_UNMET", 502, "MODEL_SCHEMA_UNMET"],
    ["PROVIDER_UNAVAILABLE", 503, "MODEL_UNAVAILABLE"],
  ] as const)("maps %s to %i", async (code, status, expected) => {
    const model = fakeModel(new ProposalModelError(code, "x"));
    const result = await run("EDITOR", { mode: "chat", input: "x" }, model);
    expect(result.init?.status).toBe(status);
    expect(result.data.code).toBe(expected);
  });

  it("rejects a malformed body without calling the model", async () => {
    const model = fakeModel({ summary: "", tasks: [] });
    const result = await run("EDITOR", { mode: "sideways", input: "x" }, model);
    expect(result.init?.status).toBe(422);
    expect(model.prompts).toHaveLength(0);
  });

  it("rate-limits before spending neurons", async () => {
    const model = fakeModel({ summary: "", tasks: [] });
    const result = await run("EDITOR", { mode: "chat", input: "x" }, model, {
      rateLimitOk: false,
    });
    expect(result.init?.status).toBe(429);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("provider selection — a wrong value fails loudly (A14)", () => {
  const ai = {} as Ai;

  it("uses the ADR's initial provider when nothing is configured", () => {
    expect(selectProposalModel({ AI: ai }).id).toContain(DEFAULT_PROPOSAL_PROVIDER);
  });

  it("treats an empty value as unconfigured", () => {
    expect(selectProposalModel({ AI: ai, ASSISTANT_MODEL_PROVIDER: "  " }).id).toContain(
      DEFAULT_PROPOSAL_PROVIDER,
    );
  });

  it("refuses a provider no adapter implements, rather than falling back", () => {
    // The failure mode being prevented: someone sets `anthropic`, sees the app
    // keep working, and believes their prompts are going to Claude.
    expect(() => selectProposalModel({ AI: ai, ASSISTANT_MODEL_PROVIDER: "anthropic" })).toThrow(
      UnknownProposalProviderError,
    );
  });

  it("says which value it refused", () => {
    try {
      selectProposalModel({ AI: ai, ASSISTANT_MODEL_PROVIDER: "typo-ai" });
      expect.unreachable();
    } catch (error) {
      expect((error as UnknownProposalProviderError).provider).toBe("typo-ai");
      expect((error as Error).message).toContain("typo-ai");
    }
  });
});

describe("proposal API — the misconfigured provider surfaces as an error, not a 500 page", () => {
  it("returns PROVIDER_MISCONFIGURED rather than a 500 page", async () => {
    // No `model` is injected here, so selection runs for real — which is the
    // point: a wrong ASSISTANT_MODEL_PROVIDER has to surface as a message the UI
    // can show, not as an unhandled throw.
    const context = contextFor("EDITOR");
    context.set(appContext, {
      env: {
        COMPUTE_RATE_LIMIT: { limit: async () => ({ success: true }) },
        ASSISTANT_MODEL_PROVIDER: "anthropic",
        AI: {},
      },
      ctx: {},
    } as never);
    const result = (await runAssistantAction({
      request: requestWith({ mode: "chat", input: "x" }),
      context,
    })) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
    expect(result.init?.status).toBe(500);
    expect(result.data.code).toBe("PROVIDER_MISCONFIGURED");
  });
});

describe("proposal API — a CSV costs the model one small answer (ADR 0013 Decision 10)", () => {
  const csv = [
    "作業名,工程,工数(h),備考,担当",
    "認証基盤の実装,設計,40,,Member 01",
    "OIDC 疎通試験,設計,8,,",
    ",,16,小計行なので無視される,",
    "受入テスト,設計,16,,",
  ].join("\n");

  function csvModel(answer: unknown) {
    return fakeModel(answer);
  }

  it("asks only for a column mapping, and shows the header plus three sample rows", async () => {
    const model = csvModel({ name: 0, process: 1, effortHours: 2, note: 3, assignee: 4 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    expect(result.data.ok).toBe(true);
    const prompt = model.prompts[0];
    expect(prompt?.system).toContain("作業名");
    // Row 4 is a sample row; there is no fifth in a 3-row sample.
    expect(prompt?.system).toContain("認証基盤の実装");
    expect(prompt?.system).not.toContain("受入テスト");
    // The answer it was asked for is tiny — that is what keeps neuron cost flat.
    expect(prompt?.maxOutputTokens).toBeLessThanOrEqual(400);
  });

  it("converts EVERY row in TypeScript, not just the sampled ones", async () => {
    const model = csvModel({ name: 0, process: 1, effortHours: 2 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    const proposal = proposalOf(result);
    // Three named rows; the blank-name subtotal row is dropped.
    expect(proposal.commands).toHaveLength(3);
    expect(proposal.diff.addedTasks).toBe(3);
    expect(proposal.csv?.rowCount).toBe(3);
  });

  it("shows the mapping the human has to check, in their own words", async () => {
    const model = csvModel({ name: 0, process: 1, effortHours: 2 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    const csvSummary = proposalOf(result).csv;
    expect(csvSummary?.mapped).toEqual([
      { columnIndex: 0, columnName: "作業名", field: "タスク名" },
      { columnIndex: 1, columnName: "工程", field: "工程" },
      { columnIndex: 2, columnName: "工数(h)", field: "工数(時間)" },
    ]);
    expect(csvSummary?.unmappedColumns).toEqual(["備考", "担当"]);
  });

  it("reports a stray index instead of applying it to every row", async () => {
    const model = csvModel({ name: 0, effortHours: 99 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    expect(proposalOf(result).csv?.issues).toEqual([
      { field: "工数(時間)", reason: "存在しない列を指していたため無視しました" },
    ]);
  });

  it("refuses when no task-name column could be identified", async () => {
    // Guessing which column holds the names is precisely the mistake that would be
    // applied to all rows at once.
    const model = csvModel({ effortHours: 2 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    expect(result.init?.status).toBe(422);
    expect(String(result.data.message)).toContain("タスク名の列");
  });

  it("writes its own summary — there is no model prose in a CSV import at all", async () => {
    const model = csvModel({ name: 0, effortHours: 2 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    expect(proposalOf(result).summary).toContain("3 行");
  });

  it("expands under the INGEST vocabulary, so a spreadsheet cannot touch an existing row", async () => {
    const model = csvModel({ name: 0, effortHours: 2 });
    const result = await run("EDITOR", { mode: "csv", input: csv }, model);
    const types = proposalOf(result).commands.map((command) => command.type);
    expect(new Set(types)).toEqual(new Set(["task.add"]));
  });

  it("tells an oversized file its own limit rather than failing on shape", async () => {
    const big = ["name,hours", ...Array.from({ length: 500 }, (_u, i) => `T${i},8`)].join("\n");
    const model = csvModel({ name: 0, effortHours: 1 });
    const result = await run("EDITOR", { mode: "csv", input: big }, model);
    expect(result.init?.status).toBe(422);
    expect(String(result.data.message)).toContain("400");
    // It failed before spending anything on the model.
    expect(model.prompts).toHaveLength(0);
  });

  it("rejects a header-only file", async () => {
    const model = csvModel({ name: 0 });
    const result = await run("EDITOR", { mode: "csv", input: "name,hours\n" }, model);
    expect(result.init?.status).toBe(422);
    expect(model.prompts).toHaveLength(0);
  });

  it("treats an unparseable mapping answer as a normal failure", async () => {
    const result = await run("EDITOR", { mode: "csv", input: csv }, csvModel("A 列です"));
    expect(result.init?.status).toBe(502);
    expect(result.data.code).toBe("MODEL_SCHEMA_UNMET");
  });
});
