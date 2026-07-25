# ADR 0012 Step 6 — CUTOVER runbook (`apps/web-next` → live worker `vecta`)

> **EXECUTED — historical record only.** The cutover and the retirement are done: the SSR app is live
> and now lives at `apps/web` (the SPA this runbook calls `apps/web` was deleted). Do NOT follow the
> commands below; they refer to a directory layout and a manual recipe that no longer exist. The live
> release process is **`docs/operations/release-and-rollback.md`** (deploy on merge to `main` via
> `.github/workflows/deploy.yml`). Kept for the decisions, the traps, and the risk register.

Replace the live production worker `vecta` (currently the old React SPA `apps/web`) with the new
React Router v8 SSR app `apps/web-next`, then retire `apps/web`. The migration BUILD (Steps 1–5) is
done + pushed, **not deployed**. This runbook is fable-reviewed and grounded in verified repo facts.

**Placeholders** — real values live ONLY in private memory `earned-signal-realignment.md` (Google
client id, admin email/`sub`, tenant/project UUIDs, DB connection). Never put them in the repo, chat,
or commits. `<HOST>` = `vecta.tt-dev.workers.dev` (public). Secrets transit only `wrangler secret put`
pipes / Keychain — never echoed.

**Verified facts this runbook rests on:**
- `react-router build` emits `apps/web-next/build/server/wrangler.json` which **bakes in the `vars` +
  `ratelimits` from `wrangler.jsonc` at build time** (name `vecta-next-local`, `assets.directory:
  "../client"`, `main: "index.js"`). ⇒ real `vars` must be in `wrangler.jsonc` **before** the build; the
  deploy passes **`--name vecta`**.
- Cutover has **NO DB migration** (schema unchanged at migration 0006; web-next reads the same
  `@vecta/persistence` schema). The only DB write here is the one-row R1 UPDATE.
- The persistence resolver tries exact `(issuer,subject)` first, then `email:` fallback → the R1 UPDATE
  is **backward-compatible with the live old app**, so it's safe to do days early and rollback stays clean.
- CI (`ci.yml`) + root scripts + `pnpm-workspace.yaml` are glob-based (`apps/*`) → the directory rename
  needs **no** CI/workspace edits. Only `deploy.yml` (manual-only, non-functional, hard-codes the SPA
  recipe) must be disabled/rewritten at retirement.
- The worker **NAME stays `vecta` and the URL never changes** throughout; the monorepo directory rename is
  a separate, later source change.

---

## Phase 0 — USER MUST PROVIDE / DO (blockers; nothing deploys until all green)

1. **Google confidential client secret + redirect URI.** Preferred: **reuse the existing Google OAuth
   client** (the client id the old SPA used — in private memory). If it is a "Web application" client it
   already has a viewable client secret (Cloud Console → Credentials → the client). Reusing keeps the
   `/api` Bearer audience (`OIDC_CLIENT_ID`) unchanged. In that client, **add authorized redirect URI
   `https://<HOST>/auth/callback`** (exact, no trailing slash). Scopes unchanged (`openid email profile`);
   no consent-screen change. Only if the client can't expose a secret: create a new "Web application"
   client (same redirect URI) and note that the `/api` token audience changes.
2. **`SESSION_SECRET`** — `openssl rand -base64 32`. Store in Keychain/private memory; set as a Worker
   secret in Phase 4. (`SESSION_SECRET_PREVIOUS` is for future rotation — skip at cutover.)
3. **Real `OIDC_*` + `MCP_RESOURCE_URL` vars** (go into `wrangler.jsonc` temporarily in Phase 4):
   `OIDC_ISSUER=https://accounts.google.com`, `OIDC_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs`,
   `OIDC_AUTH_ENDPOINT=https://accounts.google.com/o/oauth2/v2/auth`,
   `OIDC_TOKEN_ENDPOINT=https://oauth2.googleapis.com/token`, `OIDC_CLIENT_ID=<GOOGLE_CLIENT_ID>`,
   `OIDC_REDIRECT_URI=https://<HOST>/auth/callback`, `MCP_RESOURCE_URL=https://<HOST>/mcp`.
4. **Rate-limit namespace ids** — self-assigned per-account integers; adopt the config's **2001/2002/2003**
   (deliberately distinct from the old app's 1001–1003 so counters start fresh). One check: no *other*
   worker in the account uses 2001–2003 (same id = shared counters).
5. **`DATABASE_URL`** — already a secret on worker `vecta` (Keychain `vecta-database-url`); secrets persist
   across deploys → no action at cutover. **The pending Neon rotation does NOT block cutover, but never do
   both in one window**: rotate ≥1 day before (rotate → update Keychain → `wrangler secret put DATABASE_URL
   --name vecta` → verify the OLD app still works) OR after the new app soaks. Never mid-cutover.
6. **The admin's real Google `sub`** — see Phase 1.
7. **Decision to proceed** — the deploy is outward-facing; the user runs it or explicitly approves it.

## Phase 1 — R1: fix the prod admin principal (do this FIRST, safe to do days early)

The cookie login matches exact `(issuer,subject)` with **no email fallback / no JIT** (deliberate Step-2
decision — do NOT add the fallback to the cookie path). The prod admin row is seeded `subject =
'email:<ADMIN_EMAIL>'` → first login would hit the "forbidden" screen. No chicken-and-egg: Google's `sub`
is stable and obtainable now.

- **Get the `sub`** (while the old SPA is live): log in at `https://<HOST>`, DevTools → Application →
  localStorage → copy the Google ID token, decode segment 2 **locally** (never paste tokens into web
  tools): `printf '%s' '<JWT_PAYLOAD_SEG>' | base64 -D` (add `=` padding) → read `sub` (~21-digit numeric).
  Alt: `curl 'https://oauth2.googleapis.com/tokeninfo?id_token=<TOKEN>'`.
- **One-row UPDATE on Neon** (WBS data untouched):
  ```
  psql "$(security find-generic-password -w -s vecta-database-url)"
  BEGIN;
  SELECT id, issuer, subject, type, display_name FROM principals;   -- tiny; eyeball it
  -- confirm exactly one row subject='email:<ADMIN_EMAIL>' AND no row already has '<GOOGLE_SUB>'
  -- ALSO confirm the row's issuer is exactly 'https://accounts.google.com' (else fix the WHERE AND
  --   make OIDC_ISSUER equal the row's issuer byte-for-byte).
  UPDATE principals SET subject='<GOOGLE_SUB>'
    WHERE issuer='https://accounts.google.com' AND subject='email:<ADMIN_EMAIL>';
  -- must report UPDATE 1; anything else -> ROLLBACK and investigate
  COMMIT;
  ```
  Safe days before cutover (old app then resolves via the direct-subject path); revert with one UPDATE.

## Phase 2 — Pre-deploy local smokes (no real secrets needed)

Local miniflare caps `compatibility_date` at 2026-07-15 while config says 2026-07-17 — **local-only**;
`wrangler deploy` submits the date to Cloudflare's API (production workerd supports it), so the deploy is
unaffected (a rejection would fail loudly at upload, before traffic). For `wrangler dev` pass
`--compatibility-date 2026-07-15` (no file edit). Put syntactically-valid dummy `DATABASE_URL`/OIDC values
in `.dev.vars` (these routes open no DB):
```
pnpm --dir apps/web-next build
pnpm --dir apps/web-next exec wrangler dev -c build/server/wrangler.json --compatibility-date 2026-07-15
curl -s  http://localhost:8787/api/health                         # 200
curl -si -X POST http://localhost:8787/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'   # 401 + WWW-Authenticate resource_metadata
curl -s  http://localhost:8787/.well-known/oauth-protected-resource/mcp   # 200, resource = MCP_RESOURCE_URL
curl -s  http://localhost:8787/                                   # SSR login/redirect HTML boots
```
The authenticated SSR-no-flash check (`/projects/:id/wbs` has `data-row-id` rows) needs a real login →
**deferred to the post-deploy prod view-source (Phase 5.5)**. Do NOT build a dev-only session bypass just
to smoke it locally (that would ship an auth backdoor); the `renderToString` test coverage stands pre-deploy.

**✅ Phase 2 VALIDATED (secrets-free local smoke, run pre-cutover):** the built bundle **boots in real
workerd** via `wrangler dev -c build/server/wrangler.json --compatibility-date 2026-07-15 --port 8787`
("Ready", all bindings loaded, **no `cloudflare:workers`/`agents` module-load error** — closes the
"CI-doesn't-run-workerd" residual). `/api/health`→200; `/mcp`→401 + `WWW-Authenticate resource_metadata`;
`/.well-known/oauth-protected-resource/mcp`→200; `/`→302 `/login`→302 to the Google OIDC **PKCE** URL (state/
nonce/S256) + sets `__Secure-oidc_tx` (auth-code flow initiates correctly); `/apifoo`→RR SSR 404 (dispatch
correct). Gotchas confirmed: (a) **`/mcp` returns 403 "host not permitted" unless the request Host matches
`MCP_RESOURCE_URL`'s host** — locally a placeholder artifact (spoof `-H 'Host: <resource-host>'` → 401); in
prod set `MCP_RESOURCE_URL=https://<HOST>/mcp` and the real Host matches → 401 naturally. (b) The
`--compatibility-date 2026-07-15` flag is CLI-only — it does **not** leak into `build/server/wrangler.json`
(still `2026-07-17`); Phase 4.2's grep confirms. (c) For the Phase-5 prod `/` check use a manual-redirect
fetch (`ax`/curl that follows redirects will chase the real `accounts.google.com` URL).

## Phase 3 — Optional zero-traffic canary

`wrangler versions upload` a non-serving version to worker `vecta` and smoke its preview URL (`/`,
`/api/health`, `/mcp` 401 work; login won't — redirect URI is the prod host). Validates compat-date, bundle
upload, ratelimit bindings against the real API with zero live traffic. If wrangler 4.111.0 rejects the
`-c build/server/wrangler.json --name vecta` shape, skip — Phase 5 covers the same ground.

## Phase 4 — Cutover deploy (secrets BEFORE code)

1. **Secrets on the live worker** (harmless to the old SPA — it ignores unknown vars; `secret put`
   re-deploys the current old version with a new version id, expected). Pipe from Keychain/pbpaste, never echo:
   ```
   printf '%s' '<SESSION_SECRET>'      | pnpm --dir apps/web-next exec wrangler secret put SESSION_SECRET --name vecta
   printf '%s' '<OIDC_CLIENT_SECRET>'  | pnpm --dir apps/web-next exec wrangler secret put OIDC_CLIENT_SECRET --name vecta
   ```
   `DATABASE_URL` already present.
2. **Real vars in → build → deploy from the generated config:**
   - Temporarily set `apps/web-next/wrangler.jsonc` `vars` to the Phase-0.3 real values (leave `name`).
   - `pnpm --dir apps/web-next build` — then **grep `build/server/wrangler.json`** for `accounts.google.com`
     + `<HOST>` + `2026-07-17` + the 3 `ratelimits` + `assets.directory:"../client"` (proves vars baked,
     no leftover local compat-date, placeholders gone).
   - `pnpm --dir apps/web-next exec wrangler deploy -c build/server/wrangler.json --name vecta`
     — **`--name vecta` is MANDATORY** (without it you get a stray `vecta-next-local` worker and the live
     site silently stays old).
   - Restore placeholders: `git stash push -- apps/web-next/wrangler.jsonc && git stash drop` (plain
     `git restore` is hook-blocked; use stash or git-haiku). Never commit real values.
3. No DB migration step (schema unchanged).

## Phase 5 — Post-deploy verification (all must pass before retiring anything; ~30 s propagation)

1. `curl -s https://<HOST>/` → SSR HTML whose `/assets/entry.client-*.js` + route-chunk hashes **match the
   filenames in `apps/web-next/build/client/assets/`** (the SSR equivalent of the old `index-*.js` hash
   check — there is no static index.html). Fetch one asset → 200.
2. `https://<HOST>/api/health` → 200.
3. `GET /.well-known/oauth-protected-resource/mcp` → 200 (`resource: https://<HOST>/mcp`); unauth `POST
   /mcp` → 401 with `WWW-Authenticate` carrying `resource_metadata`.
4. **Login round-trip as the admin** (R1 proof): `/login` → Google → `/auth/callback` → authenticated;
   `/projects` lists the project. A "no access" screen ⇒ R1 didn't take → rollback (Phase 7), recheck Phase 1.
5. **SSR no-flash in prod** (closes the deferred 4a smoke): view-source `/projects/<id>/wbs` first paint has
   `data-row-id` rows.
6. **One benign reversible write**: edit a cell → save → hard-reload → persisted → revert it.
7. Expected: every user re-logs-in after cutover (dead localStorage tokens, new cookie sessions). Not a defect.

## Phase 6 — Retirement (separate source change, after a 24–48 h soak)

Worker name/URL unchanged; this is a monorepo edit only.
1. `git rm -r apps/web` ; `git mv apps/web-next apps/web`.
2. In the moved `wrangler.jsonc`, rename local name `"vecta-next-local"` → `"vecta-local"` (local-dev only;
   deploys still pass `--name vecta`). Keep the `.invalid` placeholders.
3. No `pnpm-workspace.yaml`/`ci.yml` edits (glob-based). **Disable or rewrite `deploy.yml`** — after the
   rename its SPA recipe (`pnpm --dir apps/web build --mode …` + the env suffixing that caused the old
   `vecta-production` trap) would run against the SSR app. It's manual-only + non-functional today → delete
   or stub it.
4. Rewrite the HANDOFF "Manual deploy recipe" to the Phase-4 recipe; archive the old one. Root `pnpm check`
   → leak audit → push (git-haiku).
5. Optionally re-deploy once from the renamed dir to prove the recipe end-to-end.

## Phase 7 — Rollback

- **Fast:** `wrangler rollback --name vecta` (or dashboard → `vecta` → Deployments). **Immediately after
  cutover, confirm the dashboard offers the previous version as a rollback target** — Cloudflare may refuse
  rollbacks across binding-shape changes; if so, use the source path.
- **Source path (always works pre-retirement):** `apps/web` is untouched on the branch — redeploy it via the
  HANDOFF "Manual deploy recipe" (~minutes). This is why retirement waits for the soak.
- **Data risk: none by construction** — no schema change / no data migration; the only DB write (R1 one-row
  UPDATE) is old-app-compatible and revertible with one UPDATE. Rolled-back users just log in the old way;
  stray `__Host-vecta_session` cookies are ignored.

## Risk register (ordered)
1. **R1 principal row** — first admin login "forbidden". Mitigate: Phase 1 days early + the row-count check.
2. **Baked placeholder vars** — a build made before the `wrangler.jsonc` edit ships `.invalid` endpoints →
   login 100% broken. Mitigate: the grep-generated-config step; always rebuild after editing vars.
3. **`--name vecta` omission** — stray parallel worker, live site stays old. Delete stray, redeploy.
4. **`OIDC_REDIRECT_URI` / Google mismatch** — one char off → `redirect_uri_mismatch`. Identical strings both sides.
5. **Secrets-after-code** — code before `SESSION_SECRET` → every login 500s. Phase-4 order fixes it.
6. **Compat-date confusion** — the 2026-07-15 cap is miniflare-only; don't bake it into the deployed config
   (Phase 4.2 grep confirms `2026-07-17`).
7. **Neon rotation collision** — sequence fully before/after, never mid-cutover.
8. **Ratelimit namespace collision** — account-level id reuse = shared counters (one-minute user check).
9. **Rollback eligibility** — dashboard rollback across the binding change is unverified; the untouched
   `apps/web` source path is the guaranteed fallback (retirement waits for the soak).
10. **`deploy.yml` post-rename** — would run the SPA recipe against the SSR app; disable/rewrite at retirement.
11. **Leak surface** — real client id transits `wrangler.jsonc` (working tree) + `build/server/wrangler.json`
    (gitignored). Stash-restore + the standard pre-push leak audit cover it.

## Could-not-verify-from-repo (check at execution)
Whether the existing Google client is secret-capable "Web application" type (Phase 0.1 fallback covers no);
the seeded principal row's exact `issuer` (Phase 1 SELECT); `wrangler versions upload` support for this
config shape (Phase 3 optional); dashboard rollback eligibility across the binding change (Phase 7 check).
