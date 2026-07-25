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
- **DB schema at migration 0006** (Neon, prod; 7 applied): `tasks` model + `members` + project-scoped masters
  `processes`/`products` + `subtask_templates`; review/change refs and `daily_plan_locked` dropped.
- **Prod project holds 48 synthetic test tasks** (8 phases × 5 subtasks) + 8 processes / 6 products /
  6 members / 2 default templates / 32 deps (all generic "Phase A"/"Product 1"/"Member 01"); admin
  membership intact (revision 11). Replaced the earlier junk stubs.
- Full gate green (domain 32, application 70, persistence 46, web 264, operations 17). `ci.yml`
  (checks-only) runs on every push + PRs; `deploy.yml` deploys `main`.

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
- **Post-cutover — read-path latency (`e501ef5`, DEPLOYED, worker version `60a2a77c`)**. Every screen took ~1 s from click to
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
  - **Deployed and fully verified.** The credential-free checks (asset graph vs. build, `/api/health`, RFC 9728
    metadata `resource`, unauth `POST /mcp` 401) are now codified in `.github/scripts/verify-deployment.mjs` and
    run on every deploy. The three that need a browser session — login round trip, SSR no-flash, one write —
    were confirmed by the user on 2026-07-26. **All of runbook Phase 5 is closed.**
  - **The remaining ~200 ms has a floor we cannot move**: the Neon project is in **`ap-southeast-1` (Singapore)**
    and a Neon project's region is fixed at creation. Tokyo↔Singapore is ~70–90 ms per round trip, so 3 round
    trips ≈ 210 ms. **Neon has no Tokyo region** (AWS: Asia is Singapore and Sydney only), so there is nowhere
    closer to move. This is also the arithmetic that confirms the original diagnosis: ~14 round trips × ~70 ms
    ≈ the 1 s that was reported. Options, none of them free wins:
    **(a)** 3 → 2 round trips by folding the access gate's project-row read into the workspace batch (the
    workspace header already carries the project row) — best value, but it touches security-reviewed gate code.
    **(b)** Cloudflare `placement` to run the Worker beside the DB — free and one line, but it trades 3 DB
    round trips for 1 user round trip, so at 3 it barely wins and **after (a) it is a wash**; they do not stack.
    **(c)** 1 round trip by resolving principal + membership + project + workspace in a single statement — the
    theoretical floor (~70 ms), much larger change.
    Prefetch-on-intent (below) already hides all of this on hover, which is why none of these is urgent.
  - **Prefetch-on-intent** (`8358635`): the nav tabs, the back link, and the project cards carry
    `prefetch="intent"`, so the round trip happens during the hover that precedes a click and the switch feels
    immediate. The clicks it cannot cover (touch, keyboard Enter) get a pending affordance instead of a frozen
    screen — `isPending` on the tab, the pending location on the card, both growing the same accent rail.
  - Deliberately NOT done: hoisting the workspace read to the `/projects/:id` layout so sibling tab clicks skip
    the fetch entirely. RR would not revalidate the layout loader on a sibling nav (`defaultShouldRevalidate`
    false: same pathname, same params) — which is exactly the problem: `skipRevalidationOnSelfSave` also keeps it
    stale after a self-save, so tab-switching would show the pre-edit snapshot. It needs the client state lifted
    to the layout (the SPA's in-memory tab model) first, which is a real refactor of the optimistic pipeline.
- **ADR 0012 Step 6 (CUTOVER) — COMPLETE, including retirement.** `https://vecta.tt-dev.workers.dev` serves the
  SSR app. The old SPA is deleted and `apps/web-next` is renamed **`apps/web`** (package `@vecta/web`, local
  wrangler name `vecta-local`); `scripts/verify-beta-readiness.mjs` and the SPA-only `verify-web-build` /
  old `materialize-deploy-config` scripts are gone with it. The runbook
  (`docs/agents/adr-0012-step6-cutover-runbook.md`) is retained as executed history only — the live process is
  `docs/operations/release-and-rollback.md`. **(D) vision features** (Gantt, dashboard, budget, CSV, member
  admin, LLM-via-commands) are follow-on work. Real-time = Phase 1 (Cloudflare DO + WebSocket, free) later.
- **Deploy is CI-driven (deploy.yml rewritten).** `main` → deploy; that is the only path, and `--tag $GITHUB_SHA`
  makes the live version traceable to a commit. The job runs `pnpm check` itself (a deploy cannot outrun its own
  gate), materializes config into the BUILD output (never the tracked `wrangler.jsonc`), deploys, then runs
  `.github/scripts/verify-deployment.mjs` — the served asset graph vs. the build (a version id does NOT prove
  users got the new bundle), `/api/health`, the RFC 9728 metadata `resource`, and the unauth `POST /mcp` 401
  challenge. **Live**: the branch is merged (PR #29), GitHub Environment `production` holds the token + 13
  variables, and the environment has **required reviewers** — so a merge queues a deploy that a human must
  approve in Actions. Three things broke on the first run and are fixed: the lockfile was not regenerated for
  the `apps/web-next`→`apps/web` rename; `worker-configuration.d.ts` depended on a local `.dev.vars`
  (`types:worker` now passes `--env-file worker-types.env`, which REPLACES that default); and the post-deploy
  check did not follow `/`'s 302 to `/login` (it now follows same-origin redirects only).
- **ADR 0012 debt** (carried, not blocking):
  - **web-next Neon-reader debt**: `apps/web` has a direct `drizzle-orm` dep + two thin Neon read-seams that
    import persistence schema/conn: `app/server/auth/principal-directory.neon.server.ts` and
    `app/server/project/project-reader.neon.server.ts`. Consider moving both Drizzle impls into
    `@vecta/persistence` (beside `project-access.ts`/`project-list.ts`), keeping the
    `PrincipalDirectory`/`ProjectReader` interfaces in the app, and dropping the direct `drizzle-orm` dep. The
    project-list read already lives in persistence (the right precedent). Interim: keep both `drizzle-orm`
    pins (0.45.2) in lockstep.
  - **Save-queue 1000-command cap (from 4d, deferred)**: the coalescing pending buffer can exceed the
    `CommandBatchSchema` 1000-command cap under sustained heavy reorders queued behind a slow save → the drain
    422s and the queue is erased. Low-probability. Follow-up fix = chunk the drain at the cap (successive
    drains) rather than let it grow unbounded (`app/wbs/save-queue.ts` pending-append).
  - **Local dev**: real login needs `.dev.vars` (OIDC client secret + `SESSION_SECRET`) + the workerd
    compat-date toggle noted under Step 1. After the 2026-07-25 Neon password rotation, `.dev.vars`'s
    `DATABASE_URL` is stale if it ever held a real value — local dev will fail to connect until it is updated
    (prod is unaffected; its secret was rotated). `wrangler types` no longer reads it (see `worker-types.env`).
  - **Repo leftovers from the SPA era**: the GitHub `staging` Environment and the `GOOGLE_CLIENT_ID` /
    `PRODUCTION_TENANT_ID` / `PRODUCTION_PROJECT_ID` variables are unreferenced by `deploy.yml`. Deleting the
    environment is irreversible, so it was left for the user to decide.
  - **SSR-over-HTTP smoke (from 4a) — CLOSED 2026-07-26.** View-source of the live
    `/projects/:id/wbs` carries **37 `data-row-id` rows in the first-paint HTML**, which is exactly the
    server-side virtual window: `initialRect` height 720 ÷ `ROW_H` 30 = 25 rows (including the partial one)
    plus `overscan` 12. Not 48 — the grid is virtualised, so 48 would mean virtualisation was NOT working.
    Only a signed-in browser can produce this evidence (the auth gate blocks a headless request), so it
    stays a manual check after any change to the virtualizer seeding.
  - **Grid CPU at scale (from 4a)**: SSR of a **5000-row** grid ≈107 ms in node (nothing O(n²); ~1–2 ms at
    prod's 48 tasks — fine now). If a project ever grows large, the ADR fallbacks apply (per-route
    `clientLoader`/SPA-mode for the wbs route, or the $5 Workers Paid plan).
  - **Shared-core hygiene (deferred, not now)**: `projectWbsGrid`/projection sorts use `localeCompare`
    (`packages/application/src/project-projection.ts:211`); byte-identical both SSR sides today (lowercase-hex
    data), but a codepoint compare would make determinism unconditional. A core pass, out of Step-4 scope.
  - **Connection pooling — deferred, and it is NOT a one-line switch (decided 2026-07-25)**: `DATABASE_URL` is
    Neon's **direct** endpoint (no `-pooler`). Fine at today's scale: reads go over SQL-over-HTTP and consume no
    Postgres connection at all, and the WS pool is opened lazily, only for writes, at most one per request. It
    stops being fine when concurrent **writes** approach the compute's `max_connections` (104 on 0.25 CU, 97
    usable after 7 reserved for Neon) — past that, `FATAL: remaining connection slots are reserved`. Pooling is
    free and the pooled endpoint is always live; the Console's toggle only switches which string it *displays*
    (on by default for new projects, which is why it can look like it changed itself). Neon's own guidance is
    app → pooled, schema migrations → direct. Switching is **three** changes, not one:
    1. Worker secret `DATABASE_URL` → the pooled string.
    2. A SEPARATE direct string for migrations (a second Keychain item), because Neon's PgBouncer runs
       `pool_mode=transaction`, which explicitly does not support **session-level advisory locks** — exactly what
       `packages/persistence/scripts/migrate.mjs` uses (`pg_try_advisory_lock`/`pg_advisory_unlock`). Through the
       pooler that lock silently protects nothing; concurrent migrations would not be excluded and no error is
       raised.
    3. A guard in `migrate.mjs` that REFUSES a `-pooler` host, so that silent failure becomes a loud one. It
       already validates `EXPECTED_DATABASE_HOST`, so this is the same shape of check.
    Also verify the neon-http read driver against a `-pooler` hostname before switching (unconfirmed).
  - **AGENT read-view policy (deferred decision, from 5a)**: `/api` scopes the GET workspace projection by
    `projectRole` only, so an AGENT with EDITOR role reads `dailyCapacityMinutes` even though its writes are
    scope-fenced. If agent tokens should be least-privilege on reads, map `principalType==="AGENT"` → GENERAL
    (or gate on a read scope). A product-policy call — left as-is (EDITOR-consistent) pending a decision.
- `docs/design/0004-performance-realtime-architecture.md` is **superseded by ADR 0012** (its Phase-0/1
  framing is resolved there).
- **Merge-to-main workflow — ADOPTED** (user decision): branch → push → merge to `main` → `deploy.yml`
  deploys automatically. Do not deploy by hand any more; if you must (an emergency where CI is down),
  the only safe shape is build → `.github/scripts/materialize-deploy-config.mjs` → `wrangler deploy -c
  build/server/wrangler.json` → `.github/scripts/verify-deployment.mjs`, and NEVER by editing the
  tracked `wrangler.jsonc`.

## Deploy

`docs/operations/release-and-rollback.md` is the source of truth (trigger, materialize, verify,
Environment secret/vars, migration, rollback). Nothing about deploying belongs in this file.

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
