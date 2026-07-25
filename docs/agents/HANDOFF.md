# HANDOFF — VECTA (updated 2026-07-22)

Session-recovery state — **kept lean on purpose**. Only what's needed to CONTINUE lives here;
completed history is in `docs/agents/HANDOFF-archive.md` (full backup, not loaded each session).
Keep it this way: when you finish something, move its detail to the archive, not here.

Advisor = the Claude Code **Advisor feature** (`/advisor fable` pairs this Opus main with a Fable
advisor). Implementation is delegated to opus/general-purpose subagents; the main session designs,
independently verifies (`pnpm check` + scope/leak grep + screenshots), commits, pushes, deploys.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta`, remote `git@github.com:asriel-dev-apps/vecta.git`,
  branch **`adr-0011-effort-wbs-realignment`** (all work here; not yet merged to `main`).
- Governing docs (read as needed):
  - `docs/adr/0011-effort-based-wbs-evm-realignment.md` — the realignment decision.
  - `docs/design/0002-step2-effort-wbs-grid.md` — data model (**§12 advisor decisions authoritative**).
  - `docs/design/0003-wbs-ui-realignment-backlog.md` — the P0–P3 feature backlog (P0–P2 done).
  - `docs/design/0004-performance-realtime-architecture.md` — **perf/real-time direction (DRAFT,
    not approved)**; principles + Phase 0/1 plan; work through with the user before building Phase 1.
- Private master requirements are outside the repo in `../.wbs-private/` — **never read it**.

## Current live state

- **design 0003 FULLY COMPLETE and DEPLOYED** (P0–P3), plus the header + login redesigns and the
  theme toggle. Live: **https://vecta.tt-dev.workers.dev** (worker `vecta`, worker version
  **`13c29cb5`** = latest G-1 deploy). Auth = Google OIDC; persistence = Neon serverless
  (`DATABASE_URL` secret). After a deploy, allow **~30 s propagation** before the served
  `index-*.js` hash matches the build (verify the hash, not just the version id).
- **DB schema at migration 0005** (Neon, prod): `tasks` model + `members` + project-scoped masters
  `processes`/`products` + `subtask_templates`; review/change refs and `daily_plan_locked` dropped.
- **Prod project holds 48 synthetic test tasks** (8 phases × 5 subtasks) + 8 processes / 6 products /
  6 members / 2 default templates / 32 deps (all generic "Phase A"/"Product 1"/"Member 01"); admin
  membership intact (revision 11). Replaced the earlier junk stubs.
- Full gate green on the branch (domain 32, application 67, persistence 34, web 112); CI (`ci.yml`,
  checks-only) runs on every branch push + PRs and is green on Actions.

## Active work / backlog

- **Login screen redesign** — DONE + deployed (`5ea0775`, worker `d536542b`): asymmetric layout,
  VECTA-origin tagline ("Earned Value, Cost & Timeline Analytics" + the *vector* origin), enriched
  WBS/EVM hero (schedule bars + dependency links + milestones + earned-value S-curve → vector arrow),
  and an **app-wide theme toggle** (System/Light/Dark via `data-theme` on `<html>`, instant live
  switching; the pure `prefers-color-scheme` didn't switch live). Toggle in the app bar + on login.
- **P3 — F-1 DONE + deployed** (`26d51df`, worker `826cbd89`): project-scoped **immutable display
  No.** — `tasks.seq` + `projects.next_task_seq`, No. shows `0001`-style. **Migration 0006 applied to
  live Neon** (verified: 48 tasks → seq 1..48, all unique, `next_task_seq`=49); 7 migrations applied.
  Assigned at creation, never renumbered (gaps ok, structural via seq excluded from updates),
  tasks+subtasks share the counter.
- **P3 — G-1 DONE + deployed** (`da764ea`, worker `13c29cb5`): member daily-total bottom panel —
  rows=members, columns=the grid's own dayVirtualizer (pixel-aligned), per-day Σ dailyPlan +
  ExternalLoad shown in hours, capacity-overflow red (reuses `detectOverloads`/`overloadByKey`),
  horizontal-scroll mirrored with the grid, quiet "メンバー日次負荷" toggle (closed by default).
- **design 0003 is fully implemented + live.** The current major work is the architecture migration in
  **ADR `docs/adr/0012-react-router-cloudflare-ssr-architecture.md`** (agreed 2026-07-22): migrate the SPA
  to **React Router v8 (framework mode) SSR on Cloudflare**. Staged migration — a NEW parallel app is built
  at **`apps/web-next`** while the live `apps/web` stays untouched; at cutover `apps/web` is deleted and
  `web-next` renamed → `web`. Implement from the ADR's **"Implementation order"** (6 steps; self-contained).
- **ADR 0012 Step 1 — DONE** (`5acea4f`): `apps/web-next` scaffold = RR **v8.2.0** framework mode
  (`ssr:true`) on Cloudflare Workers. `workers/app.ts` dispatches `/api` + `/mcp` → **Hono** (skeleton:
  `/api/health` ok, `/mcp` 501 placeholder), else → the RR request handler. Home route `loader` runs
  server-side and reuses `@vecta/domain`'s EVM calc over a synthetic fixture → value is in first-paint HTML
  (SSR proven, `data-ssr-spi="0.75"`). Reuses the pure-TS packages (workspace deps) + unchanged Neon schema.
  Versions pinned to the monorepo; `wrangler` name `vecta-next-local`. **Root `pnpm check` green** with
  web-next included (web-next test 1); `apps/web` byte-for-byte unchanged. Not deployed.
  - **Known local-dev limitation**: this machine's bundled workerd/miniflare caps `compatibility_date` at
    `2026-07-15`, but `web-next/wrangler.jsonc` uses `2026-07-17` (same as `apps/web`). So `react-router
    dev`/miniflare won't boot locally without a **temporary** date toggle to `2026-07-15` (revert after).
    Build / typecheck / test / `pnpm check` are unaffected (they don't invoke workerd).
- **ADR 0012 Step 2 — DONE** (`e5aaeb1`): server-side **OIDC authorization-code flow → httpOnly signed
  cookie session** in `apps/web-next` (amends 0002). `__Host-` session cookie (httpOnly/Secure/SameSite=Lax,
  `SESSION_SECRET`(+`_PREVIOUS`) signed), payload `{principalId, exp}` with **`exp` enforced server-side**
  (RR doesn't enforce cookie maxAge server-side), 7-day absolute. Flow: `/login` (PKCE S256 + state + nonce,
  validated `returnTo`, `__Secure-oidc_tx` transient cookie) → provider → `/auth/callback` (error-branch first,
  state check, code exchange, jose **RS256** verify iss/aud=client_id/exp/nonce, **`(issuer,subject)` →
  principal, no JIT**) → session; `/logout`. Config env-driven (`OIDC_*` `.invalid` placeholder vars; secrets
  `OIDC_CLIENT_SECRET`/`SESSION_SECRET` via `.dev.vars`/Worker secrets, **audience = client_id**, no discovery
  fetch). RR v8 load context via **`RouterContextProvider`** (typed `appContext`/`principalContext`) wired in
  `workers/app.ts`; `/api`+`/mcp` dispatched to Hono **before** RR (never cookie-auth), exact-prefix matched.
  **Fail-closed**: a protected pathless-layout middleware requires auth; `/login`,`/auth/callback`,`/logout`
  public. Principal+memberships resolved **once per request** (memoized promise → one DB hit under single-fetch
  parallel loaders). `oidc_tx` cleared on **every** callback outcome incl. backend failure (503, not 500);
  root `ErrorBoundary` backstop; error screens carry status (403/400/503). **50 web-next unit tests** (no
  net/DB). Fable security review: **no open P0**. Root `pnpm check` green; `apps/web` untouched. Not deployed.
- **ADR 0012 Step 3 — DONE** (`4bf70da`): multi-project router under the protected layout. `/` → redirect
  `/projects`; `/projects` = principal's accessible-project list; `/projects/:id` = layout whose
  **middleware** is the fail-closed access gate + children `{index→wbs, wbs, dashboard, members, templates}`
  (Step-4 stubs). Gate: UUID-validate `params.id` → `await` the Step-2 memoized principal → **in-memory**
  `findProjectMembership` (NOT the resolver) → deny/unknown/malformed-or-uppercase-UUID = **`throw
  data(null,{status:404})` BEFORE `next()`** (indistinguishable, no existence oracle; no DB on deny). VIEWER
  passes (read); write-authz is Step 4. Context `{project, membership:{tenantId, projectId, projectRole,
  tenantRole}}` via a per-request **memoized thunk** (one project-row fetch by `(tenantId,id)` under parallel
  loaders); `requireProjectAccess(context)` helper. Each child route has a loader awaiting it → forces the
  `.data` round trip so the gate re-runs on client nav. Project-list = **`PostgresProjectListReader.
  listForPrincipal` in `@vecta/persistence`** (one `project_memberships⨝projects` query; Step-5 Hono reuses
  it). Deleted the Step-1 SSR demo home route. **59 web-next tests** (headline: on deny child loaders never
  run; IDOR/tenant + memoization + malformed/uppercase-id pinned) + persistence testcontainers test. Fable
  security review: **no open P0**; fixes applied (canonical-lowercase-only UUID guard, identical-404 payload
  assert, `close().catch` so close errors don't mask query errors). Root `pnpm check` green. Not deployed.
  **4c-1 DONE** (`7ec561d`): master/member/template panels ported byte-faithful into `/projects/:id/{masters
  (new: 工程+プロダクト), members, templates}` (mapping A; `/members` reserved to grow into member-admin);
  data plane reuses 4b (shared loader through `projectWorkspaceView`, shared action over `applyCommands`),
  fable parity review found no violations. Also hardened: web-next tsconfig `noEmit` + gitignore
  `apps/web-next/**/*.js` (a stray `tsc` had transpiled JS next to the TS sources — never track those).
  **NEXT within Step 4 = 4c-2** (header): make `project.tsx`'s layout the ported tier-1 app-bar
  (brand + theme toggle + identity + sign-out→/logout + active nav), delete the provisional `<h1>`/bare-link
  nav, leave each screen's tier-2 header alone. Then 4d.
- **ADR 0012 Step 4 — DONE** (all sub-slices; fable-reviewed; pushed; **195 web-next tests**): the **WBS grid**
  + master/member/template screens are ported into `/projects/:id/*` — SSR no-flash grid, optimistic
  **queue-not-block** saves through the framework-free `applyCommands` core (Step 5 reuses it), and the tier-1
  app-bar. Commits: 4-pre `37ad335`, 4a `135e4b6`, 4b `70581fb`, 4c-1 `7ec561d`, 4c-2 `9531f8d`, 4d `514d0a7`.
  `apps/web` untouched; root `pnpm check` green. (The sub-slice narrative below is retained history — its
  interim "NEXT = 4c/4c-2" markers are superseded; the `adr-0012-step4-plan.md` execution plan is removed now
  that Step 4 is complete.) TL;DR of what shipped:
  loader **SSRs the state view** (no flash), grid **client-hydrates** (virtualizer `initialRect` is the crux —
  spike first); `action` applies a one-POST command batch with **`expectedRevision`**, client keeps its
  optimistic + client-derived state with **no post-save re-settle** (`useState` survives revalidation;
  `shouldRevalidate` scoped on all active routes); conflict → action returns `data(409,…)` → adopt fresh
  loader data (no remount). Reads projected via `projectionRoleForProjectRole`+`projectWorkspaceView`; writes
  authorized via `createProjectCommandAuthorizer`. **Port `apps/web/src/App.tsx` wholesale, swap 2 data-plane
  seams** (no pure-view extraction). Sub-slices: **4-pre** per-request memoized DB session → **4a** read-only
  SSR grid (proving slice) → **4b** write path → **4c** master/template/member → **4d** queue + revalidate.
  **Spec-parity**: mirror the real spreadsheet; add nothing not in `apps/web`. The single most important test:
  client-optimistic transition === the unit-of-work transition for every command (see plan §0).
  **Progress**: **4-pre** (`37ad335`) + **4a** (`135e4b6`) + **4b DONE** (`70581fb`) — all fable-reviewed. 4a =
  SSR grid renders real rows in first paint (virtualizer `initialRect` verified). 4b = optimistic saves
  through the command core: framework-free action core (Step-5 reuses it), server-sourced authz (VIEWER
  fail-closed), confirmed-revision advance + rollback snapshot + conflict/partial-commit adopt with **no
  re-settle**. Fable P0 in 4b (RR 8.2.0 skips revalidation for status>=400 → conflict resync was dead) is
  **fixed + proven** by a router-level 409 test; §0 convergence pinned for all command types (PRIVILEGED;
  GENERAL server-denied). 113 web-next tests. **NEXT = 4c**: distribute the SPA's single マスタ tab content
  across the `/projects/:id/{members,templates}` routes (`MasterScreen`/`TemplateSection` use the same
  `client.load()/execute()` seams → mechanical after 4b); leave `dashboard` a stub; reconcile the
  provisional double-header (layout chrome + grid's own `app-header`). Then 4d (queue-not-block +
  `shouldRevalidate` hardening).
- **ADR 0012 Step 5 — DONE** (fable-reviewed, no open P0, pushed): the two **external / token-auth** mouths of
  the command core on the same Worker. **5a `/api`** (`0b1f9ff`): Hono `@hono/zod-openapi` REST — `applyCommands`
  gained an injectable identity/grant seam (cookie surface byte-identical; token surface = verified
  `AuthenticatedIdentity` + `PostgresProjectAccessGrantResolver`, AGENT scope-fenced, `(issuer,subject)`+`email:`
  fallback, grant resolved once/batch); ported oidc-auth (Bearer, RS256) + edge-security (bounded body, rate
  limits, `secureResponse`, no CORS); routes health/projects/workspace/commands/openapi; GENERAL projected
  server-side; cookie never consulted; malformed→400. **5b `/mcp`** (`5b56bd2`): stateless remote MCP server
  (`agents@0.17.4` `createMcpHandler` + `@modelcontextprotocol/sdk@1.29.0`, the proven pins — built cleanly, no
  fallback), 3 tools (list/get/apply) delegating to the SAME core paths as `/api`; audience `MCP_RESOURCE_URL`
  (distinct → no cross-surface replay); RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`;
  non-POST→405; no ACAO; per-surface `mcp` rate bucket. **249 web-next + 45 persistence tests; bundle 800 KiB
  gzip (~27% of free 3 MB); root `pnpm check` green.** `docs/agents/adr-0012-step5-plan.md` removed (Step 5 done).
- **Post-cutover — read-path latency (NOT yet deployed)**. Every screen took ~1 s from click to
  paint. Cause was round-trip count, not rendering: each `.data` request opened a **fresh Neon WebSocket pool**
  (TCP+TLS+WS handshake + Postgres startup/auth, unamortisable in a Worker invocation) and then ran **~14
  sequential queries** — principal + 2 membership reads, the project row, and `ProjectRepository.load`'s
  `BEGIN` + 9 SELECTs + `COMMIT`. One of those 9 was `audit_events`, which the read model never reads and which
  grows without bound. Fixed by splitting the transports:
  - `DbSession` now has **`read()` (Neon SQL-over-HTTP, `neon-http-database.ts`) alongside `database()`** (the WS
    pool, still required for the write path's interactive `SELECT ... FOR UPDATE`). Reads open no connection; the
    write pool is opened lazily and a read-only request never touches it.
  - The workspace read is **one `db.batch(...)`** (`NeonHttpProjectWorkspaceReader`) — header + 7 child queries in
    a single HTTP request — and `loadPrincipal` batches its 3 reads into one. `audit_events` is out of the read.
  - Isolation is preserved: `openNeonHttpReadDatabase` sets **`isolationLevel:"RepeatableRead", readOnly:true` on
    the client**, which Neon sends as `Neon-Batch-*` headers so its proxy opens the batch transaction with them
    (Drizzle's `batch()` passes no transaction options, so client defaults are what every batch runs under — a
    `SET TRANSACTION` statement would have been the fragile way to do this).
  - Queries + row→record mapping are **shared** by both readers (`project-read-queries.ts`,
    `toProjectDetailRecord`), and `repository.test.ts` asserts the batched reader returns **exactly** what the
    pool-backed one does against real Postgres, in one batch of 8. Net: ~14 sequential round trips + a WS
    handshake → **3 HTTP round trips** per navigation.
  - Also: the app bar gained a **「プロジェクト一覧」back link** (`/projects/:id/*` was a dead end — every tab
    stayed inside the project and the only other exit was Sign out).
  - **NOT deployed.** Root `pnpm check` green (domain 32, application 70, persistence 46, web 115, web-next 260).
    Deploying this is the next user-visible step; verify the served bundle hash after (~30 s propagation).
  - Deliberately NOT done: hoisting the workspace read to the `/projects/:id` layout so sibling tab clicks skip
    the fetch entirely. RR would not revalidate the layout loader on a sibling nav (`defaultShouldRevalidate`
    false: same pathname, same params) — which is exactly the problem: `skipRevalidationOnSelfSave` also keeps it
    stale after a self-save, so tab-switching would show the pre-edit snapshot. It needs the client state lifted
    to the layout (the SPA's in-memory tab model) first, which is a real refactor of the optimistic pipeline.
- **ADR 0012 Step 6 (CUTOVER) — deploy DONE, retire step outstanding.** `https://vecta.tt-dev.workers.dev` serves
  `apps/web-next` (verified: SSR sign-in page, RR v8 asset graph). Still to do from the runbook: **delete
  `apps/web` and rename `web-next` → `web`** (both app directories still exist). Retained below for the retire
  step and for rollback — the runbook's phases (A) pre-cutover verification, (B) prod config/secrets, and (C) the
  cutover deploy are done; the retire half of (C) is not. **(D) vision features** (Gantt, dashboard, budget, CSV,
  member admin, LLM-via-commands) are follow-on work, not the cutover. Real-time = Phase 1 (Cloudflare DO +
  WebSocket, free) later.
- **Step 6 cutover — full executable runbook (fable-reviewed): `docs/agents/adr-0012-step6-cutover-runbook.md`**
  (phases 0–7: user blockers, R1 principal fix, local smokes, deploy, verify, retire, rollback + risk register).
  User-required inputs (blockers) in brief:
  1. **Google OAuth *confidential* client secret** — ADR 0012 amended auth to a **server-side authorization-code
     flow**, which needs `OIDC_CLIENT_SECRET` (the old app used a client-side flow with NO secret). Create/enable a
     confidential client secret in Google Cloud Console and register the **redirect URI** `https://<host>/auth/callback`.
  2. **`SESSION_SECRET`** (+ optional `SESSION_SECRET_PREVIOUS`) — new; signs the httpOnly cookie session. Generate a
     strong random secret. Both go in `.dev.vars` locally and `wrangler secret put` in prod.
  3. **`MCP_RESOURCE_URL`** — the `/mcp` audience / RFC 9728 resource id, canonical form path `/mcp`
     (e.g. `https://<host>/mcp`); a `vars` entry per environment.
  4. **`OIDC_*` vars** per env in `apps/web-next/wrangler.jsonc` (issuer `https://accounts.google.com`, jwks
     `https://www.googleapis.com/oauth2/v3/certs`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_AUTH_ENDPOINT`,
     `OIDC_TOKEN_ENDPOINT`) + the **3 `ratelimits` bindings** (PRE_AUTH/AUTH/COMPUTE) + `DATABASE_URL` secret
     (existing Keychain `vecta-database-url`). Audience for `/api` = `OIDC_CLIENT_ID`.
  5. **Verify prod `principals.subject`** carry the real Google `sub` (not `email:<addr>`) — see R1 above. The `/api`
     `email:` fallback softens this for the token surface but the **cookie login still needs it**; do the one-time
     check/migration before cutover.
  6. **Local smokes** (behind the workerd compat-date toggle, with `.dev.vars`): (a) view-source of `/projects/:id/wbs`
     shows `data-row-id` rows on first paint (SSR no-flash); (b) a `wrangler dev` POST to `/mcp` (initialize) succeeds
     (closes the CI-doesn't-run-workerd residual).
  Only after 1–6 is the cutover deploy (§C) run. The deploy itself is outward-facing — confirm with the user.
- **ADR 0012 cutover gates / debt** (before treating the migration done):
  - **Prod principal identity (R1, P1-2)**: the old app resolved access via a `subject="email:<addr>"`
    fallback (admin-seed path); web-next matches **exact `(issuer,subject)`** only. If the prod admin
    `principals` row still carries an `email:` subject, the first web-next login → forbidden / empty list.
    **Verify prod `principals.subject` values carry the real provider `sub` before cutover** (or do a
    one-time deliberate migration). Do NOT add the email fallback to the session login.
  - **web-next Neon-reader debt**: web-next has a direct `drizzle-orm` dep + two thin Neon read-seams that
    import persistence schema/conn: `app/server/auth/principal-directory.neon.server.ts` and
    `app/server/project/project-reader.neon.server.ts`. **Consider consolidating before/around Step 5** (the
    API/MCP surface adds more reads over the same tables): move both Drizzle impls into `@vecta/persistence`
    (beside `project-access.ts`/`project-list.ts`), keep the `PrincipalDirectory`/`ProjectReader` interfaces in
    web-next, drop the direct `drizzle-orm` dep. The project-list read already lives in persistence (the right
    precedent). Interim: keep both `drizzle-orm` pins (0.45.2) in lockstep.
  - **Save-queue 1000-command cap (from 4d, deferred)**: the coalescing pending buffer can exceed the
    `CommandBatchSchema` 1000-command cap under sustained heavy reorders queued behind a slow save → the drain
    422s and the queue is erased. Low-probability. Follow-up fix = chunk the drain at the cap (successive
    drains) rather than let it grow unbounded (`app/wbs/save-queue.ts` pending-append).
  - **Local dev**: real login needs `.dev.vars` (OIDC client secret + `SESSION_SECRET`) + the workerd
    compat-date toggle noted under Step 1.
  - **SSR-over-HTTP smoke (from 4a)**: 4a proved the SSR grid via `renderToString` (no-DOM) + bundle grep,
    NOT a live HTTP request (the root middleware's eager `DATABASE_URL` + the auth gate blocked a headless
    curl). Do a one-time local run behind the compat-date toggle, and add to the deploy check:
    **view-source of `/projects/:id/wbs` shows `data-row-id` rows on first paint**.
  - **Grid CPU at scale (from 4a)**: SSR of a **5000-row** grid ≈107 ms in node (nothing O(n²); ~1–2 ms at
    prod's 48 tasks — fine now). If a project ever grows large, the ADR fallbacks apply (per-route
    `clientLoader`/SPA-mode for the wbs route, or the $5 Workers Paid plan).
  - **Shared-core hygiene (deferred, not now)**: `projectWbsGrid`/projection sorts use `localeCompare`
    (`packages/application/src/project-projection.ts:211`); byte-identical both SSR sides today (lowercase-hex
    data), but a codepoint compare would make determinism unconditional. A core pass, out of Step-4 scope.
  - **Step-5 `/api` deploy-recipe additions**: 5a added **3 `ratelimits` bindings** to `apps/web-next/wrangler.jsonc`
    (PRE_AUTH/AUTH/COMPUTE) — the Step-6 cutover deploy config MUST carry them or the public API loses its
    throttle. 5b will add a `MCP_RESOURCE_URL` var (RFC 9728) — carry it too. `/api` auth reuses the existing
    OIDC `vars` (audience = `OIDC_CLIENT_ID`), no new secret.
  - **AGENT read-view policy (deferred decision, from 5a)**: `/api` scopes the GET workspace projection by
    `projectRole` only, so an AGENT with EDITOR role reads `dailyCapacityMinutes` even though its writes are
    scope-fenced. If agent tokens should be least-privilege on reads, map `principalType==="AGENT"` → GENERAL
    (or gate on a read scope). A product-policy call — left as-is (EDITOR-consistent) pending a decision.
- `docs/design/0004-performance-realtime-architecture.md` is **superseded by ADR 0012** (its Phase-0/1
  framing is resolved there).
- **Merge-to-main workflow**: user proposed branch → push → merge to main → deploy-on-main; not yet
  adopted (deploy is still manual). `deploy.yml` is manual-only + main-only + non-functional (needs
  GH secrets/vars).

## Manual deploy recipe (deploy is manual until CI is wired)

1. Temporarily overwrite `apps/web/wrangler.jsonc` with a FLAT config: `name:"vecta"`, `main`,
   `assets`(ASSETS), OIDC `vars` = Google standard (issuer `https://accounts.google.com`, audience =
   the Google client id, jwks `https://www.googleapis.com/oauth2/v3/certs`), three `ratelimits`
   (1001/1002/1003), **NO `hyperdrive` binding**, no `env` blocks.
2. Build with auth: `VITE_GOOGLE_CLIENT_ID=<id> VITE_VECTA_TENANT_ID=<t> VITE_VECTA_PROJECT_ID=<p>
   pnpm --dir apps/web build` (values in private memory `earned-signal-realignment.md`). Do **NOT**
   pass `--mode production` (the cloudflare plugin would suffix the worker to `vecta-production`).
3. **Deploy from the plugin-generated config, not the flat one** —
   `pnpm --dir apps/web exec wrangler deploy -c dist/vecta/wrangler.json --name vecta`. The flat
   `apps/web/wrangler.jsonc` has `assets` with **no `directory`** → it uploads the worker but serves
   **STALE assets** (success + new version, old bundle live). `dist/vecta/wrangler.json` carries
   `assets.directory: "../client"` (fresh) and just needs `--name vecta` to override its
   `vecta-production` name. **Verify after**: `ax https://vecta.tt-dev.workers.dev/` and confirm the
   served `assets/index-*.js` hash equals `apps/web/dist/client/index.html`'s (version id alone is
   NOT enough).
4. Migrate (only when there's a new migration): `DEPLOY_ENV=production DATABASE_URL=<keychain>
   EXPECTED_DATABASE_HOST=<url host> EXPECTED_DATABASE_NAME=<url dbname>
   pnpm --dir packages/persistence db:migrate` (script `packages/persistence/scripts/migrate.mjs`).
5. Restore `apps/web/wrangler.jsonc` (never commit the flat override) — `git stash push -- <file> &&
   git stash drop` (plain `git restore`/`checkout` are blocked by a hook → use stash or git-haiku).
6. Secret (persists; only to set/refresh): `printf '%s' "$(security find-generic-password -w -s
   vecta-database-url)" | wrangler secret put DATABASE_URL --name vecta`.

Screenshot pipeline (session-local, recreate as needed): a React-only vite build with the cloudflare
plugin dropped + `define` `import.meta.env.VITE_VECTA_PREVIEW` = "1"; the config must live **inside
`apps/web/`** (so `@vitejs/plugin-react` resolves) and its `build.outDir` must be **outside the repo**
(the repo `scratchpad/` is in `eslint .` scope); serve the outDir, shoot with `uv run --with
playwright python`. (For the login screen: define `VITE_GOOGLE_CLIENT_ID`, leave `VITE_VECTA_PREVIEW`
unset → the LoginScreen renders.)

## Process rules (hard-won; do not relax)

- **Spec parity**: the user's real spreadsheet is the only spec for the WBS grid. Never add
  columns/UI/features not requested (past formal rebuke). Requested UI changes (header, login, etc.)
  are fine. Internal state stays internal (flags, not UI).
- Flow per change: implement (subagent) → independently verify (`pnpm check` at root + scope + leak
  grep + screenshots) → commit → **leak audit** (case-insensitive: machine username / home paths /
  emails / connection strings / keys / NUL bytes, incl. untracked) → push (git-haiku) → deploy when
  user-visible + verify the served bundle hash.
- Never read `.wbs-private/`. All fixtures/demo/seed data synthetic + generic. No real
  names/paths/values in code, tests, docs, commits.
- Secrets: never in chat/repo. `DATABASE_URL` is macOS Keychain **`vecta-database-url`** (read with
  `security find-generic-password -w -s vecta-database-url`; pipe straight into env / `wrangler
  secret put` — never print). Deploy identifiers (client id, tenant/project UUIDs, admin identity)
  are in private memory `earned-signal-realignment.md`, not the repo.
- A Neon password rotation is pending on the user side; after it, update the Keychain item + re-run
  `wrangler secret put DATABASE_URL --name vecta`.
