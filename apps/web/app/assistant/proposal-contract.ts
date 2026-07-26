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

export type AssistantMode = "ingest" | "chat";

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
  readonly mode: AssistantMode;
  readonly input: string;
  readonly history?: readonly AssistantHistoryTurn[];
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
  readonly model: string;
  readonly usage: { readonly unit: string; readonly input: number; readonly output: number };
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
