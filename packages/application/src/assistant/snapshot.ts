import type { AssistantMode } from "./ir.js";

/**
 * Prompt context: what goes to the model, and how much of it fits
 * (Design 0005 §6, ADR 0013 Decision 11).
 *
 * Two rules shape this module.
 *
 * The snapshot is built from data the caller has ALREADY role-projected — the
 * loader's output, never a fresh read. VECTA projects member fields by role
 * (`dailyCapacityMinutes` is absent for GENERAL), so re-reading raw rows to build
 * a prompt would open a path where a field the user cannot see on screen comes
 * back out through the model's answer.
 *
 * And nothing is silently truncated. A quietly-clipped snapshot makes the model
 * reason about a WBS that is missing rows, and neither it nor the human can tell:
 * the proposal looks complete. Over the limit, this module fails and says how
 * many tasks would fit.
 */

/** Fixed overhead: the system prompt plus the master lists, which every mode sends. */
const FIXED_PROMPT_TOKENS = 3_000;

/**
 * Percent of the REMAINING budget per slot, as WHOLE numbers summing to 100.
 * Chat is input-heavy with a one-line answer; ingest is the reverse — Design 0005
 * §3.2 estimates 100 tasks of IR at ~2,500 output tokens, so a 1,000-token output
 * slot would cut the IR off mid-JSON on exactly the workload the feature exists
 * for.
 *
 * Integers, not fractions: `21000 * 0.57` is 11969.999… in binary floating point,
 * so flooring a fractional share silently lands a token below the design's table.
 * `remaining * 57 / 100` is exact.
 */
const ALLOCATION: Readonly<
  Record<AssistantMode, Readonly<Record<keyof AssistantContextBudget, number>>>
> = {
  chat: { snapshotTokens: 57, historyTokens: 14, inputTokens: 24, outputTokens: 5 },
  ingest: { snapshotTokens: 38, historyTokens: 0, inputTokens: 43, outputTokens: 19 },
};

export interface AssistantContextBudget {
  readonly snapshotTokens: number;
  readonly historyTokens: number;
  /** The user's utterance (chat) or the estimate document (ingest). */
  readonly inputTokens: number;
  /** Headroom for the generated IR; becomes the request's `max_tokens`. */
  readonly outputTokens: number;
}

/**
 * Derive the per-slot budget from the PROVIDER's context window rather than a
 * literal 24,000 (requirement 9). Swapping in a model with a far larger window
 * should widen these slots without anyone editing this file.
 */
export function assistantContextBudget(
  mode: AssistantMode,
  contextTokenBudget: number,
): AssistantContextBudget {
  const remaining = Math.max(0, contextTokenBudget - FIXED_PROMPT_TOKENS);
  const share = ALLOCATION[mode];
  const slot = (percent: number): number => Math.floor((remaining * percent) / 100);
  return {
    snapshotTokens: slot(share.snapshotTokens),
    historyTokens: slot(share.historyTokens),
    inputTokens: slot(share.inputTokens),
    outputTokens: slot(share.outputTokens),
  };
}

/**
 * Character-based token estimate. Workers AI ships no client-side tokenizer, so
 * this is an approximation by construction — and it leans HIGH (a CJK character
 * counted as a whole token, other characters at one per three) so the failure
 * mode is "refused a request that would have fit", not "sent one that didn't".
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef);
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3);
}

/** One row of the snapshot. Satisfied by the grid projection's row type. */
export interface SnapshotTaskRow {
  readonly seq: number;
  readonly parentId: string | null;
  readonly id: string;
  readonly name: string;
  readonly processName: string;
  readonly productName: string;
  readonly assigneeName: string | null;
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
}

export interface SnapshotMasters {
  readonly processes: readonly string[];
  readonly products: readonly string[];
  readonly members: readonly string[];
  readonly templates: readonly string[];
}

export class SnapshotTooLargeError extends Error {
  /** How many tasks DO fit — the number the message has to state (Design 0005 §6). */
  readonly capacityTasks: number;
  readonly actualTasks: number;

  constructor(capacityTasks: number, actualTasks: number) {
    super(
      `This project has ${actualTasks} tasks; the current model can hold about ${capacityTasks}. Narrow the scope instead of letting the assistant see a partial plan.`,
    );
    this.name = "SnapshotTooLargeError";
    this.capacityTasks = capacityTasks;
    this.actualTasks = actualTasks;
  }
}

const HEADER =
  "# WBS (TSV: seq / name / process / product / assignee / planned_hours / progress_pct)\n" +
  "# Indentation shows the parent-child tree. Reference an existing task by its seq, never by name.";

function hours(minutes: number): string {
  const value = minutes / 60;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function renderRow(row: SnapshotTaskRow, depth: number): string {
  const indent = "  ".repeat(depth);
  return [
    row.seq,
    `${indent}${row.name}`,
    row.processName,
    row.productName,
    row.assigneeName ?? "",
    hours(row.plannedEffortMinutes),
    row.progressBasisPoints / 100,
  ].join("\t");
}

function depthById(rows: readonly SnapshotTaskRow[]): Map<string, number> {
  const parentById = new Map(rows.map((row) => [row.id, row.parentId]));
  const depths = new Map<string, number>();
  for (const row of rows) {
    let depth = 0;
    let parentId = row.parentId;
    const guard = new Set<string>([row.id]);
    while (parentId !== null && !guard.has(parentId)) {
      guard.add(parentId);
      depth += 1;
      parentId = parentById.get(parentId) ?? null;
    }
    depths.set(row.id, depth);
  }
  return depths;
}

export interface WbsSnapshot {
  readonly text: string;
  readonly estimatedTokens: number;
  readonly taskCount: number;
}

/**
 * Render the role-projected grid rows as the compact TSV the prompt carries.
 * Throws {@link SnapshotTooLargeError} rather than dropping rows.
 */
export function buildWbsSnapshot(
  rows: readonly SnapshotTaskRow[],
  budget: AssistantContextBudget,
): WbsSnapshot {
  const depths = depthById(rows);
  const lines = rows.map((row) => renderRow(row, depths.get(row.id) ?? 0));
  const text = [HEADER, ...lines].join("\n");
  const estimatedTokens = estimateTokens(text);

  if (estimatedTokens > budget.snapshotTokens && rows.length > 0) {
    // Report capacity in TASKS, since that is the unit the user can act on. Uses
    // the measured average row cost of this very project, so the number reflects
    // the real names rather than a guess.
    const perRow = estimatedTokens / rows.length;
    const capacity = Math.max(0, Math.floor(budget.snapshotTokens / perRow));
    throw new SnapshotTooLargeError(capacity, rows.length);
  }

  return { text, estimatedTokens, taskCount: rows.length };
}

/** The master lists the model needs in order to reference them by name. */
export function renderMasters(masters: SnapshotMasters): string {
  const section = (label: string, names: readonly string[]): string =>
    `${label}: ${names.length === 0 ? "(none)" : names.join(" / ")}`;
  return [
    section("工程 (process)", masters.processes),
    section("プロダクト (product)", masters.products),
    section("メンバー (member)", masters.members),
    section("テンプレート (template)", masters.templates),
  ].join("\n");
}

/**
 * Refuse before generating when the expected IR cannot fit in the output slot
 * (Design 0005 §6, acceptance A21). Truncated JSON is not a partial success — it
 * is a JSON Mode error every time, so it is better to say "split the file" than
 * to spend the neurons discovering it.
 */
const ESTIMATED_IR_TOKENS_PER_TASK = 25;

export interface OutputFitResult {
  readonly fits: boolean;
  readonly requiredTokens: number;
  readonly availableTokens: number;
  readonly maxRows: number;
}

export function checkOutputFits(
  rowCount: number,
  budget: AssistantContextBudget,
): OutputFitResult {
  const requiredTokens = rowCount * ESTIMATED_IR_TOKENS_PER_TASK;
  return {
    fits: requiredTokens <= budget.outputTokens,
    requiredTokens,
    availableTokens: budget.outputTokens,
    maxRows: Math.floor(budget.outputTokens / ESTIMATED_IR_TOKENS_PER_TASK),
  };
}
