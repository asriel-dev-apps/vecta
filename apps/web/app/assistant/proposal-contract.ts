import type { ProposalDiff, UnresolvedReference } from "@vecta/application";
import type { z } from "zod";
import type { ApiCommandSchema } from "~/wbs/project-command-contract";

/**
 * The wire shape of an assistant proposal — ONE definition, imported by both the
 * server action that produces it and the overlay that renders it. Client-safe by
 * construction: nothing here reaches a driver, a binding, or a secret, so the
 * overlay never needs a type import from `~/server/**`.
 *
 * The commands are the WIRE form (`ApiCommandSchema`), because that is what the
 * browser posts back to the unchanged command action when the user approves. The
 * assistant adds no second write format.
 */

export type ProposalCommand = z.infer<typeof ApiCommandSchema>;

/** The IR vocabulary / trust boundary. A CSV runs as `ingest`: add-only. */
export type AssistantMode = "ingest" | "chat";

/**
 * What the user asked for. `csv` is a separate REQUEST mode but not a separate
 * trust boundary — a spreadsheet is a third party's document, so it expands under
 * the ingest vocabulary and cannot touch an existing row.
 */
export type AssistantRequestMode = AssistantMode | "csv";

export interface AssistantHistoryTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * What the browser posts to ask for a proposal. The server re-validates it with
 * zod (which stays the authority on shape and caps); this type exists so the
 * overlay and the action cannot drift on field names.
 *
 * `history` is client-held and sent per request — requirement 8: the conversation
 * never reaches the database, so there is no schema change and an estimate
 * document's contents are not persisted anywhere either.
 */
export interface AssistantProposalRequest {
  readonly mode: AssistantRequestMode;
  /** The utterance, the pasted document, or the whole CSV text. */
  readonly input: string;
  readonly history?: readonly AssistantHistoryTurn[];
}

/**
 * What the model actually decided about a CSV, shown to the human BEFORE they
 * approve (Design 0005 §4-5). For an import this is the control that matters more
 * than the diff: a 300-row diff is scrolled, not read, whereas "B 列 → 工数(時間)"
 * is one line a person can actually check — and a wrong mapping is wrong in all
 * 300 rows identically.
 */
export interface CsvImportSummary {
  readonly rowCount: number;
  readonly mapped: readonly {
    readonly columnIndex: number;
    readonly columnName: string;
    readonly field: string;
  }[];
  /** Header names no field claimed. Not an error — often just extra columns. */
  readonly unmappedColumns: readonly string[];
  /** Indices the model proposed that were out of range or already taken. */
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

export interface AssistantProposal {
  readonly mode: "ingest" | "chat";
  /**
   * The revision the proposal was generated against. The apply path refuses
   * unless this still equals the client's confirmed revision — a proposal reasoned
   * over a WBS that has since moved must not be applied to the one that exists now.
   */
  readonly expectedRevision: string;
  readonly commands: readonly ProposalCommand[];
  /** Derived from the commands and the current state — never from {@link summary}. */
  readonly diff: ProposalDiff;
  readonly unresolved: readonly UnresolvedReference[];
  /**
   * The model's own words. Rendered as PLAIN TEXT, visually separated from the
   * diff, with no link or image resolution: a markdown image would exfiltrate the
   * snapshot the moment it rendered, which is before anyone decides whether to
   * approve.
   */
  readonly summary: string;
  /**
   * Present for a CSV import. Its `summary` is written by TypeScript, not the
   * model — for a CSV the model's ONLY contribution is the column mapping, so
   * there is no model prose in the result at all.
   */
  readonly csv?: CsvImportSummary;
  readonly model: string;
  /**
   * `null` when the provider reported no usage. The panel says so rather than
   * showing zeros — a fabricated 0 reads as a measurement, and the whole point of
   * surfacing this figure is to replace the design's estimates with real numbers.
   */
  readonly usage: {
    readonly unit: string;
    readonly input?: number;
    readonly output?: number;
    readonly total?: number;
    /** True when these are our own approximation, not the provider's report. */
    readonly estimated?: boolean;
  } | null;
}

export type AssistantErrorCode =
  | "FORBIDDEN"
  | "INVALID"
  | "TOO_LARGE"
  | "PROJECT_TOO_LARGE"
  | "MODEL_SCHEMA_UNMET"
  | "MODEL_QUOTA_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_MISCONFIGURED"
  | "RATE_LIMITED";

/**
 * `kind` exists for the same reason the save results have one: `shouldRevalidate`
 * keys on the discriminant SET, never on a bare `{ ok: true }`, so one route's
 * success can never suppress another loader's re-read
 * (`app/routing/self-save-revalidation.ts`).
 */
export const ASSISTANT_PROPOSAL_KIND = "assistant-proposal";

export type AssistantActionResult =
  | {
      readonly ok: true;
      readonly kind: typeof ASSISTANT_PROPOSAL_KIND;
      readonly proposal: AssistantProposal;
    }
  | { readonly ok: false; readonly code: AssistantErrorCode; readonly message: string };
