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
- **Shipping is IN SCOPE, up to the approval gate** (user, 2026-07-26): finish a change by opening the PR,
  waiting for CI, merging to `main` with a **merge commit** (`gh pr merge --merge`; main's history uses them),
  and leaving the branch alive. Do not stop at "pushed to the branch". The `production` Environment has a
  `required_reviewers` rule, so the deploy then sits at `waiting` for the user's click — **that click is
  theirs; do not approve it**. Report the run URL and carry on with the next item meanwhile.
- DB schema at migration **0006** (7 applied). Prod project holds 48 synthetic tasks (generic
  "Phase A"/"Product 1"/"Member 01"), 8 processes / 6 products / 6 members / 2 templates / 32 deps.
- Gate: domain 32, application 70, persistence 46, web 268, operations 23.
- **The client/server boundary is ENFORCED as of 2026-07-26**, by two gates that must both stay wired:
  `.github/scripts/verify-client-bundle.mjs` (scans the built `apps/web/build/client`; authoritative, since it
  inspects what users receive) runs from `pnpm verify:bundle` at the tail of `pnpm check`, so CI and the
  deploy gate both run it; and `eslint.config.js`'s `clientServerBoundary` blocks (client-reachable modules may
  only `import type` from `~/server/**` and the server-only packages; route modules may call server modules but
  may not import a driver). Both were verified by making them FAIL — see the commit. The scanner self-checks
  its own rules and refuses to pass on a bundle it did not actually read.
- **A `/projects/:id/*` document request costs TWO sequential Neon round trips** (principal batch, then the
  workspace batch) — the 2026-07-26 fold. The gate no longer reads the project row on its own: the workspace
  batch's header IS that row. Do not reintroduce a separate project-row query.

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

0. **DATED, cheap: set `minimumReleaseAge: 10080` in `pnpm-workspace.yaml` — on or after 2026-07-29.**
   User decided the value (7 days) on 2026-07-26; only the timing is deferred. **Do not set it earlier**:
   measured that day, `pnpm install --frozen-lockfile` fails `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
   (exit 1) on four transitive entries the current lockfile pins — `fast-uri@3.1.4` (2026-07-19),
   `p-map@7.0.6` (07-20), `prettier@3.9.6` (07-21), `@cloudflare/codemode@0.4.4` (07-22). They age past
   seven days by 07-29, at which point the value lands with **no lockfile diff at all**, which is the whole
   point of waiting — re-resolving the lockfile to force it would churn the dependency tree for no security
   gain. Procedure: add the key, run `pnpm install --frozen-lockfile` (must exit 0), then `pnpm check`, then
   PR as usual. If a NEW fresh transitive has appeared by then, wait again rather than re-resolving.
   - **The unit is MINUTES**, and pnpm 11's built-in default is 1440 (one day) — so today's posture is a
     default nobody chose, not an absence of protection. 10080 = 7 days.
   - **`minimumReleaseAgeExclude` entries carrying `@version` are version-specific in practice**, contrary
     to the docs' "matched by package name, applies to all versions". Measured: `@cloudflare/codemode@0.4.3`
     is in the list and `0.4.4` was still rejected. All six existing entries carry versions, so **do not read
     them as "this package is exempt"** — they exempt exactly the pinned version.
   - `ignore-scripts` needs NO change and should not be added: pnpm 10+ blocks dependency lifecycle scripts
     by default and `allowBuilds` is the explicit allowlist. `node_modules/.modules.yaml` shows
     `ignoredBuilds: []` / `pendingBuilds: []`, i.e. every dependency with a build script has an explicit
     true/false decision. A blanket `ignore-scripts=true` would be strictly worse — it would also break
     esbuild / workerd / sharp, which legitimately need to place binaries.
1. **LLM-driven operation via the command core** (ADR 0012 "(D) vision features"). **Requirements not yet
   taken** — do NOT start implementing. Open questions for the user: what should it be able to do (read-only
   Q&A over the WBS? propose edits? apply them?), who approves a proposed change, and whether it runs in the
   browser or through `/mcp` (which already exposes list/get/apply as an agent surface). Write the spec to
   `docs/design/` and the decision to `docs/adr/` — not into this file.
2. **Periodic architecture review** (standing): check code style and directory layout against the
   language/framework's current best practices *and* this project's own constraints (CLAUDE.md, ADRs). Needs
   web research, so **not delegable to Codex** (no network in its sandbox). Output to `docs/research/`.
3. **Security review** (user-requested): pnpm supply-chain posture, GitHub Actions compromise vectors
   (third-party actions, `pull_request_target`, token scopes, artifact/secret exposure), and an OWASP-informed
   pass over the app. Survey output goes to `docs/research/`, findings to a doc — not here. Note the repo is
   **public**. The local `sec-scan` skill covers app vulns + pre-push leak audit; the CI/supply-chain half is
   not its remit. Codex's sandbox has **no network**, so web survey must not be delegated to it — give Codex
   the offline repo/config analysis and do the research elsewhere.

## Open question for the user (asked 2026-07-26, unanswered)

- **Can production latency be measured, and how?** Asked by the user; answered but NOT yet built. Three
  options, in descending fidelity: (a) emit a `Server-Timing` response header with each DB round trip's
  duration — the ONLY way to get the real Tokyo→Singapore number, small and standard, durations only so
  nothing sensitive crosses; (b) TTFB of `/projects/:id/wbs` from outside, which needs a real signed-in
  session (a credential — do not ask the user to hand one over); (c) time both `db.batch` calls locally
  against real Neon with the Keychain `DATABASE_URL`, which measures the count for real but from the wrong
  origin. **Recommended: (a).** It is a product change to a live app, so it was left for the user to green-light
  rather than shipped as a side effect of a perf task. Until then, the "~70 ms saved" figure stays an
  ARITHMETIC ESTIMATE (round trips removed × the measured 70 ms floor), not a production measurement.

## Carried debt (none of it blocking)

- **Isomorphic code still sits under `app/server/`** (unfinished half of the boundary work). The two new gates
  stop server code reaching the browser, but they do not fix the misleading directory:
  `app/server/project/self-save-revalidation.ts` is genuinely client code (`shouldRevalidate` runs in the
  browser) and really is shipped as `build/client/assets/self-save-revalidation-*.js`. The eslint block
  exempts `app/server/**` from its own rule, so nothing flags it. **Trigger: move it (and anything else under
  `app/server/` that the bundle proves is client-reachable) out, the next time that file is touched** — check
  by listing `apps/web/build/client/assets` for names matching modules under `app/server/`.

- **`/projects/:id/dashboard` reads a whole workspace for one project name** (from the 2026-07-26 fold;
  confirmed by the Fable review). It is a Step-4 stub (`ダッシュボードは Step 4 で実装します`), but the nav
  tabs carry `prefetch="intent"` (`app-bar.tsx:231`), so **hovering the ダッシュボード tab is enough to fire
  the full 8-query batch**. Left alone deliberately: fixing it means resurrecting the project-row reader the
  fold just deleted, purely for a stub, and the real dashboard (EVM) will read the workspace anyway.
  **Trigger: resolve it when the dashboard is actually implemented, as part of designing that screen's read.
  If it ever ships still showing only the name, the lightweight query has to come back first.** Note the sole
  production consumer of `requireProjectAccess` is now this route — tidy both together.
- **Write path: a deleted project answers a member's POST with a DIFFERENT 404 body than the gate's**
  (from the 2026-07-26 fold; found by the Fable review). `runCommandAction` now reads the membership
  synchronously, so it no longer throws the gate's opaque `data(null, {status:404})` on the way in; a member
  whose project row was deleted reaches `applyCommands` and gets `{ ok:false, code:"NOT_FOUND" }` at 404.
  **Not fixed on purpose**: that response shape is pre-existing (the same race was reachable before, between
  the row read and the transaction) — the fold only widened the window — and it is a TYPED client contract
  (`wbs-app.tsx:532`, `master-app.tsx:49`) feeding the save queue's graceful rollback, so throwing an opaque
  404 instead would turn a rollback into an error boundary. It leaks nothing: only a (former) member of that
  project can observe it, `project_memberships` cascades on project delete, and the next request 404s at the
  gate. **Trigger: revisit if the write path's error contract is redesigned, or if an audit demands
  byte-identical 404s across read AND write.**
- **`packages/persistence` integration tests flake on THIS Mac under file parallelism.** Each of the 8 test
  files starts its own `PostgreSqlContainer`; `beforeAll` gets 60 s but the tests keep vitest's 5 s default,
  and under 8 concurrent containers `subtask-generation.test.ts` blows through it (then cascades:
  `current transaction is aborted`). Reproduced twice on 2026-07-26; `pnpm vitest run --fileParallelism=false`
  passes 46/46, and **CI is green** (ubuntu-latest, ~2 min). So it is an environment limit, not a code defect
  — but it makes a local `pnpm check` unreliable. **Trigger: fix (raise `testTimeout` for the container-backed
  files, or cap `maxWorkers` for the package) the first time CI itself flakes on it, or the first time it
  blocks a verification you cannot otherwise complete.**
- **ADR 0012 debt**:
  - **web Neon-reader debt**: `apps/web` has a direct `drizzle-orm` dep for ONE remaining thin Neon read-seam
    that imports persistence schema/conn: `app/server/auth/principal-directory.neon.server.ts`. (The second
    one, `project-reader.neon.server.ts`, was deleted 2026-07-26 by the round-trip fold — the gate reads the
    workspace instead.) Consider moving that Drizzle impl into `@vecta/persistence` (beside
    `project-access.ts`/`project-list.ts`), keeping the `PrincipalDirectory` interface in the app, and
    dropping the direct `drizzle-orm` dep. The project-list read already lives in persistence (the right
    precedent). Interim: keep both `drizzle-orm` pins (0.45.2) in lockstep.
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
