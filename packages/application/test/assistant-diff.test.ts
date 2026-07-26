import { describe, expect, it } from "vitest";
import {
  buildProposalDiff,
  expandIr,
  parseIr,
  type AssistantProjectView,
  type DiffProjectView,
} from "../src/index.js";

const diffView: DiffProjectView = {
  tasks: [
    {
      id: "task-1",
      seq: 17,
      name: "認証基盤の実装",
      processId: "process-1",
      productId: null,
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 2_400,
      progressBasisPoints: 2_000,
      note: "",
    },
  ],
  processes: [{ id: "process-1", name: "設計" }],
  products: [{ id: "product-1", name: "認証" }],
  members: [{ id: "member-1", name: "Member 01" }],
  templates: [{ id: "template-1", name: "標準3ステップ" }],
};

const expanderView: AssistantProjectView = {
  defaultCalendarId: "standard",
  members: diffView.members,
  processes: diffView.processes.map((entry) => ({ ...entry, sortOrder: 0 })),
  products: diffView.products.map((entry) => ({ ...entry, sortOrder: 0 })),
  templates: diffView.templates,
  tasks: diffView.tasks.map((task) => ({ ...task, sortOrder: 0 })),
};

function diffOf(mode: "ingest" | "chat", raw: unknown) {
  const parsed = parseIr(mode, raw);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  let next = 0;
  const { commands } = expandIr(mode, parsed.ir, expanderView, {
    newId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
  });
  return buildProposalDiff(commands, diffView);
}

describe("approval diff — derived from the commands, never from the summary (A16)", () => {
  const destructive = {
    tasks: [{ op: "update" as const, seq: 17, effortHours: 0, progressPercent: 0 }],
  };

  it("shows the real change even when the summary describes something else", () => {
    const honest = diffOf("chat", { summary: "No.17 の工数と進捗を 0 にします", ...destructive });
    const lying = diffOf("chat", { summary: "3 タスクを追加しました", ...destructive });
    // Byte-identical: the summary is not an input to this function at all, so no
    // sentence an attacker writes can change what the approver sees.
    expect(lying).toEqual(honest);
    expect(lying.updatedTasks).toBe(1);
    expect(lying.addedTasks).toBe(0);
  });

  it("shows an update as before → after, so an erasure is visible as one", () => {
    const diff = diffOf("chat", { summary: "", ...destructive });
    expect(diff.entries[0]?.target).toBe("No.17 認証基盤の実装");
    expect(diff.entries[0]?.changes).toEqual([
      { field: "計画工数", before: "40 h", after: "0 h" },
      { field: "進捗", before: "20 %", after: "0 %" },
    ]);
  });

  it("names the master a new task points at, including one created by this proposal", () => {
    const diff = diffOf("ingest", {
      summary: "",
      tasks: [{ op: "add", name: "受入テスト", process: "受入", effortHours: 8 }],
      masters: [{ kind: "process", op: "add", name: "受入" }],
    });
    const taskEntry = diff.entries.find((entry) => entry.commandType === "task.add");
    // Not a raw UUID: an approver has to be able to check what they are approving.
    expect(taskEntry?.changes).toContainEqual({ field: "工程", before: null, after: "受入" });
    expect(diff.addedTasks).toBe(1);
    expect(diff.masterChanges).toBe(1);
  });

  it("labels a new task's parent by name when the parent is also new", () => {
    const diff = diffOf("ingest", {
      summary: "",
      tasks: [
        { op: "add", name: "親" },
        { op: "add", name: "子", parent: "親" },
      ],
    });
    const child = diff.entries.find((entry) => entry.target === "新規タスク 子");
    expect(child?.changes).toContainEqual({ field: "親タスク", before: null, after: "新規 親" });
  });

  it("names the template a generateSubtasks would apply", () => {
    const diff = diffOf("chat", {
      summary: "",
      tasks: [{ op: "generateSubtasks", seq: 17, template: "標準3ステップ" }],
    });
    expect(diff.entries[0]).toEqual({
      commandType: "task.generateSubtasks",
      operation: "generate",
      target: "No.17 認証基盤の実装",
      changes: [{ field: "テンプレート適用", before: null, after: "標準3ステップ" }],
    });
  });

  it("counts nothing when the proposal is empty", () => {
    const diff = buildProposalDiff([], diffView);
    expect(diff).toEqual({ entries: [], addedTasks: 0, updatedTasks: 0, masterChanges: 0 });
  });
});
