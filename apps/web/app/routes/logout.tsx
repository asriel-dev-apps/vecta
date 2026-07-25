import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { destroySession } from "~/server/auth/session.server";
import { appContext } from "~/server/context";

// Public route. Logout is a POST action (state-changing); a stray GET just
// bounces to the login screen.
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(appContext);
  return redirect("/login", {
    headers: { "Set-Cookie": await destroySession(env, request) },
  });
}

export function loader() {
  return redirect("/login");
}
