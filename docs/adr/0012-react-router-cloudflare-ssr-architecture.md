# ADR 0012: React Router v8 SSR architecture on Cloudflare — instant UX, multi-project shell, one command core for API/MCP/LLM

## Status

Accepted (2026-07-22). Extends 0011 (the effort-WBS app). **Amends 0002** (auth: the client-side
Google-OIDC Bearer token in `localStorage` becomes a server-side OIDC authorization-code flow with an
httpOnly cookie session). Relates to 0003 (remote MCP). Supersedes the DRAFT
`docs/design/0004-performance-realtime-architecture.md` (that doc's Phase-0/Phase-1 framing is resolved
by this decision).

This ADR is self-contained: a fresh session should be able to implement from it alone. It contains no
client data; all fixtures/demo/seed data are synthetic.

## Context

The app (ADR 0011, live at `https://vecta.tt-dev.workers.dev`) is a React 19 **SPA** (Vite 8, TanStack
Table/Virtual grid, dnd-kit) served statically by a **Cloudflare Worker** that also hosts a **Hono**
API; **Drizzle ORM** on **Neon serverless Postgres**; auth = Google OIDC, **client-side**, ID token in
`localStorage`, sent as Bearer. The monorepo's `packages/{domain,application,persistence}` are pure-TS,
framework-agnostic (EVM math, a deterministic scheduler, projections, and a **command service** with
validation, `expectedRevision` optimistic-locking, and an audit log).

Problems the user raised, in priority order:
1. **Initial-load flash** — the SPA renders empty, then fetches (`load()`+`grid()` = two round-trips),
   then swaps in data → a visible empty→data "pop". "絶対にやめたい."
2. **Slow saves** — optimistic apply exists but a post-save `reload()` re-settles the grid, edits are
   blocked while a save is in flight, and derived (daily/EVM) values wait on the server.
3. Hard constraints: **stay free / lowest cost (must run on Cloudflare's free tier)**; **safe, natural,
   general, proven** (e.g. httpOnly cookie sessions over localStorage tokens); **reuse React + the
   pure-TS packages**; single-user AND multi-user with **no data inconsistency**; add **real-time
   later** without a rewrite; **AI-first** (chat/estimate-doc → the LLM applies changes).

Product vision this architecture must be the foundation for (some parts exist): project list
(multi-project), WBS editing, Gantt chart, effort input, budget/actuals, PV/EV/AC, CPI/SPI/EAC
dashboard, member/permission management, CSV import/export, and **LLM-driven operation** — the user
converses or hands over an estimate and the LLM reflects it.

Root cause of the flash/slow-save is **architectural, not the database**: a client-render-then-fetch SPA
with no SSR, no router, and a client-token auth. The stack (Cloudflare/React/Hono/Neon/pure-TS command
core) is sound and retained.

## Decision

1. **Adopt React Router v8 (framework mode) on Cloudflare Workers** as the web architecture. Routes'
   **`loader`s run server-side (SSR)** so the first paint already has data — the flash is eliminated by
   construction, not patched. Reuse the existing React 19 components and the pure-TS
   `packages/{domain,application,persistence}` unchanged. Scaffold with Cloudflare's official path
   (`@cloudflare/vite-plugin`, `react-router.config.ts` `ssr: true`, `workers/app.ts` Worker entry).
   Target v8 (VECTA already meets its minimums: React 19.2.7, Vite 8, Node 22+); starting on v7.18 with
   the `future.v8_*` flags on is an acceptable conservative variant (same architecture, trivial upgrade).

2. **Storage stays Neon (Postgres) + Drizzle with the unchanged schema; add Hyperdrive** (included on
   the Workers free plan) in front for edge connection-pooling + read caching. **No D1/SQLite
   migration**: the schema uses Postgres features (arrays, `jsonb`, composite FKs, checks) and Postgres
   keeps the ceiling high for analytics, scale, and **`pgvector`** (the natural home for the AI/estimate
   features). D1 is a *future* option only if measured latency demands it (a focused SQLite port), not
   now — with SSR + optimistic saves + Hyperdrive, DB latency is not the bottleneck.

3. **One command core, multiple "mouths."** `packages/application`'s command service (zod validation,
   `expectedRevision` optimistic-lock, audit) remains the **only write path**. It is exposed via three
   surfaces on the **same Worker**, with **no logic duplication**:
   - **RR `loader`/`action`** — the app's own UI I/O and the in-app LLM chat.
   - **Hono `/api/*`** — a public REST API (`@hono/zod-openapi`, typed + OpenAPI-documented).
   - **Hono `/mcp`** — an MCP server (`@hono/mcp`, or Cloudflare's `agents` SDK) for external LLM agents.
   The Worker entry dispatches `/api` + `/mcp` to Hono and everything else to React Router. Hono is thus
   re-scoped from "the app's private API" to "the external API + MCP surface" — its best-fit role.

4. **Auth: server-side OIDC authorization-code flow → httpOnly signed cookie session** (RR
   `createCookieSessionStorage`, stateless, holding only the principal id). The Google authorization
   redirect is server-initiated; a callback `action` exchanges the code + verifies (jose against Google
   JWKS) **once at login**, then issues the cookie. Per request, RR verifies the signed cookie →
   principal → authorizes. Tokens never reach the client; the browser holds only an httpOnly cookie
   (XSS-safe). This **amends ADR 0002** (client Bearer → server cookie session).

5. **Multi-project shell.** Drop the baked single `VITE_VECTA_PROJECT_ID`. Router: `/projects` (the
   user's accessible projects) → `/projects/:id/{wbs,gantt,dashboard,members,templates,…}`. Loaders
   enforce **project access + role** using the existing model (`principals`, `tenant_memberships`,
   `project_memberships`, tenant/project roles OWNER/ADMIN/MEMBER & OWNER/EDITOR/VIEWER, and the
   two-role field projection). Just-in-time new-user provisioning + invites are a later member-management
   feature the design must allow.

6. **Grid rendering: SSR the loader data (no flash), client-hydrate the virtualized grid.** The loader
   fetches project/grid data server-side (Hyperdrive-fast) and it is serialized into the HTML, so the
   first paint has data. The heavy TanStack virtualized grid is a **client component that hydrates**
   (the server serializes data, it does **not** server-render every row/column), keeping server CPU
   under the **free plan's 10 ms/request** limit. Fallbacks if CPU/size limits bite: per-route
   `clientLoader`/SPA-mode for the heaviest routes, or the $5/mo Workers Paid plan (30 s CPU, 10 MB).

7. **Optimistic sync.** Saves use an RR `action` + optimistic UI: the client applies the command
   locally with `applyProjectCommand` **and computes derived EVM/scheduler values client-side** (reusing
   the domain/application packages) → the edit is perceived-instant and there is **no post-save
   re-settle**. The action applies the command through the command service with `expectedRevision`;
   conflicts trigger RR revalidation + a surfaced notice. `shouldRevalidate` is scoped so background
   revalidation causes no visible jump. Edits are queued, not blocked, during an in-flight save.

8. **Consistency now = optimistic-concurrency; live real-time deferred (Phase 1).** Multi-user is
   **inconsistency-free today** via `expectedRevision` + audit (conflicts detected + safely resolved),
   without live cursors. Live collaboration (others' edits streaming in) is deferred and, when
   justified, added via **Cloudflare Durable Objects + WebSocket (free tier)** in the *same* Worker (a
   DO class + a WS-upgrade branch in `workers/app.ts`) — the architecture must not preclude it. Sync
   engines (Convex, Zero, ElectricSQL, Replicache, LiveStore, …) are rejected: each forces abandoning
   Neon/Postgres **or** paying for an always-on non-Cloudflare host, violating "free-on-Cloudflare +
   keep-Postgres + proven."

9. **Migration is staged, with no data migration.** Build a new RR v8 app shell (auth, router,
   loader/action data layer, mounted Hono `/api` + `/mcp`) reusing the existing React components + the
   pure-TS packages + the **unchanged Neon schema**. Port the existing screens (WBS grid, master,
   template, member panel) into RR routes. Keep the live app running until a careful cutover deploy
   (verify the served bundle hash + login/API health, allow ~30 s propagation). Production data (the 48
   tasks, masters, templates, admin membership) is untouched.

10. **This is the foundation for the full vision.** Every vision feature maps onto this shell: project
    list (routing), WBS/effort/EVM (exists, ported), Gantt + CPI/SPI/EAC dashboard (new routes over the
    same data), budget/actuals (a cost layer on the effort model), member/permission management (the
    existing roles + admin UI), CSV import/export (an action/resource route parsing → commands), and
    **LLM-driven operation** — the LLM (a Claude model) is called inside an `action`, returns
    **structured commands** (tool-use/structured output), which are applied through the same validated
    command core. The LLM never touches the DB directly; it is exactly as safe/auditable as a human
    edit. Estimate-document/semantic features use `pgvector` on Neon.

## Rationale / alternatives considered

- **Next.js on Vercel** (the de-facto standard) was seriously compared *on its home turf*, not just as
  a Cloudflare adapter. It loses here on VECTA's stated priorities: Vercel's free **Hobby plan is
  non-commercial only** (VECTA is a work tool → **Pro ≈ $20/seat/mo**), Vercel has no stateful edge
  primitive so **real-time needs paid Redis/3rd-party**, and adopting it means a large migration off
  Cloudflare to App Router/RSC. It would win only if the user accepted ~$20+/mo and valued
  ecosystem/DX/RSC over free-on-Cloudflare — they do not. **Next-on-Cloudflare** (OpenNext) is worse:
  adapter caveats, the free-plan **3 MB Worker-size** risk, and RSC overhead for a client-heavy grid.
- **React Router v8 vs v7**: v8 is an *incremental* major (v7 `future.v8_*` flags defaulted); framework
  mode is unchanged; Cloudflare support is first-class in v8. VECTA meets v8's minimums. v7.18 + flags is
  the conservative fallback, same architecture.
- **TanStack Start / Vike**: TanStack Start is near-equal (docs self-label "Release Candidate"); Vike is
  the minimal-disruption alternative (mount SSR inside the existing Hono). RR v8 chosen for
  mainstream/proven status, first-class Cloudflare support, and built-in cookie sessions.
- **Neon vs D1**: chosen on *performance + extensibility first* (not migration cost). Postgres wins on
  extensibility (arrays/jsonb/analytics/`pgvector`/scale); Hyperdrive closes the latency gap for free;
  D1's edge-latency edge is marginal at VECTA's scale and caps the ceiling.
- **A separate Go backend** was offered by the user and declined: it moves off the free Cloudflare edge
  (adds a host + ops + a second runtime), and its concurrency/WebSocket strengths are covered by
  Cloudflare Durable Objects on the free tier.

## Consequences

- **Kills the flash** (SSR data on first paint) and makes saves perceived-instant (client-side optimism
  + client-derived values, no reload settle) — the top two user pains — while staying **$0 on
  Cloudflare** and keeping Postgres/Neon + the pure-TS packages.
- **Auth becomes safer** (httpOnly cookie session; tokens server-side only) and **multi-user + AI + API
  + MCP all flow through one validated command core** — no bespoke, no duplication, auditable.
- **Costs / risks**: React Router v8 is ~5 weeks old as of 2026-07 (mitigate: careful pinning, or the
  v7.18+flags fallback). The free-plan **10 ms CPU** ceiling may require client-hydrating the grid (as
  decided) and, worst case, the $5/mo Paid plan. The migration (new app shell + porting screens) is real
  work, but staged, reuses the packages/components, and needs **no data migration**.
- **Deferred / non-goals**: live real-time collaboration (Phase 1: Cloudflare DO + WebSocket); D1
  (only if latency is later measured to demand it); the money/budget cost layer, Gantt, dashboard, CSV,
  member-admin UI, and LLM operation are enabled by this shell and implemented as follow-on features.

## Implementation order (for the follow-on build)

1. Scaffold RR v8 framework mode on Cloudflare in the monorepo; wire `@cloudflare/vite-plugin`,
   `workers/app.ts` (dispatch `/api` + `/mcp` → Hono, else → RR), keep the pure-TS packages + Neon.
2. Server-side OIDC auth-code flow + httpOnly cookie session; per-request principal + role authz.
3. Multi-project router (`/projects` → `/projects/:id/*`); loaders enforce access/role.
4. Port the WBS grid (loader = data SSR'd, grid client-hydrates) + master/template/member-panel routes;
   actions apply commands with `expectedRevision`; optimistic UI + client-derived values, no settle.
5. Mount Hono `/api/*` (zod-openapi) + `/mcp` on the same Worker over the command core.
6. Verify (`pnpm check`, screenshots, served-bundle-hash) → careful cutover deploy → then build the
   remaining vision features (Gantt, dashboard, budget, CSV, member admin, LLM-via-commands) on this shell.
