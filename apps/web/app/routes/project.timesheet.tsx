import type { LinksFunction } from "react-router";
import type { Route } from "./+types/project.timesheet";
import { leafTaskIds } from "@vecta/application";
import { loadProjectView } from "~/server/project/load-project-view.server";
import {
  runTimesheetAction,
  TIMESHEET_TEMPLATE_HEADER,
} from "~/server/project/timesheet-action.server";
import { TimesheetImport } from "~/timesheet/timesheet-import";
import { projectTitle } from "~/shell/document-title";
import timesheetStyles from "~/timesheet/timesheet.css?url";
import appStyles from "~/wbs/styles.css?url";

// The screen's own sheet plus the shared token sheet, linked from the route so
// both are in the first-paint <head> (the same mechanism the grid and the
// dashboard use; RR dedupes the shared href with the layout's).
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: appStyles },
  { rel: "stylesheet", href: timesheetStyles },
];

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: projectTitle("勤怠取込", loaderData.stateView.name) }];
}

/**
 * `/projects/:id/timesheet` (Design 0011).
 *
 * The loader reads the same role-scoped workspace every project screen does. The
 * two counts it adds are the honest state of AC: how many leaves carry dated
 * actuals, out of how many there are. Until those are equal, AC(t) is partly a
 * constant — and the screen says so rather than letting an as-of date look more
 * meaningful than it is.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const view = await loadProjectView(context);
  const leaves = leafTaskIds(view.stateView.tasks);
  const leafTasks = view.stateView.tasks.filter((task) => leaves.has(task.id));
  return {
    ...view,
    templateHeader: TIMESHEET_TEMPLATE_HEADER,
    leafCount: leafTasks.length,
    datedLeafCount: leafTasks.filter((task) => Object.keys(task.datedActuals).length > 0).length,
  };
}

/**
 * Not `runCommandAction`: this action receives a FILE, and the parse that turns
 * it into a command has to happen server-side (Design 0011 §6.1). It still
 * reaches the database through `applyCommands`, so there is no second write path.
 */
export async function action(args: Route.ActionArgs) {
  return runTimesheetAction(args);
}

export default function ProjectTimesheet({ loaderData }: Route.ComponentProps) {
  return (
    <TimesheetImport
      project={loaderData.stateView}
      revision={loaderData.revision}
      templateHeader={loaderData.templateHeader}
      leafCount={loaderData.leafCount}
      datedLeafCount={loaderData.datedLeafCount}
      // VIEWER gets a read-only screen for the same reason every other master
      // does: the server 403s the write anyway, and a disabled control says so
      // before the click rather than after it.
      editable={loaderData.projectionRole === "PRIVILEGED"}
    />
  );
}
