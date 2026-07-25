import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

// Public routes (no auth) sit at the top level; everything that requires a
// signed-in principal lives under the pathless `protected` layout whose
// middleware enforces authentication (ADR 0012 §Decision 4/5).
//
// Inside `protected`, the multi-project router (ADR 0012 §Decision 2):
//   `/`               → redirects to `/projects`
//   `/projects`       → the accessible-project list
//   `/projects/:id`   → per-project layout; its middleware is the fail-closed
//                       access gate, and each child forces a `.data` round trip
//                       so the gate re-runs on client navigation.
export default [
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("logout", "routes/logout.tsx"),
  layout("routes/protected.tsx", [
    index("routes/index.tsx"),
    route("projects", "routes/projects.tsx"),
    route("projects/:id", "routes/project.tsx", [
      index("routes/project.index.tsx"),
      route("wbs", "routes/project.wbs.tsx"),
      route("dashboard", "routes/project.dashboard.tsx"),
      route("masters", "routes/project.masters.tsx"),
      route("members", "routes/project.members.tsx"),
      route("templates", "routes/project.templates.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
