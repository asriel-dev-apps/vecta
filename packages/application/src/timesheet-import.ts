import { CsvParseError, parseCsv } from "./csv.js";
import { datedActualKey } from "./dated-actuals.js";
import { leafTaskIds, type ProjectState } from "./project-state.js";

/**
 * Timesheet import — dated actuals (Design 0011).
 *
 * ## What this module is for
 *
 * `tasks.actual_effort_minutes` (column W) is ONE current number per task, so AC
 * has no time axis: measured 2026-08-05, moving the as-of date across three
 * dates left AC at 0.625 and CPI a constant 0.8. This module turns a timesheet
 * CSV into dated rows so AC(t) can exist at all, which is what the EVM trend
 * chart needs before it can draw anything but a PV curve and two flat lines.
 *
 * ## The three things the user decided (2026-08-06), and why they were asked
 *
 * File format, matching key and row granularity all depend on a spreadsheet no
 * agent may read, and **the matching key cannot be corrected afterwards**: get it
 * wrong and effort lands on the wrong task with nothing in the data to reveal it.
 * So they were asked rather than inferred. The answers:
 *
 *   * CSV, UTF-8, with a header row;
 *   * matched by **task No (`tasks.seq`) + member name**;
 *   * one row = **one task × one date × one person × effort**.
 *
 * `seq` is the immutable per-project display number introduced by Design 0003
 * §F-1 precisely so an external document could name a task and keep naming the
 * same one after reorders and deletes. This is its first use.
 *
 * ## Why every rejection is total
 *
 * Design 0008 requires that bad input is not silently skipped. Between "abandon
 * the file" and "report and continue" this takes ABANDON: the command's unit of
 * work is a transaction already, so a half-applied import is a state nobody
 * asked for, and re-importing a corrected file is the natural repair. Every
 * issue is reported with its line number — stopping at the first would make the
 * fix-and-retry loop as long as the file.
 */

/** The four required headers. Matched by name, so column ORDER does not matter. */
export const TIMESHEET_HEADERS = {
  taskNo: "タスクNo",
  date: "日付",
  member: "メンバー",
  hours: "工数(時間)",
} as const;

/**
 * Data-row ceiling. 12 members × 20 working days × 5 tasks ≈ 1,200 rows, so a
 * month of a whole project fits with room to spare. The cap exists because the
 * whole import travels as one command payload and is written verbatim into
 * `audit_event`, and an unbounded audit row is a different problem.
 */
export const TIMESHEET_MAX_ROWS = 2_000;

/**
 * Column ceiling. Deliberately far above the reader's default of 60 — the
 * promise is that unknown columns are ignored, so the limit exists only to stop
 * a pathological file, not to police a payroll export's width.
 */
export const TIMESHEET_MAX_COLUMNS = 256;

/** The reader's structural failures, said in the language the rest of the screen speaks. */
function describeCsvFailure(error: unknown): string {
  if (!(error instanceof CsvParseError)) return "CSV を読み取れません";
  if (error.message.includes("more than")) {
    return `CSV が大きすぎます（データ行は ${TIMESHEET_MAX_ROWS} 行、列は ${TIMESHEET_MAX_COLUMNS} 列までです）`;
  }
  if (error.message.includes("quoted field")) {
    return "引用符が閉じていません";
  }
  if (error.message.includes("empty")) {
    return "CSV が空です";
  }
  return "CSV を読み取れません";
}

/** One imported line, resolved to internal ids. */
export interface TimesheetEntry {
  readonly taskId: string;
  /** ISO `YYYY-MM-DD`. */
  readonly workDate: string;
  readonly memberId: string;
  /** Person-minutes. */
  readonly actualMinutes: number;
}

/** A rejection, carrying the 1-based line of the file it came from. */
export interface TimesheetIssue {
  /** 1-based line number as a person reading the file in an editor would count. */
  readonly line: number;
  readonly message: string;
}

export interface TimesheetSummary {
  readonly rowCount: number;
  /** Earliest / latest `work_date` in the file. */
  readonly firstDate: string;
  readonly lastDate: string;
  readonly memberCount: number;
  readonly taskCount: number;
  /**
   * How many `(date, member)` partitions the import will REPLACE. This is the
   * blast radius: everything already recorded inside these partitions is
   * removed, and nothing outside them is touched (Design 0011 §5.1).
   */
  readonly partitionCount: number;
}

export type TimesheetParseResult =
  | { readonly ok: true; readonly entries: readonly TimesheetEntry[]; readonly summary: TimesheetSummary }
  | { readonly ok: false; readonly issues: readonly TimesheetIssue[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** One row cannot claim more than a day. A larger figure is a decimal-point slip. */
export const MAX_HOURS_PER_ROW = 24;

function isDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

/**
 * A plain decimal, or `NaN`.
 *
 * Written out rather than as a regular expression on purpose. `Number()` alone
 * accepts `"0x10"` as 16 and `"1e3"` as 1000 — this module inventing an
 * interpretation of a timesheet's text, which §5.4 forbids. The obvious pattern
 * for "digits, optionally a point and more digits" is flagged by
 * `security/detect-unsafe-regex`, and arguing with that rule is worse than not
 * needing it: the check below says exactly what it accepts, in the order a
 * reader would check it by hand.
 *
 * The lengths are bounded because the quantity is: more than three integer
 * digits is not a number of hours in a day, and four decimals is already a tenth
 * of a second.
 */
function parseDecimalHours(raw: string): number {
  const parts = raw.split(".");
  if (parts.length > 2) return Number.NaN;
  const [whole, fraction] = parts;
  if (whole === undefined || whole.length > 3 || !isDigits(whole)) return Number.NaN;
  if (fraction !== undefined && (fraction.length > 4 || !isDigits(fraction))) return Number.NaN;
  return Number(raw);
}

/**
 * A real calendar date, not just a well-shaped string. `2026-02-30` matches the
 * pattern and is not a day; `Date.UTC` normalises it to March 2nd, so the
 * round-trip is what rejects it.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const stamp = Date.UTC(year, month - 1, day);
  const back = new Date(stamp);
  return (
    back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
  );
}

/**
 * `(date, member)` — the replacement partition, and the duplicate-detection
 * prefix. Built from {@link datedActualKey} rather than from a separator of its
 * own: the write path keys its stored map the same way, and two hand-written
 * encodings agree only by transcription.
 *
 * An earlier version used a raw NUL byte here. It worked, and it made git treat
 * this file as BINARY — so the one file in this feature that decides which rows
 * are accepted was invisible to every diff-based review (found by review,
 * 2026-08-06). A separator that cannot be seen is a separator that gets "tidied".
 */
function entryKey(entry: TimesheetEntry): string {
  return `${datedActualKey(entry.workDate, entry.memberId)}|${entry.taskId}`;
}

/**
 * Member name → id, and the names that are ambiguous because two members share
 * one. Nothing forbids duplicate member names today, and adding a unique
 * constraint would reject existing data; so the import refuses the ambiguous
 * ROW instead of narrowing the whole model. Names are compared byte for byte
 * after trimming — no NFKC, no case folding. Any normalisation would be this
 * module speaking for a timesheet system it has never seen.
 */
function indexMembers(project: ProjectState): {
  readonly idByName: ReadonlyMap<string, string>;
  readonly ambiguous: ReadonlySet<string>;
} {
  const idByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const member of project.members) {
    const name = member.name.trim();
    if (idByName.has(name)) ambiguous.add(name);
    else idByName.set(name, member.id);
  }
  return { idByName, ambiguous };
}

/**
 * Parse and validate a timesheet CSV against a project.
 *
 * Deterministic: the same text and the same project always produce the same
 * entries in the same order, and the same issues in the same order. Nothing here
 * reads a clock, a locale or the environment.
 */
export function parseTimesheetCsv(text: string, project: ProjectState): TimesheetParseResult {
  let table;
  try {
    // `maxColumns` is raised well above the reader's default of 60: §5.4 promises
    // that extra columns are ignored, and a timesheet export with 61 of them
    // would otherwise be refused outright — the opposite of what the screen says.
    table = parseCsv(text, { maxRows: TIMESHEET_MAX_ROWS, maxColumns: TIMESHEET_MAX_COLUMNS });
  } catch (error) {
    // The reader's messages are English and structural ("CSV has more than 2000
    // data rows"). Every other message this module produces is Japanese and
    // names a line, so they are translated rather than passed through.
    return {
      ok: false,
      issues: [{ line: 1, message: describeCsvFailure(error) }],
    };
  }

  const column = {
    taskNo: table.header.indexOf(TIMESHEET_HEADERS.taskNo),
    date: table.header.indexOf(TIMESHEET_HEADERS.date),
    member: table.header.indexOf(TIMESHEET_HEADERS.member),
    hours: table.header.indexOf(TIMESHEET_HEADERS.hours),
  };
  const missing = Object.entries(TIMESHEET_HEADERS)
    .filter(([key]) => column[key as keyof typeof column] < 0)
    .map(([, header]) => header);
  if (missing.length > 0) {
    // One issue, not four: the file has the wrong shape, and listing the columns
    // it does have would be noise next to the columns it must have.
    return {
      ok: false,
      issues: [{ line: 1, message: `必須の列がありません: ${missing.join(" / ")}` }],
    };
  }
  if (table.rows.length === 0) {
    return { ok: false, issues: [{ line: 1, message: "データ行がありません" }] };
  }

  const leaves = leafTaskIds(project.tasks);
  const taskBySeq = new Map(project.tasks.map((task) => [task.seq, task]));
  const { idByName, ambiguous } = indexMembers(project);

  const issues: TimesheetIssue[] = [];
  const entries: TimesheetEntry[] = [];
  const seen = new Set<string>();

  table.rows.forEach((row, index) => {
    // Header is line 1, so the first data row is line 2 — what an editor shows.
    const line = index + 2;
    const rawTaskNo = (row[column.taskNo] ?? "").trim();
    const rawDate = (row[column.date] ?? "").trim();
    const rawMember = (row[column.member] ?? "").trim();
    const rawHours = (row[column.hours] ?? "").trim();

    const seq = /^\d+$/u.test(rawTaskNo) ? Number(rawTaskNo) : Number.NaN;
    const task = Number.isNaN(seq) ? undefined : taskBySeq.get(seq);
    if (task === undefined) {
      issues.push({
        line,
        message: `タスクNo「${rawTaskNo}」はこのプロジェクトにありません`,
      });
    } else if (!leaves.has(task.id)) {
      // A summary row's effort is carried by its children; recording actuals on
      // it would double-count in every rollup (ADR 0011 Decision 5).
      issues.push({
        line,
        message: `タスクNo ${seq}「${task.name}」はサマリ行です。実績は末端タスクにだけ付けられます`,
      });
    }

    if (!isCalendarDate(rawDate)) {
      issues.push({ line, message: `日付「${rawDate}」は YYYY-MM-DD ではありません` });
    }

    let memberId: string | undefined;
    if (ambiguous.has(rawMember)) {
      issues.push({
        line,
        message: `メンバー「${rawMember}」は同名が複数います。どちらか判別できません`,
      });
    } else {
      memberId = idByName.get(rawMember);
      if (memberId === undefined) {
        issues.push({
          line,
          message: `メンバー「${rawMember}」はこのプロジェクトにいません`,
        });
      }
    }

    // A plain decimal only (see `parseDecimalHours`), and no more than a day: a
    // row claiming more hours than a day has is a misplaced decimal point, and
    // letting it through puts a wrong AC on a chart nobody re-derives by hand.
    const hours = parseDecimalHours(rawHours);
    const hoursValid = Number.isFinite(hours) && hours >= 0 && hours <= MAX_HOURS_PER_ROW;
    if (!hoursValid) {
      issues.push({
        line,
        message: `工数「${rawHours}」は 0〜${MAX_HOURS_PER_ROW} の数値ではありません`,
      });
    }

    if (task === undefined || memberId === undefined || !hoursValid) {
      return;
    }
    const entry: TimesheetEntry = {
      taskId: task.id,
      workDate: rawDate,
      memberId,
      // Hours → minutes is an INPUT conversion, not an EVM computation, so
      // rounding here does not touch ADR 0011 Decision 1's "no rounding" rule.
      actualMinutes: Math.round(hours * 60),
    };
    const key = entryKey(entry);
    if (seen.has(key)) {
      // Summing duplicates would let a broken export through silently, and a
      // timesheet that reports the same person-day-task twice is broken.
      issues.push({ line, message: "同じ 日付 × メンバー × タスクNo の行が重複しています" });
      return;
    }
    seen.add(key);
    entries.push(entry);
  });

  if (issues.length > 0) return { ok: false, issues };

  const dates = entries.map((entry) => entry.workDate).sort();
  const partitions = new Set(entries.map((entry) => datedActualKey(entry.workDate, entry.memberId)));
  return {
    ok: true,
    entries,
    summary: {
      rowCount: entries.length,
      firstDate: dates[0]!,
      lastDate: dates[dates.length - 1]!,
      memberCount: new Set(entries.map((entry) => entry.memberId)).size,
      taskCount: new Set(entries.map((entry) => entry.taskId)).size,
      partitionCount: partitions.size,
    },
  };
}

/**
 * The `(date, member)` partitions an import replaces, as a sorted list of pairs.
 *
 * Exported because the write path needs exactly this set — it deletes each
 * partition before inserting — and deriving it twice from the same entries is
 * how the delete and the insert drift apart.
 */
export function timesheetPartitions(
  entries: readonly TimesheetEntry[],
): readonly { readonly workDate: string; readonly memberId: string }[] {
  const seen = new Map<string, { workDate: string; memberId: string }>();
  for (const entry of entries) {
    seen.set(datedActualKey(entry.workDate, entry.memberId), {
      workDate: entry.workDate,
      memberId: entry.memberId,
    });
  }
  return [...seen.values()].sort(
    (left, right) =>
      left.workDate.localeCompare(right.workDate) || left.memberId.localeCompare(right.memberId),
  );
}
