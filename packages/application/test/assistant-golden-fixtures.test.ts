import { describe, expect, it } from "vitest";
import {
  GOLDEN_FIXTURES,
  GOLDEN_PROJECT,
  runGoldenFixtures,
  type ProposalModel,
  type ProposalPrompt,
} from "../src/index.js";

/**
 * The fixture suite is the mechanism that makes "swappable provider" checkable
 * rather than aspirational (ADR 0013 Decision 12, A13). So the suite ITSELF needs
 * checking: a property test that cannot fail would report every provider as
 * perfect.
 *
 * Each fixture is therefore driven twice — with a canned answer that satisfies it
 * and one that violates it — against a fake model. That proves the checks
 * discriminate. It does NOT measure any real model: A13's number comes from running
 * `runGoldenFixtures` against a live provider, which needs the account's neurons
 * and is deliberately not part of `pnpm check`.
 */

function scripted(answers: Readonly<Record<string, unknown>>): ProposalModel {
  return {
    id: "fake:scripted",
    contextTokenBudget: 24_000,
    isFreeTier: true,
    egress: "in-account",
    propose(prompt: ProposalPrompt) {
      // Route by the fixture's own input text, which is the only thing that varies.
      const utterance = prompt.messages.at(-1)?.content ?? "";
      const key = Object.keys(answers).find((needle) => utterance.includes(needle));
      return Promise.resolve({
        raw: key === undefined ? { summary: "", tasks: [] } : answers[key],
        usage: { unit: "tokens", input: 3_600, output: 200 },
      });
    },
  };
}

const TASK_1 = GOLDEN_PROJECT.tasks[0]!.seq;

const GOOD: Readonly<Record<string, unknown>> = {
  "50%": { summary: "1 件更新します", tasks: [{ op: "update", seq: TASK_1, progressPercent: 50 }] },
  "1. 認証機能": {
    summary: "3 件追加します",
    tasks: [
      { op: "add", name: "認証機能" },
      { op: "add", name: "設計", parent: "認証機能", effortHours: 8 },
      { op: "add", name: "実装", parent: "認証機能", effortHours: 24 },
    ],
  },
  完了したタスクを全部消して: { summary: "削除は対応していません", tasks: [] },
  受入テストの実施: {
    summary: "1 件追加します",
    tasks: [{ op: "add", name: "受入テストの実施", process: "受入", effortHours: 16 }],
    masters: [{ kind: "process", op: "add", name: "受入" }],
  },
  新機能の実装: { summary: "1 件追加します", tasks: [{ op: "add", name: "新機能の実装", effortHours: 40 }] },
  設計作業: { summary: "1 件追加します", tasks: [{ op: "add", name: "設計作業", effortHours: 8 }] },
};

describe("golden fixtures — the suite passes a well-behaved model", () => {
  it("scores 6 of 6 on canned answers that satisfy every property", async () => {
    const report = await runGoldenFixtures(scripted(GOOD), {
      newId: (() => {
        let next = 0;
        return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      })(),
    });
    expect(report.total).toBe(GOLDEN_FIXTURES.length);
    expect(
      report.outcomes.filter((outcome) => !outcome.passed).map((o) => [o.id, o.failures]),
    ).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.model).toBe("fake:scripted");
  });

  it("records provider-native usage, so a swap can be compared on cost too", async () => {
    const report = await runGoldenFixtures(scripted(GOOD));
    expect(report.outcomes.every((outcome) => outcome.usage?.unit === "tokens")).toBe(true);
  });
});

describe("golden fixtures — the suite can FAIL, which is what makes it worth running", () => {
  it("catches an update aimed at the wrong task", async () => {
    const report = await runGoldenFixtures(
      scripted({ ...GOOD, "50%": { summary: "", tasks: [{ op: "update", seq: 3, progressPercent: 50 }] } }),
    );
    const outcome = report.outcomes.find((o) => o.id === "01-progress-update");
    expect(outcome?.passed).toBe(false);
    expect(outcome?.failures.join(" ")).toContain("wrong task");
  });

  it("catches effort read as minutes instead of hours", async () => {
    const report = await runGoldenFixtures(
      scripted({
        ...GOOD,
        "1. 認証機能": {
          summary: "",
          tasks: [
            { op: "add", name: "認証機能" },
            { op: "add", name: "設計", parent: "認証機能", effortHours: 0.13 },
          ],
        },
      }),
    );
    const outcome = report.outcomes.find((o) => o.id === "02-estimate-3-tasks");
    expect(outcome?.passed).toBe(false);
  });

  it("catches a model that acts on a delete request instead of declining", async () => {
    const report = await runGoldenFixtures(
      scripted({
        ...GOOD,
        完了したタスクを全部消して: {
          summary: "消しました",
          tasks: [{ op: "update", seq: TASK_1, effortHours: 0 }],
        },
      }),
    );
    const outcome = report.outcomes.find((o) => o.id === "04-refuses-delete");
    expect(outcome?.passed).toBe(false);
  });

  it("catches an unknown master silently dropped", async () => {
    const report = await runGoldenFixtures(
      scripted({
        ...GOOD,
        // No `masters` add and no unresolved flag would mean the 工程 vanished.
        受入テストの実施: {
          summary: "",
          tasks: [{ op: "add", name: "受入テストの実施", effortHours: 16 }],
        },
      }),
    );
    const outcome = report.outcomes.find((o) => o.id === "05-unknown-master");
    expect(outcome?.passed).toBe(false);
    expect(outcome?.failures.join(" ")).toContain("unresolved");
  });

  // The injection fixtures are the ones a provider swap degrades most quietly, so
  // the checks behind them get the most explicit control.
  it("catches an off-schema answer, and counts it as a failure rather than an error", async () => {
    const report = await runGoldenFixtures(scripted({ ...GOOD, 新機能の実装: { tasks: "全部" } }));
    const outcome = report.outcomes.find((o) => o.id === "06-prompt-injection");
    expect(outcome?.passed).toBe(false);
    expect(outcome?.failures.join(" ")).toContain("IR schema");
  });

  it("counts a provider that throws as a failure, not a crashed suite", async () => {
    const exploding: ProposalModel = {
      id: "fake:exploding",
      contextTokenBudget: 24_000,
      isFreeTier: true,
      egress: "in-account",
      propose: () => Promise.reject(new Error("provider unavailable")),
    };
    const report = await runGoldenFixtures(exploding);
    expect(report.passed).toBe(0);
    expect(report.outcomes).toHaveLength(GOLDEN_FIXTURES.length);
  });
});

describe("golden fixtures — the injection cases must never be dropped", () => {
  it("keeps both injection fixtures in the suite", () => {
    const ids = GOLDEN_FIXTURES.map((fixture) => fixture.id);
    expect(ids).toContain("06-prompt-injection");
    expect(ids).toContain("07-injection-exfiltration");
  });

  it("runs both under the ingest vocabulary, where `update` does not exist", () => {
    for (const id of ["06-prompt-injection", "07-injection-exfiltration"]) {
      expect(GOLDEN_FIXTURES.find((fixture) => fixture.id === id)?.mode).toBe("ingest");
    }
  });

  it("uses only synthetic, generic data", () => {
    const text = GOLDEN_FIXTURES.map((fixture) => fixture.input).join("\n");
    expect(text).not.toMatch(/@|https?:\/\/(?!example\.invalid)/u);
  });
});
