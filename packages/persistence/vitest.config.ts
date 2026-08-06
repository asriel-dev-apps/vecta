import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // These tests talk to a real PostgreSQL over a socket. vitest's 5 s default
    // is a limit for pure-computation tests: when the machine was loaded, real
    // statements outran it, vitest abandoned the test while its transaction was
    // still open, and the leftover rows failed the NEXT test on a unique
    // constraint — a failure that pointed at the wrong test entirely.
    // 60 s, not 30. Measured 2026-08-05: this suite passes 61/61 in 110 s when run
    // alone, and three files timed out at 30 s under `pnpm check` — which runs the
    // packages RECURSIVELY IN PARALLEL, so persistence competes with apps/web's 502
    // tests for the same cores. The contention is created by the gate's own shape,
    // and the same reasoning already raised apps/web's limits (see its
    // `test/setup.ts` for the before/after table).
    testTimeout: 60_000,
    // The shared container still has to boot before the first file runs.
    hookTimeout: 60_000,
  },
});
