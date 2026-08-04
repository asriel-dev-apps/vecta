import { Outlet, type LinksFunction } from "react-router";
import type { Route } from "./+types/project";
import { createProjectAccessMiddleware } from "~/middleware/project-access.server";
import { requirePrincipal } from "~/server/auth/require-principal.server";
import { skipRevalidationOnSelfSave } from "~/routing/self-save-revalidation";
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
// denial (ADR 0012 §Decision 2). The loader below forces the gate to run on
// document requests, and gives the app bar the signed-in identity.
export const middleware: Route.MiddlewareFunction[] = [
  createProjectAccessMiddleware(),
];

// The layout reads NOTHING about the project itself. It used to return the
// resolved `{ project, membership }` "for child routes", but no child ever read
// it, and now that the project row comes out of the workspace batch, asking for
// it here would drag that whole batch onto routes that do not want it — worst of
// all onto the bare `/projects/:id`, which is what the project list links to and
// which only redirects to `/wbs`. So the layout stays identity-only: the app bar
// shows the signed-in principal's displayName (ADR 0012 Step 4c-2 — a faithful
// adaptation of the SPA's JWT email, which the cookie-session redesign removed),
// and the principal is already memoised by the auth middleware, so this loader
// costs no round trip at all. Screens that need the project name read it from
// their own view payload.
export async function loader({ context }: Route.LoaderArgs) {
  const { principal } = await requirePrincipal(context);
  return { displayName: principal.displayName };
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
