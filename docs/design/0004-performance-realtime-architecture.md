# Design 0004 — Performance, real-time & architecture direction

**Status: SUPERSEDED by `docs/adr/0012-react-router-cloudflare-ssr-architecture.md`** (2026-07-22, after
a full grilling). The direction was resolved: React Router v8 SSR on Cloudflare kills the flash and
makes saves instant; Neon+Hyperdrive kept; real-time (DO+WebSocket) deferred to Phase 1. Implement from
ADR 0012. The principles + diagnosis below remain a useful record of *why*.

_(original draft below)_ This records the guiding principles and the analysed
approach so we can align on the fundamentals in detail BEFORE implementing. Do **not** start the
Phase 1 (architecture) work until the direction below is worked through with the user and approved.
Phase 0 (free, no-infra quick wins) may proceed once the user gives the go.

Raised by the user 2026-07-22 after QA: "WBS/マスタ が表示されるまで一瞬空が見えてパッと反映される —
絶対にやめたい。保存も遅い、一瞬で反映したい。スプレッドシートよりスムーズでサクサクにしたい。"

## Guiding principles (must be upheld thoroughly)

1. **UI/UX** — smooth, no flashes, no empty states popping in.
2. **パフォーマンス（速度）** — display + save feel instant.
3. **セキュリティ** — keep/strengthen auth, rate limiting, no secret exposure.
4. **データ整合** — 1人で高速に触っても、多人数で同時に触っても不整合が起きない。
5. **コスト** — なるべく無料・最小に。
6. **AI連携** — 単純作業を極限まで削減(自然言語編集・自動補完など。別トピックとして後段)。

Backend/infra changes are on the table ("バックエンドを設けたり、インフラを変えても良い").

## Diagnosis (root causes, current architecture)

- **Serving**: `apps/web/src/worker.ts` serves the SPA **statically** (`ASSETS.fetch`); only
  `/api/*` hits the Hono app → opens a **Neon serverless** connection per request → Postgres.
- **Load flash**: `App` renders `EMPTY_PROJECT` first (App.tsx ~L526), then a `useEffect` runs
  `reload()` = `Promise.all([client.load(), client.grid()])` — **two API round-trips** (browser →
  Worker → Neon). The empty grid is visible during those round-trips → "一瞬空 → パッと反映".
- **Save slowness / re-settle** (App.tsx `executeCommands` ~L940):
  - Optimistic apply IS instant (`setProject` + `setGrid(projectWbsGrid(optimistic))`).
  - BUT connected mode does **not** run the daily-plan scheduler optimistically (only preview does),
    so derived daily values wait for the server.
  - After every save it runs **`reload()` (2 more round-trips)** and overwrites the optimistic grid
    with server values → a **visible re-settle**.
  - `saving.current` guard **blocks new edits** while a save's round-trips are in flight → rapid
    edits feel stuck.
  - Neon serverless opens a fresh connection per request (latency).

## Approach (phased)

### Phase 0 — free, no infra change (addresses display + save speed directly)
- Run the domain scheduler (`applyEffortSchedule`) **client-side optimistically in connected mode**
  so the optimistic grid already matches the server → **drop the post-save `reload()` re-settle**
  (replace with a quiet background revalidation that only reconciles on genuine divergence).
- **Batch commands** into one POST (1 round-trip per edit-batch instead of N); combine `load`+`grid`
  into **one endpoint** (halve initial round-trips). **Queue edits** instead of blocking on
  `saving.current`.
- Kill the empty flash without an auth change: **localStorage cache + stale-while-revalidate**
  (render last-known state instantly on boot, revalidate in background) + a **skeleton** (never a
  bare empty grid) for the very first load.
- Multi-user integrity stays on the current **optimistic-concurrency** model (`expectedRevision` +
  audit events) — already conflict-safe (conflicts reload), just not live.
- Cost: **$0**. Risk: low, but the client-side scheduler must EXACTLY match the server's placement or
  the dropped reload would diverge — verify with goldens.

### Phase 1 — architecture (for true multi-user "サクサク" + zero inconsistency)
- **One Durable Object per project**: holds project state in memory + serialises commands + pushes
  updates to all connected clients over **WebSocket**. load = instant (warm memory, no cold Neon
  query), save = optimistic + DO broadcast, multi-user = DO serialises → **structurally
  conflict-free**. Durable storage still Neon (or D1/DO-storage).
- **Cost caveat to confirm**: Durable Objects / always-on WebSocket may require **Workers Paid
  (~$5/mo)** — conflicts with the "無料" goal. **Verify current free-tier limits (SQLite-backed DOs,
  WebSocket, D1 vs Neon latency/cost) before committing.**

### AI (principle 6) — later, separate track
Natural-language edits, auto-fill/derive, anomaly flags, etc. Out of scope for the perf pass.

## Open questions to work through (detailed alignment BEFORE building Phase 1)

1. How far / how fast: Phase 0 only first, or commit to Phase 1 (DO) too?
2. Cost tolerance: is ~$5/mo Workers Paid acceptable if it buys true real-time multi-user, or must it
   stay strictly free (then live sync via DO is likely out; polling/optimistic-only stays)?
3. Storage: keep Neon, or move to **D1** (edge SQLite — lower latency + cheaper) for this workload?
4. Real-time model: full live collaboration (see others' cursors/edits) or just "my edits feel
   instant + never conflict"?
5. Auth for SSR/instant-first-paint: are we willing to add a **cookie session** (so the Worker can
   authenticate the HTML request and inject initial data)? That would let us eliminate the flash at
   the source, but it's an auth-model change.
6. Scale assumptions: how many concurrent editors per project, realistically? (sizes the design.)

Once these are settled and the direction is approved, implement to completion.
