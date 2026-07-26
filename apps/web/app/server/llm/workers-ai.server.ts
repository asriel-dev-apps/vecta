import { ProposalModelError, type ProposalModel, type ProposalOutput, type ProposalPrompt } from "@vecta/application";

/**
 * The Workers AI adapter — the ONLY file in the codebase that names a model or
 * touches an inference binding (Design 0005 §3.4, ADR 0013 Decision 12). A
 * provider swap rewrites this file and nothing else, which `verify-assistant-
 * boundary.mjs` checks rather than trusts.
 *
 * What this file deliberately does NOT do:
 *   - validate. `raw` goes back untouched; the IR schema, the expander and the
 *     allowlist all live in `@vecta/application`, so a future adapter has no way
 *     to validate leniently — it never validates at all.
 *   - build a prompt. It receives a finished one, so it cannot re-read project
 *     rows and reintroduce the role-projection hole Design 0005 §6 closes.
 *   - write. There is no path from here to the command core.
 */

/**
 * Design 0005 §3.3. Chosen from the nine JSON-Mode-capable models as the most
 * capable: 24,000-token context, function calling. Its output price is 7.7× its
 * input, which would be disqualifying — except the IR design (ADR 0013 Decision 2)
 * makes the output small, and its INPUT price is within 4% of the 8B model's. So
 * on an input-heavy workload the 70B costs about the same as the 8B.
 */
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Documented context window for {@link MODEL_ID}. The core derives its budget from this. */
const CONTEXT_TOKEN_BUDGET = 24_000;

/**
 * Which failures mean "the day's free neurons are gone" rather than "the service
 * is having a bad minute". The distinction matters because the UI should tell a
 * user to come back tomorrow in one case and to retry in the other.
 *
 * UNVERIFIED: these substrings are inferred from Cloudflare's documented
 * behaviour ("further operations will fail with an error") and the usual
 * HTTP shapes, NOT from an observed exhaustion — the account has not hit the cap.
 * Acceptance A10 is what settles it; until then a genuine exhaustion may well
 * surface as PROVIDER_UNAVAILABLE, which is a wrong message, not a wrong action.
 */
const QUOTA_MARKERS = ["429", "too many requests", "quota", "exceeded", "capacity", "limit"];

function classify(error: unknown): ProposalModelError {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (QUOTA_MARKERS.some((marker) => lowered.includes(marker))) {
    return new ProposalModelError("QUOTA_EXHAUSTED", message);
  }
  return new ProposalModelError("PROVIDER_UNAVAILABLE", message);
}

/**
 * Workers AI answers JSON Mode with either a parsed object or a JSON string,
 * depending on the model. Both are accepted; anything else is a schema miss,
 * which the documentation says to expect ("Workers AI can't guarantee that the
 * model responds according to the requested JSON Schema").
 */
function toRaw(response: unknown): unknown {
  if (typeof response === "string") {
    try {
      return JSON.parse(response);
    } catch {
      throw new ProposalModelError("SCHEMA_UNMET", "Model did not return JSON");
    }
  }
  if (response === null || typeof response !== "object") {
    throw new ProposalModelError("SCHEMA_UNMET", "Model returned no JSON object");
  }
  return response;
}

/**
 * The binding's text-generation result. `usage` is OPTIONAL in the generated
 * runtime types (`worker-configuration.d.ts`, `…Fp8_Fast_Output`), and it is
 * genuinely absent on some call shapes — this feature saw exactly that, so the
 * adapter must be able to say "not reported" rather than invent a zero.
 */
interface WorkersAiTextResult {
  readonly response?: unknown;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

function readUsage(usage: WorkersAiTextResult["usage"]): ProposalOutput["usage"] {
  if (usage === undefined || usage === null) return null;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const total = usage.total_tokens;
  // An object with none of the three counts is as uninformative as no object.
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    // TOKENS, which is what the binding reports. Neurons are Cloudflare's billing
    // conversion of these and live only on the dashboard, so acceptance A8 measures
    // them there — reporting these as neurons would be a fabricated number.
    unit: "tokens",
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
  };
}

/**
 * Takes the whole binding set, not a pre-extracted `AI`. Which binding a provider
 * needs is the provider's business, so the selector never has to name one —
 * which is how "a swap touches one file" stays literally true rather than nearly
 * true.
 */
export function workersAiProposalModel(env: { readonly AI: Ai }): ProposalModel {
  const ai = env.AI;
  return {
    id: `workers-ai:${MODEL_ID}`,
    contextTokenBudget: CONTEXT_TOKEN_BUDGET,
    isFreeTier: true,
    // The prompt stays inside this Cloudflare account. Design 0005 §3.4's second
    // door: moving to `external` needs an ADR revision even if the provider is
    // free, because the prompt carries the whole role-projected WBS.
    egress: "in-account",

    async propose(prompt: ProposalPrompt): Promise<ProposalOutput> {
      let result: WorkersAiTextResult;
      try {
        result = (await ai.run(MODEL_ID as Parameters<Ai["run"]>[0], {
          messages: [
            { role: "system", content: prompt.system },
            ...prompt.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          max_tokens: prompt.maxOutputTokens,
          // JSON Mode. Cloudflare documents that this is best-effort and that a
          // miss returns an error the caller "must handle" — the core treats a
          // miss as a normal outcome and emits no proposal.
          response_format: { type: "json_schema", json_schema: prompt.schema },
        } as never)) as WorkersAiTextResult;
      } catch (error) {
        throw error instanceof ProposalModelError ? error : classify(error);
      }

      return { raw: toRaw(result.response), usage: readUsage(result.usage) };
    },
  };
}
