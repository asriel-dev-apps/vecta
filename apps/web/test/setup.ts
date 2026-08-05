// `@testing-library/react` re-exports the dom package's `configure`, and it is the
// direct dependency here. Importing `@testing-library/dom` directly does not
// resolve under pnpm at all — measured: every one of the 47 files failed to load,
// which vitest reports as "no tests" rather than as an import error.
import { configure } from "@testing-library/react";

/**
 * Testing Library's async utilities give up after 1 s by default, and that is the
 * budget for a machine doing nothing else.
 *
 * Measured 2026-08-05 across three separate `pnpm check` runs: the whole suite
 * passes 501/501 when run alone, and fails 2 of 501 when something CPU-heavy runs
 * beside it — twice a headless-Chrome PDF render, once a review agent's own test
 * run. Both failures were timeouts wearing different clothes:
 *
 *   * `wbs-hydration` ("hydrates a large (5000-task) fixture") hit vitest's 5 s
 *     `testTimeout`. It takes **585 ms** on a quiet machine.
 *   * `wbs-connected-resync` reported `expected null not to be null` — which reads
 *     like a logic failure and is not: it is `waitFor`'s 1 s expiring with the
 *     document body still EMPTY (`<body><div /></body>` in the dump). It takes
 *     **564 ms** quiet.
 *
 * So the real headroom on the heaviest test was about 1.7×, not the 8× the 5 s
 * default suggests, because the binding constraint was this 1 s and not that 5 s.
 * 5 s here is ~9× the measured render. Paired with `testTimeout` in
 * `vitest.config.ts`, which is the other half.
 *
 * This is the same reasoning `packages/persistence/vitest.config.ts` already
 * records for its own 30 s: the default is a limit for pure computation, and
 * these tests spend real wall-clock rendering.
 *
 * A longer limit does not make a genuinely broken test pass — it fails at the new
 * limit instead. What it stops is a green suite reporting red because the machine
 * was busy, which is worse than either: `pnpm check` is the deploy gate, and a
 * gate that fails at random teaches people to re-run it until it is green.
 *
 * ## What this does and does not buy, measured by reproducing the failure
 *
 * | machine state (8 cores)      | before      | after            |
 * | ---------------------------- | ----------- | ---------------- |
 * | quiet                        | 501/501 17s | 501/501 17s      |
 * | 4 cores busy                 | **2 failed**| **501/501 78s**  |
 * | 8 cores saturated            | 2 failed    | 500/501 108s     |
 *
 * The middle row is the one that matters: one CPU-heavy process alongside is the
 * condition that actually bit, three times. Full saturation still fails one test
 * and that is ACCEPTED — closing it would mean timeouts in the minutes, which
 * makes a genuinely hung test cost minutes to report, and at that point the
 * machine cannot really run the suite anyway.
 *
 * **So the practical rule stands: do not run something CPU-heavy beside
 * `pnpm check`.** These limits widen the margin; they do not remove the rule.
 */
configure({ asyncUtilTimeout: 10_000 });
