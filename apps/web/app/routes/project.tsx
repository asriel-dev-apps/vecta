import { Outlet, type LinksFunction } from "react-router";
import type { Route } from "./+types/project";
import { createProjectAccessMiddleware } from "~/middleware/project-access.server";
import { requireProjectAccess } from "~/server/project/project-access";
import { requirePrincipal } from "~/server/auth/require-principal";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { AppBar } from "~/shell/app-bar";
import appStyles from "~/wbs/styles.css?url";

// The layout owns the tier-1 app bar, so it links the shared stylesheet that
// styles it (`.app-frame` / `.app-bar` / `.nav-tabs` / `.theme-toggle`). Every
// project screen renders inside this layout, so the bar is styled server-side
// with no flash even on routes (e.g. the dashboard stub) that link nothing of
// their own; RR dedupes the identical href with the child routes' own links.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: appStyles }];

// The `/projects/:id` access gate. Its middleware validates the id, checks the
// principal's membership, and throws 404 BEFORE any child loader runs on a
// denial (ADR 0012 §Decision 2). The loader below both surfaces the resolved
// access to child routes via `useRouteLoaderData("routes/project")` and forces
// the gate to run on document requests.
export const middleware: Route.MiddlewareFunction[] = [
  createProjectAccessMiddleware(),
];

export async function loader({ context }: Route.LoaderArgs) {
  const { project, membership } = await requireProjectAccess(context);
  // The tier-1 app bar shows the signed-in identity. The cookie-session
  // principal is already loaded by the access middleware (memoised on context),
  // so this adds no DB round trip; it carries no email, so the bar shows the
  // principal's displayName (ADR 0012 Step 4c-2 — faithful adaptation of the
  // SPA's JWT email, which no longer exists under the cookie-session redesign).
  const { principal } = await requirePrincipal(context);
  return { project, membership, displayName: principal.displayName };
}

// ADR 0012 Step 4b — a successful WBS self-save must not force this layout to
// re-read the project row. Skip revalidation for our own successful action
// submissions; a conflict still revalidates (default) so the resync is honoured.
export const shouldRevalidate = skipRevalidationOnSelfSave;

// The per-project shell: the ported tier-1 app bar (ADR 0012 Step 4c-2) above the
// active screen's own tier-2 `app-header`. The provisional `<h1>{project.name}` +
// bare-link nav (4a/Step-3 scaffolding) is gone — the project name lives in each
// screen's tier-2 subtitle exactly as the SPA does.
export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="app-frame">
      <AppBar displayName={loaderData.displayName} />
      <Outlet />
    </div>
  );
}
