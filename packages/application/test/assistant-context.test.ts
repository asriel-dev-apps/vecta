import { describe, expect, it } from "vitest";
import {
  PromptTooLargeError,
  SnapshotTooLargeError,
  assistantContextBudget,
  buildProposalPrompt,
  buildWbsSnapshot,
  checkOutputFits,
  estimateTokens,
  renderMasters,
  type SnapshotTaskRow,
} from "../src/index.js";

function row(overrides: Partial<SnapshotTaskRow> & Pick<SnapshotTaskRow, "id" | "seq">): SnapshotTaskRow {
  return {
    parentId: null,
    name: "タスク",
    processName: "",
    productName: "",
    assigneeName: null,
    plannedEffortMinutes: 0,
    progressBasisPoints: 0,
    ...overrides,
  };
}

/** The initial provider's window. Never hard-coded in src — passed in from the port. */
const LLAMA_70B_CONTEXT = 24_000;

describe("context budget — derived from the provider, not from a literal", () => {
  it("splits the 24,000-token window exactly as Design 0005 §6 tabulates", () => {
    expect(assistantContextBudget("chat", LLAMA_70B_CONTEXT)).toEqual({
      snapshotTokens: 11_970,
      historyTokens: 2_940,
      inputTokens: 5_040,
      outputTokens: 1_050,
    });
    expect(assistantContextBudget("ingest", LLAMA_70B_CONTEXT)).toEqual({
      snapshotTokens: 7_980,
      historyTokens: 0,
      inputTokens: 9_030,
      outputTokens: 3_990,
    });
  });

  it("widens every slot when a larger model is swapped in", () => {
    const wide = assistantContextBudget("chat", 200_000);
    const narrow = assistantContextBudget("chat", LLAMA_70B_CONTEXT);
    expect(wide.snapshotTokens).toBeGreaterThan(narrow.snapshotTokens);
    expect(wide.outputTokens).toBeGreaterThan(narrow.outputTokens);
  });

  it("gives ingest the larger output slot, since it is the mode that generates bulk", () => {
    const ingest = assistantContextBudget("ingest", LLAMA_70B_CONTEXT);
    const chat = assistantContextBudget("chat", LLAMA_70B_CONTEXT);
    expect(ingest.outputTokens).toBeGreaterThan(chat.outputTokens);
    // Design 0005 §3.2 puts 100 tasks of IR at ~2,500 output tokens; the slot has
    // to clear that or the feature's main use case truncates every time.
    expect(ingest.outputTokens).toBeGreaterThan(2_500);
  });

  it("estimates tokens on the high side, so it fails early rather than overflowing", () => {
    // Real tokenizers put ASCII at roughly one token per four characters.
    expect(estimateTokens("abcdefghijkl")).toBeGreaterThanOrEqual(4);
    expect(estimateTokens("設計工程")).toBe(4);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("snapshot — refuse, never truncate (ADR 0013 Decision 11)", () => {
  const budget = assistantContextBudget("chat", LLAMA_70B_CONTEXT);

  it("renders seq, the tree depth, and the human units", () => {
    const snapshot = buildWbsSnapshot(
      [
        row({ id: "a", seq: 1, name: "親", plannedEffortMinutes: 2_400 }),
        row({ id: "b", seq: 2, name: "子", parentId: "a", progressBasisPoints: 5_000 }),
      ],
      budget,
    );
    const lines = snapshot.text.split("\n");
    expect(lines.at(-2)).toContain("1\t親");
    expect(lines.at(-2)).toContain("40"); // 2,400 minutes shown as 40 hours
    expect(lines.at(-1)).toContain("2\t  子"); // indented one level
    expect(lines.at(-1)?.endsWith("50")).toBe(true); // 5,000 bp shown as 50 percent
    expect(snapshot.taskCount).toBe(2);
  });

  it("fits production's scale with room to spare", () => {
    const rows = Array.from({ length: 48 }, (_unused, index) =>
      row({ id: `t${index}`, seq: index + 1, name: `作業項目 ${index}`, processName: "設計" }),
    );
    expect(() => buildWbsSnapshot(rows, budget)).not.toThrow();
  });

  it("fails with the number of tasks that WOULD fit, rather than dropping rows", () => {
    const rows = Array.from({ length: 4_000 }, (_unused, index) =>
      row({ id: `t${index}`, seq: index + 1, name: `かなり長い日本語のタスク名 ${index}` }),
    );
    let thrown: unknown;
    try {
      buildWbsSnapshot(rows, budget);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnapshotTooLargeError);
    const error = thrown as SnapshotTooLargeError;
    expect(error.actualTasks).toBe(4_000);
    expect(error.capacityTasks).toBeGreaterThan(0);
    expect(error.capacityTasks).toBeLessThan(4_000);
    expect(error.message).toContain(String(error.capacityTasks));
  });

  it("survives a cyclic parent link without hanging", () => {
    const rows = [row({ id: "a", seq: 1, parentId: "b" }), row({ id: "b", seq: 2, parentId: "a" })];
    expect(() => buildWbsSnapshot(rows, budget)).not.toThrow();
  });

  it("names every master list, including the empty ones", () => {
    const text = renderMasters({ processes: ["設計"], products: [], members: [], templates: [] });
    expect(text).toContain("設計");
    expect(text).toContain("(none)");
  });
});

describe("output fit — detected BEFORE generating (A21)", () => {
  const budget = assistantContextBudget("ingest", LLAMA_70B_CONTEXT);

  it("passes an import the output slot can hold", () => {
    expect(checkOutputFits(100, budget).fits).toBe(true);
  });

  it("refuses one it cannot, and says how many rows do fit", () => {
    const result = checkOutputFits(5_000, budget);
    expect(result.fits).toBe(false);
    expect(result.maxRows).toBeGreaterThan(0);
    expect(result.requiredTokens).toBeGreaterThan(result.availableTokens);
  });
});

describe("prompt assembly — built in the core, never by an adapter", () => {
  const budget = assistantContextBudget("chat", LLAMA_70B_CONTEXT);
  const base = { mode: "chat" as const, snapshot: "1\t既存", masters: "工程: 設計", budget };

  it("carries the schema the core will validate against", () => {
    const prompt = buildProposalPrompt({ ...base, userInput: "No.1 を 50% にして" });
    expect(prompt.schema).toBeTypeOf("object");
    expect(prompt.maxOutputTokens).toBe(budget.outputTokens);
    expect(prompt.messages.at(-1)).toEqual({ role: "user", content: "No.1 を 50% にして" });
  });

  it("tells an ingest model that the document is data, not instructions", () => {
    const prompt = buildProposalPrompt({
      ...base,
      mode: "ingest",
      budget: assistantContextBudget("ingest", LLAMA_70B_CONTEXT),
      userInput: "見積書",
    });
    expect(prompt.system).toContain("DOCUMENT SOMEBODY ELSE WROTE");
    expect(prompt.system).not.toContain("progressPercent");
  });

  it("drops the oldest history first, keeping the utterance and the WBS whole", () => {
    const history = Array.from({ length: 200 }, (_unused, index) => ({
      role: "user" as const,
      content: `過去の発話 ${index} `.repeat(40),
    }));
    const prompt = buildProposalPrompt({ ...base, history, userInput: "最新の発話" });
    expect(prompt.messages.length).toBeLessThan(history.length + 1);
    expect(prompt.messages.at(-1)?.content).toBe("最新の発話");
    // The turn immediately before the utterance is the most recent history entry,
    // and the ones that fell off the front are the oldest.
    expect(prompt.messages.at(-2)?.content).toContain("過去の発話 199");
    expect(prompt.messages.at(0)?.content).not.toContain("過去の発話 0 ");
  });

  it("refuses an utterance past its slot rather than clipping it", () => {
    expect(() =>
      buildProposalPrompt({ ...base, userInput: "あ".repeat(budget.inputTokens + 1) }),
    ).toThrow(PromptTooLargeError);
  });

  it("sends no history at all in ingest mode", () => {
    const prompt = buildProposalPrompt({
      ...base,
      mode: "ingest",
      budget: assistantContextBudget("ingest", LLAMA_70B_CONTEXT),
      history: [{ role: "user", content: "以前の会話" }],
      userInput: "見積書",
    });
    expect(prompt.messages).toHaveLength(1);
  });
});
