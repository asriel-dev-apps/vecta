/**
 * The inference port (Design 0005 §3.4, ADR 0013 Decision 12). Requirement 9 says
 * the provider must be swappable — Claude, or whatever comes next — so everything
 * a provider does differently lives behind this one interface and nothing else in
 * the codebase names a provider.
 *
 * The contract this places on a model is deliberately tiny: "return JSON matching
 * the schema you were given". Not a single vendor concept appears in it, which is
 * what makes the port real rather than aspirational.
 *
 * Three invariants keep a swap from loosening safety, and they are structural,
 * not conventions to remember:
 *
 *   1. An adapter does NOT validate. It returns `raw` untouched; the IR schema,
 *      the expander and the allowlist all sit outside it. A new adapter therefore
 *      has no way to validate leniently — it never validates at all.
 *   2. An adapter does NOT build the prompt. It receives a finished
 *      {@link ProposalPrompt}, so it cannot re-read project data and reintroduce
 *      the role-projection hole that Design 0005 §6 closes.
 *   3. An adapter has NO write path. The apply step is the existing
 *      `runCommandAction`, unreachable from here. A provider is handed zero
 *      authority over the database.
 */

export interface ProposalPrompt {
  readonly system: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** The IR's JSON Schema; the adapter translates it into its provider's structured-output feature. */
  readonly schema: unknown;
  /** Ceiling for generated tokens, derived from the mode's output budget (Design 0005 §6). */
  readonly maxOutputTokens: number;
}

/**
 * Provider-native usage, in whatever unit the provider actually reports.
 *
 * Every field is optional and the whole thing is nullable, because **a provider
 * that reports nothing must be distinguishable from one that reports zero.**
 * Defaulting an absent count to 0 was a real defect: the panel displayed
 * "入力 0 / 出力 0 tokens", which reads as a measurement and is a fabrication —
 * the same mistake as calling tokens "neurons", made one layer down.
 */
export interface ProposalUsage {
  readonly unit: string;
  readonly input?: number;
  readonly output?: number;
  /** Some providers report only the combined figure. */
  readonly total?: number;
}

export interface ProposalOutput {
  /** UNVALIDATED model output. Validation is the core's job, never the adapter's. */
  readonly raw: unknown;
  /** `null` when the provider reported no usage at all — say so, never show a 0. */
  readonly usage: ProposalUsage | null;
}

/**
 * Two independent doors, because cost and confidentiality are different axes
 * (Design 0005 §3.4). Guarding the swap with the billing word alone would let a
 * FREE external provider carry the workspace off-account with no review — the
 * prompt carries the whole role-projected WBS, which derives from confidential
 * data.
 */
export type ProposalEgress = "in-account" | "external";

export interface ProposalModel {
  /** Identifier for logs and usage records, shaped `<provider>:<model-id>`. The
   * shared core names no vendor and no model — not even in a comment, so that
   * "one adapter knows the provider" survives a grep rather than an assurance. */
  readonly id: string;
  /** Input budget for this model. Design 0005 §6 derives its allocation from this — never a literal 24,000. */
  readonly contextTokenBudget: number;
  /** `false` means the provider is billed; enabling one requires revising ADR 0012's cost constraint. */
  readonly isFreeTier: boolean;
  /** `external` means prompts leave this Cloudflare account; enabling one requires revising ADR 0013. */
  readonly egress: ProposalEgress;
  propose(input: ProposalPrompt): Promise<ProposalOutput>;
}

/** Errors a caller must distinguish; the UI reacts differently to each (A9, A10). */
export type ProposalFailureCode =
  /** The provider answered, but not with schema-conforming JSON. Documented as possible, so: normal. */
  | "SCHEMA_UNMET"
  /** The account's daily free allowance is gone — shared across the whole account. */
  | "QUOTA_EXHAUSTED"
  /** Provider unreachable, timed out, or returned an unusable status. */
  | "PROVIDER_UNAVAILABLE";

export class ProposalModelError extends Error {
  readonly code: ProposalFailureCode;

  constructor(code: ProposalFailureCode, message: string) {
    super(message);
    this.name = "ProposalModelError";
    this.code = code;
  }
}
