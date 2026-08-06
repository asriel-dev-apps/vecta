import { useId, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import type { ProjectState } from "@vecta/application";

/**
 * The timesheet import screen (Design 0011 §6.2).
 *
 * Two steps, in this order and not the other: choose a file, read what it will
 * do, then import. The gate is not ceremony — the import REPLACES whole
 * `(date, member)` partitions, so it can delete rows the file does not mention,
 * and the count of partitions is the only place that blast radius is visible. The
 * baseline publish button established the same rule (Design 0009): the number
 * goes in front of the person before the button does anything.
 *
 * Parsing is entirely server-side. The file is read here only to get its text.
 */

export interface TimesheetIssueView {
  readonly line: number;
  readonly message: string;
}

export interface TimesheetSummaryView {
  readonly rowCount: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly memberCount: number;
  readonly taskCount: number;
  readonly partitionCount: number;
}

type ActionData =
  | { readonly ok: true; readonly kind: "timesheet-preview"; readonly summary: TimesheetSummaryView }
  | {
      readonly ok: true;
      readonly kind: "timesheet-import";
      readonly revision: string;
      readonly summary: TimesheetSummaryView;
    }
  | { readonly ok: false; readonly code: "INVALID"; readonly issues: readonly TimesheetIssueView[] };

export interface TimesheetImportProps {
  readonly project: ProjectState;
  readonly revision: string;
  /** Header line for the template, built from the importer's own constants. */
  readonly templateHeader: string;
  /** Leaf tasks that already carry imported dated actuals, and the total count. */
  readonly datedLeafCount: number;
  readonly leafCount: number;
  readonly editable: boolean;
}

export function TimesheetImport({
  project,
  revision,
  templateHeader,
  datedLeafCount,
  leafCount,
  editable,
}: TimesheetImportProps): ReactNode {
  const fetcher = useFetcher<ActionData>();
  const fileInputId = useId();
  // The file's TEXT, held so "import" can post the same bytes the preview
  // approved without asking the person to pick the file twice.
  const [csv, setCsv] = useState<string | null>(null);
  // WHICH text the preview on screen describes. Without it, choosing a second
  // file left the first file's preview in `fetcher.data`, so the import button
  // stayed open and applied a file whose blast radius nobody had seen (found by
  // review, 2026-08-06). The gate is only a gate if it names what it approved.
  const [previewedCsv, setPreviewedCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const attempt = useRef(0);

  const result = fetcher.data;
  const previewed =
    result !== undefined && result.ok && result.kind === "timesheet-preview" && previewedCsv === csv
      ? result.summary
      : null;
  const imported =
    result !== undefined && result.ok && result.kind === "timesheet-import" ? result : null;
  const issues = result !== undefined && !result.ok ? result.issues : [];
  const busy = fetcher.state !== "idle";

  const post = (intent: "preview" | "import"): void => {
    if (csv === null) return;
    if (intent === "preview") setPreviewedCsv(csv);
    attempt.current += 1;
    void fetcher.submit(
      {
        intent,
        csv,
        expectedRevision: revision,
        // Client-minted per attempt. A UUID rather than `${revision}-${n}`,
        // which two tabs at the same revision would both produce for DIFFERENT
        // files — the receipt would then reject the second on a hash mismatch
        // with an internal error (found by review, 2026-08-06). Every other write
        // path in the app already mints a UUID here.
        idempotencyKey: crypto.randomUUID(),
      },
      { method: "post", encType: "application/json" },
    );
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="app-subtitle">
          {project.name ? `${project.name} · ` : ""}勤怠取込
        </p>
      </header>

      <div className="timesheet" data-testid="timesheet-screen">
        <section className="timesheet__panel">
          <h2 className="timesheet__title">CSV の形式</h2>
          <p className="timesheet__note">
            1 行が「タスク × 日付 × 人 × 工数」です。列はヘッダ名で読むので、順番は問いません。
            余分な列は無視します。工数は<b>人時</b>（小数可）です。
          </p>
          <pre className="timesheet__template" data-testid="timesheet-template">
            {templateHeader}
          </pre>
          <p className="timesheet__note">
            <b>取り込むと、ファイルに現れた「その人のその日」がまるごと置き換わります。</b>
            そこにあってファイルに無い行は消えます。ファイルに無い人・無い日には触れません。
          </p>
        </section>

        <section className="timesheet__panel">
          <h2 className="timesheet__title">実績の状態</h2>
          <p className="timesheet__note" data-testid="timesheet-coverage">
            日付つき実績を持つ末端タスク: <b>{datedLeafCount}</b> / {leafCount} 件。
            {datedLeafCount === leafCount
              ? " すべての実績に日付があります。"
              : " 残りは日付なしの手入力なので、基準日を動かしても AC は動きません。"}
          </p>
        </section>

        <section className="timesheet__panel">
          <h2 className="timesheet__title">ファイル</h2>
          <input
            id={fileInputId}
            className="timesheet__file"
            type="file"
            accept=".csv,text/csv"
            data-testid="timesheet-file"
            disabled={!editable || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setCsv(null);
              // Drop the approval with the file it approved. Clearing `csv` alone
              // is not enough: `fetcher.data` outlives it.
              setPreviewedCsv(null);
              setFileName(null);
              setReadError(null);
              if (file === undefined) return;
              // `File.text()` decodes as UTF-8, which is the format the user
              // settled on. A Shift_JIS file arrives as replacement characters
              // and fails on the member name rather than silently importing
              // mojibake — a rejection with a line number, not a wrong row.
              void file
                .text()
                .then((text) => {
                  setCsv(text);
                  setFileName(file.name);
                })
                .catch(() => setReadError("ファイルを読み取れませんでした"));
            }}
          />
          {fileName === null ? null : (
            <p className="timesheet__note" data-testid="timesheet-file-name">
              {fileName}
            </p>
          )}
          {readError === null ? null : (
            <p className="timesheet__error" role="alert">
              {readError}
            </p>
          )}
          <div className="timesheet__actions">
            <button
              type="button"
              className="timesheet__button"
              data-testid="timesheet-preview"
              disabled={csv === null || !editable || busy}
              onClick={() => post("preview")}
            >
              内容を確認
            </button>
            <button
              type="button"
              className="timesheet__button timesheet__button--primary"
              data-testid="timesheet-import"
              // Only after a preview of THIS file has come back clean. The button
              // is what deletes rows, so it stays shut until the count that says
              // how many has been on screen.
              disabled={previewed === null || !editable || busy}
              onClick={() => post("import")}
            >
              取り込む
            </button>
          </div>
        </section>

        {previewed === null ? null : (
          <section className="timesheet__panel" data-testid="timesheet-summary">
            <h2 className="timesheet__title">確認</h2>
            <dl className="timesheet__summary">
              <div>
                <dt>行数</dt>
                <dd data-testid="timesheet-row-count">{previewed.rowCount}</dd>
              </div>
              <div>
                <dt>期間</dt>
                <dd>
                  {previewed.firstDate} 〜 {previewed.lastDate}
                </dd>
              </div>
              <div>
                <dt>メンバー</dt>
                <dd>{previewed.memberCount}</dd>
              </div>
              <div>
                <dt>タスク</dt>
                <dd>{previewed.taskCount}</dd>
              </div>
              <div>
                <dt>置き換わる「人 × 日」</dt>
                <dd data-testid="timesheet-partition-count">{previewed.partitionCount}</dd>
              </div>
            </dl>
          </section>
        )}

        {imported === null ? null : (
          <p className="timesheet__done" role="status" data-testid="timesheet-done">
            {imported.summary.rowCount} 行を取り込みました（{imported.summary.firstDate} 〜{" "}
            {imported.summary.lastDate}）。
          </p>
        )}

        {issues.length === 0 ? null : (
          <section className="timesheet__panel timesheet__panel--error" data-testid="timesheet-issues">
            <h2 className="timesheet__title">取り込めませんでした（1 行も書き込んでいません）</h2>
            <ul className="timesheet__issues">
              {issues.map((issue, index) => (
                <li key={`${issue.line}-${index}`}>
                  <b>{issue.line} 行目</b>: {issue.message}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
