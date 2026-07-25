import { Outlet } from "react-router";
import type { Route } from "./+types/protected";
import { createAuthMiddleware } from "~/middleware/auth.server";

// Pathless layout route: its middleware authenticates every nested route, so
// everything under it is auth-by-default. Public routes (`/login`,
// `/auth/callback`, `/logout`) are declared outside this layout.
export const middleware: Route.MiddlewareFunction[] = [createAuthMiddleware()];

export default function ProtectedLayout() {
  return <Outlet />;
}
