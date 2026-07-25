import { useCallback } from "react";
import {
  useFetcher,
  type LinksFunction,
  type SubmitTarget,
} from "react-router";
import { type ProjectCommand } from "@vecta/application";
import type { Route } from "./+types/project.wbs";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { App as WbsApp, type SaveActionResult } from "~/wbs/wbs-app";
import { fromCommand } from "~/wbs/project-command-contract";
import wbsStyles from "~/wbs/styles.css?url";

// The ported grid's stylesheet is linked from the route (ADR 0012 Step 4a). The
// `?url` + `links` export puts a real <link> into the first-paint <head> via
// root's <Links/>, so the grid is styled server-side with no flash-of-unstyled.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: wbsStyles }];

// SSR loader for `/projects/:id/wbs`. The access gate (parent `/projects/:id`
// middleware) has already validated the id + membership; the shared
// `loadProjectView` helper reads the persisted workspace through the per-request
// DB session (ADR 0012 §4-pre) and returns the role-scoped STATE VIEW only. The
// grid is NOT sent over the wire: it is derived isomorphically from the view
// (server render + client hydrate) via `projectWbsGrid`, so the payload is halved
// and there is one source of truth. The helper is shared by every master route so
// no loader ever bypasses the `projectWorkspaceView` projection choke point (D18).
export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectView(context);
}

// ADR 0012 Step 4b — the WBS write path. The client posts the whole command batch
// as ONE JSON action request (with the confirmed revision + per-command
// idempotency keys); the shared `runCommandAction` core authorizes the session
// principal as the actor and executes the batch through the command service with
// optimistic concurrency, tagging success with the `wbs-save` kind.
//
// Conflicts and denials are RETURNED (not thrown) so the client's optimistic
// pipeline can react: a `VERSION_CONFLICT` triggers the resync/adopt path, an
// authz failure surfaces as a rollback. bigint revisions cross the boundary as
// strings. The action never logs the token or the command payloads.
export async function action(args: Route.ActionArgs) {
  return runCommandAction(args, "wbs-save");
}

// A successful per-cell save must NOT re-settle: keep the optimistic client state
// and skip the workspace + project-row re-read (ADR 0012 §4). A conflict falls
// through to the default so the loader revalidates and the client adopts the
// fresh state. Exported on the ancestors too so one save doesn't fan out.
export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function ProjectWbs({ loaderData }: Route.ComponentProps) {
  const { revision, stateView, projectionRole } = loaderData;
  const fetcher = useFetcher<typeof action>();

  // The dispatch seam: encode the domain command batch to the wire shape, mint a
  // client idempotency key per command (mirrors the SPA's per-command
  // `crypto.randomUUID()`), and submit ONE JSON action request. The revision
  // chain is walked server-side inside the action, not by a client round trip.
  const onExecute = useCallback(
    (commands: readonly ProjectCommand[], expectedRevision: string) => {
      const body = {
        expectedRevision,
        commands: commands.map((command) => ({
          command: fromCommand(command),
          idempotencyKey: crypto.randomUUID(),
        })),
      };
      // `fromCommand`'s optional fields are typed `T | undefined` under
      // `exactOptionalPropertyTypes`, which the JSON `SubmitTarget` type rejects
      // even though the value is JSON-serializable at runtime (undefined keys are
      // dropped). The action re-validates the parsed body via `CommandBatchSchema`.
      void fetcher.submit(body as unknown as SubmitTarget, {
        method: "post",
        encType: "application/json",
      });
    },
    [fetcher],
  );

  return (
    <WbsApp
      initialState={stateView}
      initialRevision={revision}
      projectionRole={projectionRole}
      onExecute={onExecute}
      saveInFlight={fetcher.state !== "idle"}
      saveResult={fetcher.data as SaveActionResult | undefined}
    />
  );
}
