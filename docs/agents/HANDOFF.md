# HANDOFF — VECTA (updated 2026-07-26)

Session-recovery state — **kept lean on purpose**. Three rules keep it that way:

1. Only what's needed to CONTINUE lives here. Completed history goes to
   `docs/agents/HANDOFF-archive.md`, which is **not** read during normal work.
2. Specs, designs and survey results do **not** go here — they go to `docs/design/`, `docs/adr/`,
   `docs/research/`. This file carries pointers to them, not their content.
3. Write the handoff and `/clear` **before** context reaches 50%, and before starting a large piece of
   work — not after.

Roles: **main (Opus 5) designs AND implements**; **Fable is advisor only** (`/advisor fable` — design and
security second opinion, never writes code); Codex takes self-contained implementation; Sonnet takes
mechanical work; git state changes go to git-haiku. See `~/.claude/skills/delegation/SKILL.md`.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta`, remote `git@github.com:asriel-dev-apps/vecta.git`.
  `main` carries everything; work continues on `adr-0011-effort-wbs-realignment` and merges via PR.
- Governing docs (read as needed):
  - `docs/adr/0011-effort-based-wbs-evm-realignment.md` — the realignment decision.
  - `docs/design/0002-step2-effort-wbs-grid.md` — data model (**§12 advisor decisions authoritative**).
  - `docs/design/0003-wbs-ui-realignment-backlog.md` — the P0–P3 feature backlog (P0–P2 done).
  - `docs/design/0004-performance-realtime-architecture.md` — **perf/real-time direction (DRAFT,
    not approved)**; principles + Phase 0/1 plan; work through with the user before building Phase 1.
- Private master requirements are outside the repo in `../.wbs-private/` — **never read it**.

## Current live state

- **Live: https://vecta.tt-dev.workers.dev** — React Router v8 SSR + Hono `/api` + `/mcp` on one Cloudflare
  Worker (`vecta`). Auth = server-side Google OIDC authorization-code flow → httpOnly signed cookie session.
  Persistence = Neon (`ap-southeast-1`, direct endpoint), reads over SQL-over-HTTP, writes over the WS pool.
- **ADR 0011 + ADR 0012 are COMPLETE**, merged to `main`, cutover and retirement done, and all of the
  cutover runbook's Phase 5 verification is closed. The narrative is in `HANDOFF-archive.md` — **do not read
  it during normal work**.
- **Deploy is CI-only**: merge to `main` → `deploy.yml` → a human approves the `production` Environment.
  Process: `docs/operations/release-and-rollback.md`. Never deploy by hand.
- DB schema at migration **0006** (7 applied). Prod project holds 48 synthetic tasks (generic
  "Phase A"/"Product 1"/"Member 01"), 8 processes / 6 products / 6 members / 2 templates / 32 deps.
- Gate: domain 32, application 70, persistence 46, web 264, operations 17.

## How to work here (standing rules, set 2026-07-26)

- **Proceed autonomously.** Ask the user only about (a) genuinely undecidable, foundation-overturning
  matters and (b) up-front requirements gathering. Decide implementation questions yourself and report
  the decision with the result. Do not stop to ask "which would you prefer".
- **After each finished task, produce the HTML + PDF progress report** (`progress-report` skill →
  `docs/reports/<date>-<slug>/`). This is the user's only sync point now that per-step confirmation is
  gone, so it is mandatory, and it must include what failed and what is still unverified.
- **Large diffs get `diff-review`** (two-stage: a reviewer that has NOT seen the plan goes first).
- **Anything that blocked autonomy** (a skill, hook, or permission) goes into `~/.claude/friction-log.md`
  with its frequency. Never edit settings yourself.
- **E2E / seeing the screen is authorised**: install Playwright, and build a staging environment if one is
  needed — but it must **not** be publicly reachable. Prefer local (`wrangler dev` + Playwright) so nothing
  is exposed at all. For authenticated screens, **never add a test-only login bypass to product code**;
  have the test mint a properly signed session cookie with the local `SESSION_SECRET` instead.

## Active work — in this order

1. **Round-trip reduction 3 → 2** (user-requested, agreed). Fold the access gate's project-row read into the
   workspace batch: the workspace header already carries the project row, so the gate's separate read is
   redundant. Worth ~70 ms per navigation (Tokyo↔Singapore is the floor — see the debt list). **Touches
   fail-closed access-gate code that had a security review** — keep 404-vs-403 indistinguishability, and keep
   "deny before any child loader runs". Main implements; Fable reviews the design before merge.
2. **LLM-driven operation via the command core** (ADR 0012 "(D) vision features"). **Requirements not yet
   taken** — do NOT start implementing. Open questions for the user: what should it be able to do (read-only
   Q&A over the WBS? propose edits? apply them?), who approves a proposed change, and whether it runs in the
   browser or through `/mcp` (which already exposes list/get/apply as an agent surface). Write the spec to
   `docs/design/` and the decision to `docs/adr/` — not into this file.
3. **Client/server boundary — enforce it structurally** (user: "絶対に防ぎたい"). Measured 2026-07-26: the
   client bundle leaks **nothing** (14 patterns — secret names, `drizzle`/`neondatabase`/`pg`/`jose`, server
   identifiers — all zero). But nothing *enforces* that; only the `.server.ts` suffix does any work.
   **`app/server/` does not mean server-only** — `app/server/project/self-save-revalidation.ts` really is
   shipped as `build/client/assets/self-save-revalidation-*.js`, and correctly so (`shouldRevalidate` runs in
   the browser). The directory name is lying, which is exactly the shape of a future leak. Files under
   `app/server/` with no `.server` suffix: `api/*`, `auth/{id-token,oidc-config,principal-directory,redirect,
   require-principal,pkce}.ts`, `context.ts` — reachable only from `workers/app.ts` today, by convention not
   enforcement. Build **both** gates: (a) an artifact scan of `build/client/**` against a denylist, wired into
   `pnpm check` + CI — it inspects what users actually receive, so no source-level trick evades it; (b) an
   ESLint import restriction so client-reachable modules may only `import type` from `~/server/**` — it fails
   earlier and names the culprit. One without the other is insufficient. Also move genuinely isomorphic code
   out of `app/server/`.
4. **Periodic architecture review** (standing): check code style and directory layout against the
   language/framework's current best practices *and* this project's own constraints (CLAUDE.md, ADRs). Needs
   web research, so **not delegable to Codex** (no network in its sandbox). Output to `docs/research/`.
5. **Security review** (user-requested): pnpm supply-chain posture, GitHub Actions compromise vectors
   (third-party actions, `pull_request_target`, token scopes, artifact/secret exposure), and an OWASP-informed
   pass over the app. Survey output goes to `docs/research/`, findings to a doc — not here. Note the repo is
   **public**. The local `sec-scan` skill covers app vulns + pre-push leak audit; the CI/supply-chain half is
   not its remit. Codex's sandbox has **no network**, so web survey must not be delegated to it — give Codex
   the offline repo/config analysis and do the research elsewhere.

## Carried debt (none of it blocking)

- **ADR 0012 debt**:
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
