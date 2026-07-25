import type { Route } from "./+types/project.assistant";
import { runAssistantAction } from "~/server/project/assistant-action.server";

/**
 * `/projects/:id/assistant` — the proposal endpoint (ADR 0013 Decision 1). An
 * action-only resource route: the assistant's UI is an overlay over whichever
 * screen the user is already on, so there is nothing here to render.
 *
 * It sits under the `/projects/:id` layout, so the fail-closed access gate has
 * already run before this action is reached; the action then narrows further to
 * EDITOR or better.
 *
 * There is no `loader` on purpose. A GET would be a proposal request that a
 * prefetch or a link could fire, and a request that spends the account's shared
 * free neurons has to be something the user deliberately did.
 */
export async function action(args: Route.ActionArgs) {
  return runAssistantAction(args);
}
