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
