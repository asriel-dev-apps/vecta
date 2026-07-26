import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // These tests talk to a real PostgreSQL over a socket. vitest's 5 s default
    // is a limit for pure-computation tests: when the machine was loaded, real
    // statements outran it, vitest abandoned the test while its transaction was
    // still open, and the leftover rows failed the NEXT test on a unique
    // constraint — a failure that pointed at the wrong test entirely.
    testTimeout: 30_000,
    // The shared container still has to boot before the first file runs.
    hookTimeout: 60_000,
  },
});
