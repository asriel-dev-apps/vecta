import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const stub = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Resolve the `~/*` -> `app/*` alias (from tsconfig `paths`) in tests, matching
  // how the Vite app build resolves it.
  plugins: [tsconfigPaths()],
  resolve: {
    // The `/mcp` handler imports `agents`, which pulls the `cloudflare:workers`
    // and `cloudflare:email` runtime modules at module load — specifiers the Node
    // test loader cannot resolve. Alias them to minimal stubs (the stateless MCP
    // path never touches the DO/Agent/email machinery they provide). The
    // production build uses the real workerd modules.
    alias: {
      "cloudflare:workers": stub("./test/stubs/cloudflare-workers.ts"),
      "cloudflare:email": stub("./test/stubs/cloudflare-email.ts"),
    },
  },
  test: {
    environment: "node",
    // Testing Library's own 1 s async budget lives in `test/setup.ts`; this is the
    // outer one. Measured 2026-08-05: the heaviest test ("hydrates a large
    // (5000-task) fixture") takes 585 ms on a quiet machine and blew the 5 s
    // default when a headless-Chrome render ran beside it.
    //
    // 30 s rather than 15 s, sized by reproducing the failure instead of guessing:
    // with all 8 cores saturated the suite takes 86 s instead of 17 s, and at 15 s
    // one test still timed out — a 204 ms test stretched past 15 s, i.e. >70x. The
    // same number `packages/persistence/vitest.config.ts` reached for the same
    // reason: the default is a limit for pure computation, and these tests spend
    // real wall-clock rendering. The cost of the higher ceiling is that a
    // genuinely hung test takes 30 s to say so, which is the cheaper mistake.
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    server: {
      deps: {
        // Inline node_modules through Vite's transform (rather than Node's
        // externalized loader) so the `cloudflare:*` aliases above reach the
        // `agents` dep the `/mcp` handler imports. A narrower `inline: [/agents/]`
        // does NOT get applied by vitest 4's resolver here (only `true` does), so
        // this is the working minimum; the wall-clock cost is marginal.
        inline: true,
      },
    },
  },
});
