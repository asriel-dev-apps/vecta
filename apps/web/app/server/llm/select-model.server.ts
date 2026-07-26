import type { ProposalModel } from "@vecta/application";
import { workersAiProposalModel } from "./workers-ai.server";

/**
 * Provider selection (Design 0005 §3.4, acceptance A14).
 *
 * Two failure modes are being avoided here, and they call for opposite
 * treatments:
 *
 *   - A variable that says `anthropic` when no such adapter is wired MUST fail
 *     loudly. Falling back to the default would leave someone convinced they had
 *     switched to Claude while Workers AI kept answering, and nothing about the
 *     app's behaviour would tell them otherwise.
 *   - A variable that is ABSENT is not that case. Nothing was intended, so the
 *     initial provider ADR 0013 Decision 12 names is the right answer. Requiring
 *     the variable would only add a deploy step whose omission breaks the feature
 *     for no safety gain.
 *
 * "At startup" is not literally available in Workers — bindings arrive per
 * request, not at module evaluation — so the loud failure lands on the first
 * request that would have used the model. That is the earliest honest point.
 */

export const DEFAULT_PROPOSAL_PROVIDER = "workers-ai";

export class UnknownProposalProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `ASSISTANT_MODEL_PROVIDER is "${provider}", which no adapter implements. Refusing to fall back to ${DEFAULT_PROPOSAL_PROVIDER}: a silent fallback means believing you switched providers when you did not.`,
    );
    this.name = "UnknownProposalProviderError";
    this.provider = provider;
  }
}

export interface ProposalModelBindings {
  readonly ASSISTANT_MODEL_PROVIDER?: string;
  readonly AI: Ai;
}

export function selectProposalModel(env: ProposalModelBindings): ProposalModel {
  const provider = env.ASSISTANT_MODEL_PROVIDER?.trim();
  if (provider === undefined || provider.length === 0 || provider === DEFAULT_PROPOSAL_PROVIDER) {
    // The whole binding set goes in; the adapter takes what it needs. This file
    // therefore names no binding, no model, and no vendor API.
    return workersAiProposalModel(env);
  }
  // Design 0005 §3.4's two doors are enforced at review time, not here: a paid
  // provider (`isFreeTier: false`) needs ADR 0012's cost constraint revised, and
  // an off-account one (`egress: "external"`) needs ADR 0013 revised — even if it
  // is free. Adding a branch to this switch is exactly the moment to check both.
  throw new UnknownProposalProviderError(provider);
}
