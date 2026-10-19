import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Correctness spec for the perf fixture page. Own config and own server: the
// regular e2e config serves the React Router dev server, not this page. The
// server is started with --strictPort and never reused, and readiness is the
// identity endpoint, so an unrelated process on the port fails the run instead
// of being tested. Run: `pnpm --filter @vecta/web e2e:grid`.
const PORT = Number(process.env.PERF_PORT ?? 4177);
const webDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "grid-scroll.spec.ts",
  outputDir: "./dist/test-artifacts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 240_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // Real wheel input is only compared against exact offsets with smooth scrolling off.
    launchOptions: { args: ["--disable-smooth-scrolling"] },
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: `pnpm exec vite build --config perf/vite.config.ts --logLevel warn && pnpm exec vite preview --config perf/vite.config.ts --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: webDir,
    url: `http://127.0.0.1:${PORT}/__perf-identity`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
