import { data, type RouterContextProvider } from "react-router";
import {
  parseTimesheetCsv,
  TIMESHEET_HEADERS,
  type TimesheetIssue,
  type TimesheetSummary,
} from "@vecta/application";
import { applyCommands } from "./apply-commands.server";
import { requireProjectMembership, requireProjectWorkspace } from "./project-access.server";
import { requirePrincipal } from "../auth/require-principal.server";
import { dbSessionContext } from "../context.server";

/**
 * The timesheet import action (Design 0011 §6).
 *
 * ## Why this is not `runCommandAction`
 *
 * Every other write posts a command batch the client already built. This one
 * posts a FILE, and the file has to be parsed and validated before a command can
 * exist at all. Doing that on the client and posting resolved rows would put the
 * only copy of every rejection — unknown task number, unknown member, summary
 * row, duplicate line — behind something a client can decline to run.
 *
 * So the parse happens here, once, on the server, and what it produces is fed to
 * `applyCommands` — the SAME write path as every other command, so the revision
 * pin, the idempotency receipt, the authorization and the audit actor are the
 * ones the rest of the app gets. A new write path would be the thing to avoid;
 * a different request BODY is not one.
 *
 * ## Two intents, and why preview is not optional
 *
 * `preview` parses and reports; it touches nothing. `import` parses again and
 * applies. Publishing a baseline established the rule this follows (Design 0009):
 * show the person the count before the button does anything irreversible. Here
 * the count that matters is how many `(date, member)` partitions the file will
 * REPLACE — the rows about to be deleted are not in the file, so nothing else on
 * screen would reveal them.
 *
 * Preview re-parsing on import rather than trusting a preview token is
 * deliberate: the state can have moved between the two requests, and the
 * `expectedRevision` pin would reject the write anyway. Parsing twice is cheap
 * and leaves one path that can produce a command.
 */

export const TIMESHEET_SAVE_KIND = "timesheet-import" as const;

/**
 * Request-body ceiling, in characters. 2,000 rows of four columns is a few tens
 * of kilobytes; this leaves an order of magnitude of headroom and still refuses
 * a body that could exhaust the Worker before the row cap is ever consulted.
 */
export const MAX_CSV_CHARACTERS = 1_000_000;

export interface TimesheetPreviewResult {
  readonly ok: true;
  readonly kind: "timesheet-preview";
  readonly summary: TimesheetSummary;
}

export interface TimesheetImportResult {
  readonly ok: true;
  readonly kind: typeof TIMESHEET_SAVE_KIND;
  readonly revision: string;
  readonly summary: TimesheetSummary;
}

export interface TimesheetRejectedResult {
  readonly ok: false;
  readonly code: "INVALID";
  readonly issues: readonly TimesheetIssue[];
}

/** The header row a person can copy into their spreadsheet. */
export const TIMESHEET_TEMPLATE_HEADER = [
  TIMESHEET_HEADERS.taskNo,
  TIMESHEET_HEADERS.date,
  TIMESHEET_HEADERS.member,
  TIMESHEET_HEADERS.hours,
].join(",");

interface TimesheetRequestBody {
  readonly intent?: unknown;
  readonly csv?: unknown;
  readonly expectedRevision?: unknown;
  readonly idempotencyKey?: unknown;
}

function invalid(message: string, status: number) {
  return data(
    { ok: false as const, code: "INVALID" as const, issues: [{ line: 1, message }] },
    { status },
  );
}

export async function runTimesheetAction({
  request,
  context,
}: {
  readonly request: Request;
  readonly context: Readonly<RouterContextProvider>;
}) {
  const principal = await requirePrincipal(context);
  const membership = requireProjectMembership(context);
  const session = context.get(dbSessionContext);

  let body: TimesheetRequestBody;
  try {
    body = (await request.json()) as TimesheetRequestBody;
  } catch {
    return invalid("リクエストの本文が JSON ではありません", 400);
  }
  const intent = body.intent === "import" ? "import" : body.intent === "preview" ? "preview" : null;
  if (intent === null) return invalid("intent は preview か import です", 422);
  if (typeof body.csv !== "string" || body.csv.trim() === "") {
    return invalid("CSV が空です", 422);
  }
  // Bound the work BEFORE doing any of it. The 2,000-row cap only fires after the
  // reader has walked the whole text character by character, so it is no defence
  // against one enormous field — and this runs in a Worker with 128 MB
  // (found by review, 2026-08-06).
  if (body.csv.length > MAX_CSV_CHARACTERS) {
    return invalid(`CSV が大きすぎます（${MAX_CSV_CHARACTERS} 文字までです）`, 413);
  }
  // Both intents, not just the write. A preview parses the whole file against the
  // PRIVILEGED state; leaving it open to a VIEWER makes a read-only role able to
  // spend the Worker's budget on demand, and Design 0011 §6.1 scopes the feature
  // to OWNER/EDITOR in the first place.
  if (membership.projectRole !== "OWNER" && membership.projectRole !== "EDITOR") {
    return invalid("権限がありません", 403);
  }

  const workspace = await requireProjectWorkspace(context);
  // Parsed against `workspace.current`, the PRIVILEGED state, not the role-scoped
  // view: task numbers and member names must resolve the same way whoever is
  // importing. Nothing sensitive leaves — the response carries counts, dates and
  // the file's own text back in messages.
  const parsed = parseTimesheetCsv(body.csv, workspace.current);
  if (!parsed.ok) {
    // 422, and EVERY issue. Stopping at the first would make fix-and-retry as
    // long as the file (Design 0011 §5.2).
    return data({ ok: false as const, code: "INVALID" as const, issues: parsed.issues }, { status: 422 });
  }
  if (intent === "preview") {
    return data({ ok: true as const, kind: "timesheet-preview" as const, summary: parsed.summary });
  }

  if (typeof body.expectedRevision !== "string" || !/^\d+$/u.test(body.expectedRevision)) {
    return invalid("expectedRevision がありません", 422);
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
    return invalid("idempotencyKey がありません", 422);
  }

  const result = await applyCommands({
    session,
    actor: {
      principalId: principal.principal.id,
      principalType: principal.principal.type,
    },
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    projectRole: membership.projectRole,
    commands: [
      {
        command: { type: "actuals.import", entries: parsed.entries },
        idempotencyKey: body.idempotencyKey,
      },
    ],
    expectedRevision: BigInt(body.expectedRevision),
  });

  if (result.ok) {
    return data({
      ok: true as const,
      kind: TIMESHEET_SAVE_KIND,
      revision: result.revision.toString(),
      summary: parsed.summary,
    });
  }
  if (result.code === "VERSION_CONFLICT") {
    return data(
      {
        ok: false as const,
        code: "INVALID" as const,
        issues: [
          {
            line: 1,
            message:
              "この画面を開いてから計画が変更されました。再読み込みしてから取り込んでください。",
          },
        ],
      },
      { status: 409 },
    );
  }
  if (result.code === "FORBIDDEN") {
    return data(
      { ok: false as const, code: "INVALID" as const, issues: [{ line: 1, message: "権限がありません" }] },
      { status: 403 },
    );
  }
  if (result.code === "NOT_FOUND") {
    return data(
      { ok: false as const, code: "INVALID" as const, issues: [{ line: 1, message: "プロジェクトが見つかりません" }] },
      { status: 404 },
    );
  }
  return data(
    { ok: false as const, code: "INVALID" as const, issues: [{ line: 1, message: result.message }] },
    { status: 422 },
  );
}
