import type { LinksFunction } from "react-router";
import type { Route } from "./+types/project.dashboard";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { runCommandAction } from "~/server/project/command-action.server";
import { EvmDashboard } from "~/dashboard/evm-dashboard";
import { todayInProjectTimeZone } from "~/dashboard/as-of-date";
import { unplottedLeafTasks } from "@vecta/application";
import { projectTitle } from "~/shell/document-title";
import dashboardStyles from "~/dashboard/evm-dashboard.css?url";

// The screen's own sheet, linked from the route so it is in the first-paint
// <head> (same mechanism as the WBS grid's). It defines no tokens of its own —
// the layout already links the shared stylesheet that does, and RR dedupes it.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboardStyles }];

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: projectTitle("EVM ダッシュボード", loaderData.stateView.name) }];
}

/**
 * SSR loader for `/projects/:id/dashboard` (design 0007 — Step 4).
 *
 * This route used to read the whole workspace to display ONE string, the project
 * name, which is the carried debt the dashboard was the trigger to resolve. It is
 * resolved the way the debt note asked — by designing the screen's read rather
 * than by restoring a lighter query. The EVM table is computed from every leaf
 * task's planned effort, progress, expended effort and daily plan, plus the member
 * list, so the workspace batch is now exactly what the screen consumes.
 *
 * It goes through `loadProjectView`, the shared choke point every project screen
 * uses, so this route cannot bypass the role projection (a GENERAL viewer never
 * receives per-member capacity). That also drops the last production caller of
 * `requireProjectAccess`, which has been removed with it.
 *
 * The table itself is NOT sent over the wire: both sides call
 * `projectEvmDashboard` on the same state view, exactly as the WBS grid is derived
 * isomorphically. `today` is resolved here because the as-of date is client state
 * from then on, and a client that read its own clock would hydrate a different
 * initial date than the server rendered.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const view = await loadProjectView(context);
  return {
    ...view,
    today: todayInProjectTimeZone(new Date()),
    // Computed server-side so the number the person sees is the server's, not a
    // client re-derivation that could disagree with the check that will actually
    // run. It is the SAME function the command uses to refuse (Design 0009 §3.1).
    unplottedLeafCount: unplottedLeafTasks(view.stateView).length,
  };
}

/**
 * `baseline.publish` (Design 0009). It reuses `runCommandAction` unchanged, so
 * there is no second write path: the revision pin, the idempotency receipt and
 * the audit actor are the ones every other command gets.
 */
export async function action(args: Route.ActionArgs) {
  return runCommandAction(args, "baseline-publish");
}

export default function ProjectDashboard({ loaderData }: Route.ComponentProps) {
  return (
    <EvmDashboard
      project={loaderData.stateView}
      projectionRole={loaderData.projectionRole}
      today={loaderData.today}
      baseline={loaderData.baseline}
      revision={loaderData.revision}
      unplottedLeafCount={loaderData.unplottedLeafCount}
    />
  );
}
