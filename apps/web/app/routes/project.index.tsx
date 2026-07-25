import { redirect } from "react-router";
import type { Route } from "./+types/project.index";

// A project opens on its primary view (the WBS grid), so `/projects/:id` is
// never a bare layout with an empty <Outlet/>. The parent access middleware has
// already run (UUID + membership) before this loader, and the redirect target
// re-enters that middleware, so access stays enforced.
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/projects/${params.id}/wbs`);
}
