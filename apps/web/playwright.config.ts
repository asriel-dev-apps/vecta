import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite (Design 0008 §T7).
 *
 * It is deliberately NOT part of `pnpm check`. The reason is not the one
 * `pnpm audit:deps` uses — that one is excluded because it asks an external
 * service whose answer changes daily, and an e2e run has no external dependency.
 * The honest reason is browser startup cost and flake, and `pnpm check` is also
 * the deploy gate: a deploy that fails because a browser was slow is worse than a
 * separate signal that says so.
 *
 * It still runs in CI as its own job, because a suite that only ever runs by hand
 * rots unnoticed — which is the exact gap (`T7 is not reproducible`) this suite
 * was created to close.
 *
 * `localhost` and not `127.0.0.1`: `react-router dev` binds IPv6 loopback ONLY,
 * and `localhost` resolves to `::1` first on this platform. Measured 2026-08-05 —
 * polling `127.0.0.1` timed out for two minutes while the server was up and
 * serving, so a connection refused on loopback is not evidence the server is down.
 *
 * And not the literal `[::1]` either, even though it reaches the server: Chromium
 * refuses an IPv6 literal as a cookie origin ("Invalid cookie fields"), which
 * reads like a signing failure and is not one.
 */

const PORT = 5399;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Screenshots are for a person to look at, not for pixel comparison. A pixel
  // diff fails on font rendering and platform differences, and a check that cries
  // wolf gets bypassed — which costs more than it ever catches.
  outputDir: "./e2e/.artifacts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    // Kept on failure only. A trace per passing test is megabytes nobody reads.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
    { name: "dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
  ],
  webServer: {
    command: `pnpm exec react-router dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
