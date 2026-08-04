import {
  CSV_MAPPABLE_FIELDS,
  CsvParseError,
  MAX_IR_TASKS,
  ProposalModelError,
  PromptTooLargeError,
  SnapshotTooLargeError,
  assistantContextBudget,
  buildCsvMappingPrompt,
  buildProposalDiff,
  buildProposalPrompt,
  buildWbsSnapshot,
  checkOutputFits,
  csvColumnSample,
  csvRowsToIngestTasks,
  estimateProposalUsage,
  expandIr,
  parseCsv,
  parseCsvMapping,
  parseIr,
  projectWbsGrid,
  projectWorkspaceView,
  projectionRoleForProjectRole,
  renderMasters,
  sanitiseCsvMapping,
  type AssistantMode,
  type AssistantProjectView,
  type CsvTable,
  type DiffProjectView,
  type ProposalModel,
  type ProposalPrompt,
} from "@vecta/application";
import { data, type RouterContextProvider } from "react-router";
import { z } from "zod";
import { requireProjectMembership, requireProjectWorkspace } from "./project-access.server";
import { requirePrincipal } from "../auth/require-principal.server";
import { appContext } from "../context.server";
import { selectProposalModel, UnknownProposalProviderError } from "../llm/select-model.server";
import {
  ASSISTANT_PROPOSAL_KIND,
  type AssistantErrorCode,
  type CsvImportSummary,
  type ProposalCommand,
} from "~/assistant/proposal-contract";
import { ApiCommandSchema, fromCommand } from "~/wbs/project-command-contract";

/**
 * The proposal action (ADR 0013 Decision 1). It READS the workspace, asks a model
 * for an IR, expands it, and returns commands plus a diff. It never writes.
 *
 * Applying is the existing `runCommandAction`, unchanged — this file imports
 * neither it nor the command service, and `.github/scripts/verify-assistant-
 * boundary.mjs` fails the build if that ever stops being true. The consequence is
 * that the assistant path CANNOT bypass authorization, the optimistic lock, or
 * the audit log, because it has no way to reach the database at all.
 *
 * The proposal carries the revision it was generated against. When the user
 * finally presses apply, that revision travels with the batch, so a proposal
 * built on a WBS someone else has since changed is rejected by the existing
 * conflict path rather than silently applied to a plan it never saw.
 */

/** Mirrors `/mcp`'s cap. A proposal request is prose, not a payload. */
const MAX_BODY_BYTES = 64 * 1024;

const HistoryTurnSchema = z
  .object({ role: z.enum(["user", "assistant"]), content: z.string().max(8_000) })
  .strict();

const AssistantRequestSchema = z
  .object({
    // `csv` is a request mode, not a trust boundary: a spreadsheet expands under
    // the ingest vocabulary, so it cannot address an existing row either.
    mode: z.enum(["ingest", "chat", "csv"]),
    input: z.string().min(1).max(60_000),
    /** Client-held, never persisted (requirement 8). Ignored outside chat mode. */
    history: z.array(HistoryTurnSchema).max(40).optional(),
  })
  .strict();

/**
 * Japanese labels for the mapping the human checks. Kept next to the request
 * schema rather than in the shared core: the core stays language-neutral, and this
 * is presentation.
 */
const CSV_FIELD_LABEL: Readonly<Record<(typeof CSV_MAPPABLE_FIELDS)[number], string>> = {
  name: "タスク名",
  parent: "親タスク名",
  process: "工程",
  product: "プロダクト",
  assignee: "担当",
  effortHours: "工数(時間)",
  note: "備考",
};

const CSV_ISSUE_LABEL: Readonly<Record<string, string>> = {
  "out-of-range": "存在しない列を指していたため無視しました",
  "duplicate-column": "他の項目と同じ列を指していたため無視しました",
};

function fail(code: AssistantErrorCode, status: number, message: string) {
  return data({ ok: false as const, code, message }, { status });
}

export interface AssistantActionArgs {
  readonly request: Request;
  readonly context: Readonly<RouterContextProvider>;
  /** Injected in tests so the whole action runs without a network call (A11). */
  readonly model?: ProposalModel;
}

export async function runAssistantAction({ request, context, model }: AssistantActionArgs) {
  const principal = await requirePrincipal(context);
  const membership = requireProjectMembership(context);

  // ADR 0013 Decision 7 — EDITOR or better, even though this path only reads.
  // Letting a VIEWER generate proposals would make the role projection of §6 the
  // thing standing between a viewer and privileged data, and there is no reason
  // to give someone who cannot approve the ability to propose.
  if (membership.projectRole === "VIEWER") {
    return fail("FORBIDDEN", 403, "アシスタントの利用には編集権限が必要です");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return fail("TOO_LARGE", 413, "入力が大きすぎます");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return fail("INVALID", 400, "リクエストの形式が不正です");
  }
  const parsedRequest = AssistantRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    return fail("INVALID", 422, "リクエストの内容が不正です");
  }
  const requestMode = parsedRequest.data.mode;
  // A spreadsheet is a third party's document, so it expands under the INGEST
  // vocabulary: add-only, no way to address an existing row.
  const mode: AssistantMode = requestMode === "csv" ? "ingest" : requestMode;

  const { env } = context.get(appContext);

  // The free allowance is a CLOUDFLARE ACCOUNT resource, not a per-user one — one
  // editor can spend the day's neurons before lunch and everyone else waits until
  // 00:00 UTC (ADR 0013 Consequences: first-come-first-served, accepted for the
  // first version). This limiter does not fix that; it stops one tab from doing it
  // by accident.
  const limit = await env.COMPUTE_RATE_LIMIT.limit({
    key: `assistant:${membership.projectId}:${principal.principal.id}`,
  });
  if (!limit.success) {
    return fail("RATE_LIMITED", 429, "しばらく待ってから再度お試しください");
  }

  let proposalModel: ProposalModel;
  try {
    proposalModel = model ?? selectProposalModel(env);
  } catch (error) {
    if (error instanceof UnknownProposalProviderError) {
      return fail("PROVIDER_MISCONFIGURED", 500, "推論プロバイダの設定が不正です");
    }
    throw error;
  }

  const workspace = await requireProjectWorkspace(context);
  // Design 0005 §6 / ADR 0013 Decision 11 — the prompt is built from the
  // ROLE-PROJECTED read model the caller is entitled to, never from raw rows. A
  // GENERAL projection has no `dailyCapacityMinutes` at the type level, so a
  // field the user cannot see on screen cannot come back out through an answer.
  const role = projectionRoleForProjectRole(membership.projectRole);
  const projected = projectWorkspaceView(workspace.current, role);
  const grid = projectWbsGrid(workspace.current, { role });

  const budget = assistantContextBudget(mode, proposalModel.contextTokenBudget);

  let snapshotText: string;
  try {
    snapshotText = buildWbsSnapshot(grid.rows, budget).text;
  } catch (error) {
    if (error instanceof SnapshotTooLargeError) {
      return fail(
        "PROJECT_TOO_LARGE",
        422,
        `このプロジェクトは ${error.actualTasks} 件のタスクがあり、現在のモデルが一度に扱えるのは約 ${error.capacityTasks} 件です。対象を絞ってください。`,
      );
    }
    throw error;
  }

  // A CSV asks the model a DIFFERENT question — which column feeds which field —
  // and the file itself never goes to it, so this branch parses first and prompts
  // with a header plus three sample rows. Neuron cost stops depending on row count
  // (Design 0005 §4, ADR 0013 Decision 10).
  let table: CsvTable | null = null;
  let prompt: ProposalPrompt;
  if (requestMode === "csv") {
    try {
      table = parseCsv(parsedRequest.data.input, { maxRows: MAX_IR_TASKS });
    } catch (error) {
      if (error instanceof CsvParseError) {
        // Includes the row cap, so an oversized file is told its own limit rather
        // than failing later as an opaque shape error.
        return fail("INVALID", 422, `CSV を読み取れませんでした: ${error.message}`);
      }
      throw error;
    }
    if (table.rows.length === 0) {
      return fail("INVALID", 422, "CSV にデータ行がありません（1 行目はヘッダとして読みます）。");
    }
    prompt = buildCsvMappingPrompt(csvColumnSample(table), budget);
  } else {
    // A21 — refuse BEFORE generating when the expected IR cannot fit the output
    // slot. A truncated IR is not a partial success: JSON Mode fails on it every
    // time, so it is better to say "split the document" than to spend the
    // account's neurons discovering that. Lines are the proxy for task count in a
    // pasted document — an over-estimate for prose (which fails safe) and about
    // right for the list-shaped estimates this mode is for.
    if (mode === "ingest") {
      const lines = parsedRequest.data.input.split("\n").filter((line) => line.trim().length > 0).length;
      const fit = checkOutputFits(lines, budget);
      if (!fit.fits) {
        return fail(
          "TOO_LARGE",
          422,
          `この見積書は ${lines} 行あり、一度に扱えるのは約 ${fit.maxRows} 行です。分割してください。`,
        );
      }
    }
    try {
      prompt = buildProposalPrompt({
        mode,
        snapshot: snapshotText,
        masters: renderMasters({
          processes: projected.processes.map((entry) => entry.name),
          products: projected.products.map((entry) => entry.name),
          members: projected.members.map((entry) => entry.name),
          templates: projected.templates.map((entry) => entry.name),
        }),
        ...(mode === "chat" && parsedRequest.data.history !== undefined
          ? { history: parsedRequest.data.history }
          : {}),
        userInput: parsedRequest.data.input,
        budget,
      });
    } catch (error) {
      if (error instanceof PromptTooLargeError) {
        return fail("TOO_LARGE", 422, "入力が長すぎます。分割してください。");
      }
      throw error;
    }
  }

  let output;
  try {
    output = await proposalModel.propose(prompt);
  } catch (error) {
    if (error instanceof ProposalModelError) {
      if (error.code === "QUOTA_EXHAUSTED") {
        return fail("MODEL_QUOTA_EXHAUSTED", 503, "本日の無料枠を使い切りました");
      }
      if (error.code === "SCHEMA_UNMET") {
        return fail("MODEL_SCHEMA_UNMET", 502, "AI の応答を解釈できませんでした");
      }
      return fail("MODEL_UNAVAILABLE", 503, "AI を利用できませんでした");
    }
    throw error;
  }

  // A CSV's IR is built by TYPESCRIPT from the parsed rows, using nothing from the
  // model but the column mapping. So a 300-row import has no model-authored prose
  // in it at all — including its `summary`, which this branch writes.
  let csvSummary: CsvImportSummary | null = null;
  let irCandidate: unknown = output.raw;
  if (requestMode === "csv" && table !== null) {
    const parsedMapping = parseCsvMapping(output.raw);
    if (!parsedMapping.ok) {
      return fail("MODEL_SCHEMA_UNMET", 502, "AI の応答を解釈できませんでした");
    }
    const { mapping, issues } = sanitiseCsvMapping(
      parsedMapping.mapping as Readonly<Record<string, unknown>>,
      table.header,
    );
    if (mapping.name === undefined) {
      // Without a task-name column there is nothing to create, and guessing which
      // column holds the names is exactly the mistake that would be applied to
      // every row at once.
      return fail(
        "INVALID",
        422,
        "タスク名の列を特定できませんでした。1 行目のヘッダにタスク名の列があるか確認してください。",
      );
    }
    const tasks = csvRowsToIngestTasks(table, mapping);
    if (tasks.length === 0) {
      return fail("INVALID", 422, "タスク名が入っている行がありませんでした。");
    }
    const claimed = new Set(Object.values(mapping));
    csvSummary = {
      rowCount: tasks.length,
      mapped: CSV_MAPPABLE_FIELDS.filter((field) => mapping[field] !== undefined).map((field) => ({
        columnIndex: mapping[field] as number,
        columnName: table.header[mapping[field] as number] ?? "",
        field: CSV_FIELD_LABEL[field],
      })),
      unmappedColumns: table.header.filter((_name, index) => !claimed.has(index)),
      issues: issues.map((issue) => ({
        field: CSV_FIELD_LABEL[issue.field],
        reason: CSV_ISSUE_LABEL[issue.reason] ?? issue.reason,
      })),
    };
    irCandidate = {
      summary: `CSV の ${tasks.length} 行をタスク案にしました。列の対応は下に表示しています。`,
      tasks,
    };
  }

  // Documented as possible, so treated as a normal outcome: no proposal, and no
  // attempt to salvage part of a malformed IR (ADR 0013 Consequences). The CSV
  // branch goes through the SAME schema, which is what bounds a 1 MB spreadsheet
  // cell before it becomes a task name.
  const parsedIr = parseIr(mode, irCandidate);
  if (!parsedIr.ok) {
    return fail(
      "MODEL_SCHEMA_UNMET",
      502,
      requestMode === "csv"
        ? "CSV の内容が取り込める形になっていませんでした。"
        : "AI の応答を解釈できませんでした",
    );
  }

  const expanderView: AssistantProjectView = {
    defaultCalendarId: projected.defaultCalendarId,
    members: projected.members,
    processes: projected.processes,
    products: projected.products,
    templates: projected.templates,
    tasks: workspace.current.tasks,
  };
  const { commands, unresolved } = expandIr(mode, parsedIr.ir, expanderView);

  // Acceptance A1's boundary half: the expansion is re-validated against the SAME
  // wire contract a hand edit goes through. A failure here is a bug in the
  // expander, not a bad answer, so the proposal is discarded rather than trimmed.
  const wireCommands: ProposalCommand[] = [];
  for (const command of commands) {
    const validated = ApiCommandSchema.safeParse(fromCommand(command));
    if (!validated.success) {
      return fail("MODEL_SCHEMA_UNMET", 502, "提案を組み立てられませんでした");
    }
    wireCommands.push(validated.data);
  }

  const diffView: DiffProjectView = {
    tasks: workspace.current.tasks,
    processes: projected.processes,
    products: projected.products,
    members: projected.members,
    templates: projected.templates,
  };

  return data({
    ok: true as const,
    // `shouldRevalidate` keys on this discriminant, never on a bare `{ ok: true }`.
    // A proposal changed nothing, so the loader must not re-read the workspace.
    kind: ASSISTANT_PROPOSAL_KIND,
    proposal: {
      mode,
      /** The revision this proposal was built against; the apply POST carries it. */
      expectedRevision: workspace.revision.toString(),
      commands: wireCommands,
      // Derived from the commands and the current state — the model's `summary`
      // is not an input to it (ADR 0013 Decision 5).
      diff: buildProposalDiff(commands, diffView),
      unresolved,
      /**
       * The model's own words. Shown as an explanation and visually separated
       * from the diff, rendered as PLAIN TEXT with no link or image resolution
       * (ADR 0013 Decision 6): a markdown image is an exfiltration channel that
       * fires on render, long before anyone decides whether to approve.
       */
      summary: parsedIr.ir.summary,
      ...(csvSummary === null ? {} : { csv: csvSummary }),
      model: proposalModel.id,
      // Measured 2026-07-26: the Workers AI binding reports no `usage` for this
      // call shape. Rather than tell the reader nothing, fall back to our own
      // character-based approximation of what we sent and received — flagged
      // `estimated` so it can never be read as the provider's measurement.
      usage: output.usage ?? estimateProposalUsage(prompt, output.raw),
    },
  });
}
