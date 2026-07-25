# HANDOFF — VECTA (updated 2026-07-21)

Session-recovery state for continuing work with a fresh context. Advisor = Fable (design,
acceptance, commits/pushes/deploys after audit); implementation = opus/codex subagents.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta` (renamed from earned-signal; remote
  `git@github.com:asriel-dev-apps/vecta.git`), branch **`adr-0011-effort-wbs-realignment`**,
  pushed through `4c5a864`; the P0 B-series is committed **locally** on top (through
  `3faf769`, not yet pushed — see "P0 progress" below).
- Governing docs (read in this order):
  1. `docs/adr/0011-effort-based-wbs-evm-realignment.md` — the realignment decision.
  2. `docs/design/0002-step2-effort-wbs-grid.md` — data model; **§12 advisor decisions are
     authoritative** over §3/§7.
  3. `docs/design/0003-wbs-ui-realignment-backlog.md` — **current work queue**: user feedback
     (2026-07-21) + recorded answers. This is what to implement next.
  4. `docs/cross-project-load.md`, `docs/deployment-architecture.md` — feature/deploy notes.
- Private master requirements live outside the repo in `../.wbs-private/` (**never read it**;
  the generic specs in the docs above are sufficient and contain everything needed).

## What is built (all `pnpm check` green at `4c5a864`)

- ADR 0011 MVP steps ①–⑦ complete: single self-referential `tasks` model (23 worksheet
  columns), effort EVM pure module + goldens, deterministic capacity scheduler + daily plan,
  subtask templates with largest-remainder proration (leaf-only EVM), TanStack two-axis
  virtualized grid (Japanese labels, light/dark), tree + drag, two-role field projection.
- Auth + DB: Google OIDC sign-in (redirect flow), Neon serverless driver path
  (`DATABASE_URL` secret) alongside pg/Hyperdrive, admin seed (`db:seed`, email-keyed
  principal + verified-email fallback resolver).
- Deployed: **https://vecta.tt-dev.workers.dev** (worker `vecta`, Google OIDC vars, Neon
  secret set; migrations 0000+0001 applied and admin seeded on Neon). Static demo preview
  also exists as worker `vecta-preview` (to be retired by A-1 below).

## Next work — implement `docs/design/0003` (answers §"確認事項の回答" are final)

Order proposed: **P0** spreadsheet parity (B-1 drop non-spreadsheet columns [review/change
refs, weight col UI], B-2 estimate columns, B-3 read-only computed cells, B-4 grouped
band headers + totals strip, B-5 month/day date bands + grey weekends/holidays + distinct
paid-leave colour + non-editable, C-2 **one-shot** initial placement + row validation
warnings replacing the lock concept entirely, C-3 drag-reorder only [re-parent removed],
D-1 toolbar removals, A-1 auth-required) → **P1** tail-row entry + subtask mode/template UI
→ **P2** project-scoped master/template screens (+ dropdowns) → **P3** unique numbering
(F-1, approved) + member daily-total bottom panel (G-1 option a).

Backend consequences of C-2: remove the continuous `applyEffortSchedule`/re-proration from
the write path (initial values only at generation); surface parent≠Σchildren and L≠Σdaily
as projection-level warnings; drop `daily_plan_locked` (destructive migration 0002 is fine,
but it must run against the live Neon DB at deploy).

## P0 progress — session 2026-07-21 (local commits on the branch, NOT pushed yet)

Done + committed (all `pnpm check`-green for lint/typecheck/test; `apps/web` only):
- **B-1** `a27f246` — dropped the review-ref / change-ref / weight columns from the grid
  UI (proration weight kept internal per C-5). Data model for review/change untouched here.
- **B-2/B-3** `938eb3e` — verified no functional change was needed: 工数(人時) is the input
  estimate, 工数(人日)=L/8 read-only (worksheet order K before L kept); every computed column
  is already `editable:false`; computed cells already read as grey `--derived-bg`.
- **B-4** `b005c30` — replaced the 8 KPI tiles with a compact totals strip and added the
  two-row grouped EVM header. Band→column map (confirmed by user against the sheet):
  見積り[工数人日,工数人時] · BAC[計画工数] · PV[計画進捗,進捗率計画,開始予定,終了予定] (green)
  · EV[開始日,終了日,進捗率,ステータス,実績進捗] (yellow) · AC[実績投入] (orange) · CV[コスト差異]
  (magenta); 見積り/BAC neutral slate/blue. `BANDS` derived from `NON_PINNED` offsets.
- **band colour placement** `66c9676`→`3faf769` — user feedback: the band colour belongs on
  the **column-name header cells** directly under each band (one coloured header block per
  band), NOT washed across the body data cells. Body + status pills stay neutral/semantic.
- **B-5** `3faf769` — two-row date header (month band `YYYY-MM` + day-of-month), weekend/
  holiday columns greyed + non-editable, per-assignee paid-leave in violet + non-editable.
  Editability gate is `locked && editable && !nonWorking && !paidLeave` (composes with C-2's
  lock removal). Synthetic demo holidays/paid-leave added so all states show in preview.
- **C-2 core** `14c6b6c` — retired the daily-plan lock + continuous scheduler. Daily plans
  are placed once at `task.generateSubtasks` (scoped to the new children via set-diff) and
  hand-edited thereafter; the write path (`project-command-unit-of-work`) and preview
  (`App.executeCommands`) only reschedule for that command. `dailyPlanLocked` removed across
  all layers + the ロック grid column/toggle/gate; daily cell editable = `editable &&
  !nonWorking && !paidLeave`. Destructive **migration 0002** drops `daily_plan_locked`
  (generated + snapshot; NOT run on live Neon). Domain scheduler keeps an internal
  `fixedDailyPlan` input (a fixed-fact plan that anchors placement — not a user lock).
  Non-blocking row warnings added: projection flags `parentEffortMismatch` (summary L ≠ Σ
  children L) + `estimateVsDailyMismatch` (leaf L ≠ Σ daily); grid shows ⚠ in the No. column
  + amber row tint for those rows or a capacity-overloaded assignee. All 216 tests green.

User decisions this session (final): band map above = correct; **C-2** = implement code +
local migration/tests now, run the live Neon migration at deploy separately (Neon password
rotation still pending); **D-1** = pull C-4/C-5 forward so the full toolbar overhaul lands in
P0 (tree-only C-1, tail-row add C-4, subtask-mode + row-bound template UI C-5).

Open question (not yet decided): the daily axis is **sparse** (only dates that carry a
plan), so weekends generally are not columns and B-5's grey only shows for a holiday that has
a hand plan (demo `2026-01-07`). If the sheet expects a **continuous calendar axis** (grey
weekend columns visible), change the `days` memo in `App.tsx` from union-of-plan-dates to a
continuous min→max range (watch the knock-on to `synthesizeExternalLoad`/`detectOverloads`).

### P0 is COMPLETE (all local, `git log` `ab46631..f0c77b3`; NOT pushed)

Later user decisions applied: date axis → **continuous** `b2b5a01`; review/change → **removed
from the data model** `a46da43` (migration `0003`); C-5 template UI → **row ⋯ / right-click
menu**. Remaining commits after C-2:
- **continuous axis** `b2b5a01` — daily axis is every calendar day first→last plan; weekends/
  holidays are greyed columns; load/overload stays on the sparse `planDays`.
- **review/change removal** `a46da43` — dropped `review_ref`/`change_ref` everywhere + migration
  `0003` (deferred from live Neon like `0002`).
- **D-1+C-1+C-4+C-5** `67a53cf` — tree-only (flat toggle gone); all three toolbars deleted;
  cross-project overlay/overload/⚠ always on (legend → ⓘ tooltip); tasks added by typing into
  tail draft rows + a "+ n 行追加" footer; each task row has a ⋯/right-click menu →
  「サブタスクを追加」(child draft) + 「テンプレートから生成…」(picks a template → `task.generateSubtasks`).
- **A-1** `f0c77b3` — sign-in required; unauthenticated shows a login screen (Google sign-in
  card, or "未設定" card), never the grid; the demo App is gated behind build-time
  `VITE_VECTA_PREVIEW` (dev/screenshots only); preview localStorage persistence deleted.

Full gate green at `f0c77b3`: lint + typecheck + tests (domain 32, application 51, persistence
32, web 96). Screenshot the demo with `VITE_VECTA_PREVIEW=1 pnpm exec vite build --config
scratchpad/vite.screenshot.config.ts` (login screen renders without the flag).

### Progress after P0

- **Pushed**: P0 (`ab46631..8755185`) is on `origin/adr-0011-effort-wbs-realignment` (git-haiku,
  fast-forward). The P1 + this HANDOFF commit push on top.
- **P1 done** `3c2aba5` — **C-3** drag is reorder-only (no re-parent; ⠿ grip moved to the No.
  column, ▲▼ removed; sibling-scope-only reorder rewriting sortOrder) and **C-7** a collapsed
  parent rolls up its subtree effort + per-day daily sums (read-only summary). All tests green.

### Deployed 2026-07-21 (manual reconstruction) — LIVE

Production is updated: P0+P1 code is live at **https://vecta.tt-dev.workers.dev** (worker
`vecta`, Version `4ce0c229`), showing the A-1 login screen (real Google sign-in, no public
preview — verified). Migrations `0002`+`0003` are applied to prod Neon (verified: the three
dropped columns are gone, 4 migrations applied; `tasks` was empty so zero data loss). The Neon
`vecta-database-url` Keychain connection string works — no rotation issue.

CI is NOT usable as-is despite the modernized `deploy.yml` (single `apps/web`, production-only
dispatch, on `main`): GitHub Actions has no secrets (only the 3 vars I set — `GOOGLE_CLIENT_ID`,
`PRODUCTION_TENANT_ID`, `PRODUCTION_PROJECT_ID`), no Hyperdrive config exists on the account, and
the repo `wrangler.jsonc` targets `vecta-local`/`-staging`/`-production` — none is the live
`vecta`. So the deploy was done MANUALLY.

**Manual deploy recipe (reuse next time):**
1. Temporarily overwrite `apps/web/wrangler.jsonc` with a FLAT config: `name:"vecta"`, `main`,
   `assets`(ASSETS), OIDC `vars` = Google standard (issuer `https://accounts.google.com`,
   audience = the Google client id, jwks `https://www.googleapis.com/oauth2/v3/certs`), three
   `ratelimits` (ids 1001/1002/1003), **NO `hyperdrive` binding** (worker uses the `DATABASE_URL`
   Neon secret; Hyperdrive is a never-reached fallback), no `env` blocks.
2. Build with frontend auth: `VITE_GOOGLE_CLIENT_ID=<id> VITE_VECTA_TENANT_ID=<t>
   VITE_VECTA_PROJECT_ID=<p> pnpm --dir apps/web build` (values in private memory
   `earned-signal-realignment.md`). **Gotcha:** do NOT pass `--mode production` — it sets
   `CLOUDFLARE_ENV=production` and the cloudflare vite plugin suffixes the worker to
   `vecta-production` (wrong worker). Always deploy with an explicit `--name vecta`.
3. Deploy from the **cloudflare-vite-plugin-generated** config, NOT the flat source config:
   `pnpm --dir apps/web exec wrangler deploy -c dist/vecta/wrangler.json --name vecta`.
   **Critical (2026-07-22):** deploying the flat `apps/web/wrangler.jsonc` directly
   (`main: ./src/worker.ts`, `assets` with **no `directory`**) uploads the worker but serves
   **STALE assets** — the deploy reports success + a new version yet the old JS/CSS bundle stays
   live. The generated `dist/vecta/wrangler.json` carries `main: index.js` + `assets.directory:
   "../client"` (the fresh build) and only needs `--name vecta` to override its `vecta-production`
   name. **Always verify after deploy**: `ax https://vecta.tt-dev.workers.dev/` and confirm the
   served `assets/index-*.js` hash equals `apps/web/dist/client/index.html`'s — a matching version
   id is NOT sufficient.
4. Secret (persists across deploys, only to set/refresh): `printf '%s' "$(security
   find-generic-password -w -s vecta-database-url)" | wrangler secret put DATABASE_URL --name vecta`.
5. Migrate: `DEPLOY_ENV=production DATABASE_URL=<keychain> EXPECTED_DATABASE_HOST=<url host>
   EXPECTED_DATABASE_NAME=<url dbname> pnpm --dir packages/persistence db:migrate`.
6. Restore `apps/web/wrangler.jsonc` (never commit the flat override).

To make CI usable later: reconcile the repo wrangler config to the real `vecta` name + drop the
dead Hyperdrive binding, and populate all GitHub Actions secrets/vars (`CLOUDFLARE_API_TOKEN`,
`DATABASE_URL`, `DATABASE_HOST/NAME`, hyperdrive/OIDC/rate-limit values, operations-evidence).

### P2 progress 2026-07-21 — E-2 done (masters + schema) + C-6 process/product

**Committed `ba68c6b`** (pushed with this HANDOFF commit). Full gate green (domain 32,
application 63, persistence 34, web 104); migration exercised on real Postgres via testcontainers.
- **Schema**: new project-scoped, **name-only** masters `processes` / `products` (composite PK
  `(tenant,project,id)`, project FK cascade). `tasks.process`/`product` free text →
  `process_id`/`product_id` uuid FK (onDelete **restrict**), mirroring `assignee_member_id`→
  `members`. **Migration 0004** is data-preserving (seed masters from distinct existing values,
  backfill, drop text cols); like 0002/0003 it is **NOT yet run on live Neon** — run it at deploy.
- **Application**: `process.*` / `product.*` commands (mirror `member.*`); task→master reference
  validation + delete-while-referenced guard; projection resolves `processName`/`productName`;
  `ProjectTask.process/product` → `processId/productId` (nullable).
- **Web**: new `MasterScreen` (工程 / プロダクト / メンバー CRUD; 工程・プロダクトは名称のみ、メンバー=
  名称/カレンダー/キャパ[時間]). **Top-bar nav** `WBS | マスタ` integrated into the auth-bar (client
  `useState` view switch). Advisor decision: **top bar over left rail** — the WBS grid scrolls
  horizontally so width is precious and grid-first tools (Airtable/Sheets/Notion) use a top bar.
  Grid 工程/プロダクト cells are now **master-backed dropdowns** (C-6 process/product part; 担当 was
  already a member select). Verified by screenshots (master + grid) + web tests.

Screenshot pipeline (scratchpad assets are session-local; re-create as needed): the vite config
must live **inside `apps/web/`** so `@vitejs/plugin-react` resolves — `VITE_VECTA_PREVIEW=1 pnpm
--dir apps/web exec vite build --config <cfg>` (drop the cloudflare plugin, `define`
`import.meta.env.VITE_VECTA_PREVIEW`), serve the outDir, shoot with playwright.

### P2 progress 2026-07-21 — E-1 done (subtask templates → DB master). **P2 COMPLETE.**

**Committed `e4d54dd`** (pushed with this HANDOFF commit). Full gate green (domain 32, application
67, persistence 34, web 111); migration exercised on real Postgres via testcontainers.
- **Schema**: `subtask_templates` table (project-scoped; `name` + ordered `subtasks` jsonb).
  **Migration 0005** creates it and seeds the two former-builtin templates (Standard build, Design
  and review) into every existing `(tenant,project)`; NOT yet run on live Neon (deferred like 0002-0004).
- **Application**: `template.*` commands + validation; `ProjectState.templates`; `generateSubtaskTasks`
  resolves from `state.templates` (builtin `SUBTASK_TEMPLATES` / `getSubtaskTemplate` /
  `listSubtaskTemplates` removed; `prorateLargestRemainder` + `deriveSubtaskId` kept). `template.delete`
  needs no referential guard (generation copies step data into children; no template FK on a task).
- **Web**: `TemplateScreen` (list CRUD + ordered step editor: 名称 / 重み% / 依存[FS/SS/FF/SF+なし] /
  ラグ営業日, ▲▼ reorder, Σ重み hint); **テンプレート** top-bar nav segment (nav is now
  WBS | マスタ | テンプレート); the C-5 row menu + grid read templates from project state;
  `task.generateSubtasks` templateId is now a uuid. Verified by screenshot + web tests.

Also `6a1b92e` (hygiene): three source files carried a **raw NUL byte** as a composite-key separator
(the dependency-edge key + two member×date ledgers), which made `file`/`grep` treat them as binary.
Replaced with `backslash-u-0000` escapes — byte-identical at runtime, valid UTF-8 on disk. Repo-wide NUL scan
now clean. Note: the repo `scratchpad/` is inside `eslint .` scope, so a screenshot build's output
must go **outside the repo** (e.g. the session scratchpad), else a built bundle there fails the gate.

### Deployed 2026-07-22 — P2 (E-2 + E-1) LIVE in production

All of P2 is live at **https://vecta.tt-dev.workers.dev** (worker `vecta`, **Version
`03c03e79`**), via the manual recipe above. Verified post-deploy: root `/` → 200 (serves the new
bundle); API unauthenticated → 401 "Authentication is required" (NOT 500 → schema healthy).
- **Migrations 0004 + 0005 applied to prod Neon** (now 6 applied). **Prod was NOT empty** — it had
  **3 real tasks** (HANDOFF's earlier "empty" note is stale). 0004 is data-preserving; a scoped
  pre-migration backup of `tasks(id,process,product)` was taken and a post-migration diff confirmed
  **zero data loss** (the 3 tasks had empty process/product → 0 masters seeded, `process_id`/
  `product_id` NULL, matching the originals). 0005 seeded the two default templates into the project.
- Deploy gotchas that bit this run: `pnpm exec vite` fails at repo root (vite lives in `apps/web`) —
  build/screenshot configs must run from `apps/web`; the repo `scratchpad/` is inside `eslint .`
  scope, so screenshot build output must go outside the repo; `wrangler secret`/OIDC audience were
  already set (secret persists across deploys). The DB migrate script is `packages/persistence/
  scripts/migrate.mjs` (pg driver, guards on `EXPECTED_DATABASE_HOST`/`NAME`).

### Post-P2 polish 2026-07-22 (QA feedback) — all committed + live

- **UI redesign + IA merge** `2819f36` (deployed, worker version `ac03a65e`): the header was called
  "ダサい". Rebuilt into **one in-flow app bar** (a Gantt-glyph mark + VECTA wordmark + hairline +
  **editorial underline tabs** + a ghost Sign out / identity cluster; per-screen subtitle/save-badge
  drop to a recessed sub-strip) using the `frontend-design` + `hallmark` skills; light+dark verified.
  The standalone テンプレート screen is **folded into マスタ** as a 4th section 「サブタスクテンプレート」
  (`TemplateScreen` → extracted `TemplateSection`), so the top nav is now **WBS | マスタ** (2 tabs).
  No contract/domain/persistence change. Gate green (web tests 112).
- **CI** `f376416`: `ci.yml` (checks only — lint/typecheck/test/build, no deploy) now runs on **every
  branch push** + PRs + `workflow_dispatch`, with a per-ref concurrency cancel. Verified green on a
  feature-branch run. `deploy.yml` stays **manual-only + main-only** (workflow_dispatch, `if:
  github.ref == 'refs/heads/main'`) and is still non-functional (needs GH secrets/vars) — no branch
  auto-deploys. Deploy strategy = branch → push (checks) → merge to main → deploy on main (manual for
  now). Merge-to-main workflow proposed by the user, not yet adopted.
- **Prod test data**: the prod project's 3 junk stubs (テスト/hhh/hoge) were replaced with **48
  synthetic tasks** (8 phases × 5 subtasks) + 8 processes / 6 products / 6 members / 2 templates / 32
  deps, all generic ("Phase A"/"Product 1"/"Member 01"), via a transactional project-scoped replace
  that preserved the tenant/project rows + admin access (project_memberships untouched). revision→11.
- **Advisor**: the Claude Code **Advisor feature** is the "consult Fable" mechanism (`/advisor fable`
  pairs this Opus main with a Fable advisor). The old `fable` skill → renamed `pseudo-fable-thinking`;
  this session's agmsg identity `fable` → `opus` (see private memory [[model-role-split]]).

### Remaining backlog (design 0003) — P2 done + deployed; only P3 left

- **P2 = COMPLETE & DEPLOYED** (A/B/C/D in P0/P1; E-2 `ba68c6b`; E-1 `e4d54dd`; live 2026-07-22).
  C-6 done (工程/プロダクト with E-2, 担当 already a select).
- **P3**: F-1 unique numbering (approved: internal UUID + project-scoped immutable display seq),
  G-1 member daily-total bottom panel (option a).

Local screenshot pipeline (the Cloudflare vite plugin needs local Postgres so `pnpm dev`
fails): a React-only build of the preview `App` renders without a backend —
`scratchpad/vite.screenshot.config.ts` (cloudflare plugin removed, `root: apps/web`) →
`pnpm exec vite build --config …` → `python3 -m http.server` on the outDir →
`uv run --with playwright python scratchpad/shot.py <url> <out.png> [scrollLeft]`.

## Process rules (hard-won; do not relax)

- **Spec parity discipline**: the user's real spreadsheet is the only spec. Never add
  columns/UI/features that were not requested (this caused a formal rebuke). Internal state
  stays internal (flags, not UI). Self-audit "what's on screen that the spreadsheet lacks".
- Flow per phase: implement (opus/codex subagent) → advisor independently verifies
  (`pnpm check` at root, scope + leak grep, screenshots via Playwright) → phase commit →
  **leak audit** (machine username / home paths / emails / connection strings / keys —
  case-insensitive grep incl. untracked files) → push (git-haiku) → deploy when user-visible.
- Never read `.wbs-private/`. All fixtures/demo data synthetic. No real names/paths/values
  in code, tests, docs, commits.
- Secrets: never in chat/repo. `DATABASE_URL` is in the macOS Keychain item
  **`vecta-database-url`** (read with `security find-generic-password -w -s
  vecta-database-url`; pipe straight into `wrangler secret put` / env — never print).
  Deploy identifiers (client id, tenant/project UUIDs, admin identity) are in the private
  memory file, not in the repo.
- A Neon password rotation is pending on the user side; after it, update the Keychain item
  and re-run `wrangler secret put DATABASE_URL --name vecta`.


---

# Archived 2026-07-26 — ADR 0011/0012 completed narrative

Moved out of `HANDOFF.md` once the migration, cutover, retirement and CI/CD were all done and
verified. **Do not read this during normal work** — open it only to reconstruct why something was
built the way it was.

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
