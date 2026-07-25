import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Packages that exist only on the Worker. A value import of any of these from
 * client-reachable code puts the driver — and, as a build probe on 2026-07-26
 * showed, a literal `postgresql://` connection string — into the browser bundle,
 * with the build, the types, and the tests all still green.
 */
const SERVER_ONLY_PACKAGES = [
  "@vecta/persistence",
  "drizzle-orm",
  "@neondatabase/serverless",
  "jose",
  "hono",
];

function serverOnlyPackages(message) {
  return SERVER_ONLY_PACKAGES.map((name) => ({ name, allowTypeImports: true, message }));
}

/**
 * The client/server boundary, enforced at the SOURCE. Its partner is
 * `.github/scripts/verify-client-bundle.mjs`, which checks the built artifact:
 * that one is authoritative (it inspects what users actually receive, so no
 * source-level trick evades it) but it can only say "something leaked, here is
 * the chunk". These rules fail earlier and name the import.
 *
 * `allowTypeImports` throughout: a type import is erased at build time, so
 * sharing SHAPES across the boundary is not merely safe, it is the intended
 * design (`app/server/project/project-access.ts` is DB-free on purpose).
 */
const clientServerBoundary = [
  {
    // Everything under `app/` the browser can reach: components, hooks, the
    // wbs/masters client code. Route modules are handled separately below —
    // React Router strips their `loader`/`action` exports from the client build,
    // so they are the ONE sanctioned place a server module may be called.
    files: ["apps/web/app/**/*.ts", "apps/web/app/**/*.tsx"],
    ignores: [
      "apps/web/app/**/*.server.ts",
      "apps/web/app/**/*.server.tsx",
      "apps/web/app/server/**",
      "apps/web/app/middleware/**",
      "apps/web/app/routes/**",
      "apps/web/app/root.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: serverOnlyPackages(
            "Server-only package. Client-reachable modules may only `import type` from it.",
          ),
          patterns: [
            {
              group: [
                "~/server",
                "~/server/*",
                "~/server/**",
                "~/middleware/*",
                "~/middleware/**",
              ],
              allowTypeImports: true,
              message:
                "`app/server/` is server-only by convention, not by construction — the directory name enforces nothing. " +
                "Client-reachable modules may only `import type` from it. If the code is genuinely isomorphic, move it out of `app/server/`.",
            },
          ],
        },
      ],
    },
  },
  {
    // Route modules and root: allowed to CALL server modules (their loaders and
    // actions are stripped client-side), but not to reach past them into a
    // driver. Going through a `.server` module keeps one seam to audit.
    files: ["apps/web/app/routes/**/*.ts", "apps/web/app/routes/**/*.tsx", "apps/web/app/root.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: serverOnlyPackages(
            "Route modules must reach persistence through a `.server` module, not import the driver directly.",
          ),
        },
      ],
    },
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/.wrangler/**",
      "**/dist/**",
      "**/build/**",
      "**/.react-router/**",
      "**/worker-configuration.d.ts",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  ...clientServerBoundary,
);
