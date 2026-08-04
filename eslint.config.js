import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
// Shared with `.github/scripts/verify-client-bundle.mjs`; it used to be a second
// copy here and the two drifted. That file's header has the measurement.
import { SERVER_ONLY_PACKAGES } from "./.github/scripts/server-only-surface.mjs";

function serverOnlyPackages(message) {
  return SERVER_ONLY_PACKAGES.map((name) => ({ name, allowTypeImports: true, message }));
}

/**
 * `paths` matches a module specifier EXACTLY, so the entries above stop
 * `import … from "hono"` and nothing else. Measured 2026-08-04 with a probe file
 * under `app/wbs/`: of `hono`, `hono/cors`,
 * `@modelcontextprotocol/sdk/server/mcp.js` and `drizzle-orm/neon-http`, eslint
 * flagged ONE — the bare `hono`. And subpaths are how this repo really imports
 * these: `api/mcp.server.ts` uses the MCP subpath, `api/app.server.ts` uses
 * `hono/body-limit`, and `principal-directory.neon.server.ts` uses
 * `drizzle-orm/neon-http`. So the exact-match list was closing the door that
 * nobody walks through.
 */
function serverOnlySubpaths(message) {
  return SERVER_ONLY_PACKAGES.map((name) => ({
    group: [`${name}/*`],
    allowTypeImports: true,
    message,
  }));
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
                "`app/server/` modules all carry the `.server` suffix, which the build enforces — but only once " +
                "something client-reachable actually references them. Client-reachable modules may only `import type` " +
                "from it. If the code is genuinely isomorphic, move it out of `app/server/`.",
            },
            ...serverOnlySubpaths(
              "Server-only package (subpath). Client-reachable modules may only `import type` from it.",
            ),
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
          patterns: serverOnlySubpaths(
            "Route modules must reach persistence through a `.server` module, not import the driver directly (subpath).",
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
      // `spikes/` is exploration code, deliberately OUTSIDE the pnpm workspace
      // (`pnpm-workspace.yaml` lists only `apps/*` and `packages/*`), so CI never
      // installs its dependencies. Type-aware linting there is not noisy, it is
      // impossible: with the types unresolvable every expression is `any`, and
      // enabling `recommendedTypeChecked` turned that into 306 CI errors in a
      // directory that ships nothing. It was green locally only because this
      // machine happens to have `spikes/tanstack-grid/node_modules`.
      "spikes/**",
    ],
  },
  eslint.configs.recommended,
  // TYPE-AWARE linting (2026-07-27). `recommended` alone leaves every rule that
  // needs type information switched off, and those are the ones that matter here:
  // `no-floating-promises` is what stops an authorization check from being written
  // without `await` — a check that never runs looks identical to one that passed.
  // Measured before enabling: 155 findings, of which 30 were in the security-
  // relevant families and only 6 outside tests. One of those six was a real defect
  // in the staging gate's credential path, found the moment the rules were turned on.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Off on purpose, with the reason, so nobody re-enables them expecting value:
      // these are style, and 96 of the 155 findings were theirs. A gate that mostly
      // reports style gets skimmed, and then the six that mattered get skimmed too.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // React Router signals redirects by THROWING a Response; that is the
      // framework's contract, not an error-handling mistake.
      "@typescript-eslint/only-throw-error": "off",
      // Kept and made explicit — these are the security-relevant ones.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
  {
    // From eslint-plugin-security, THREE rules only. Most of that plugin assumes
    // Node — `child_process`, `fs`, `Buffer` — and this runs on Cloudflare Workers,
    // where those APIs do not exist. Enabling the whole set would add noise that
    // makes the gate skimmable, which is how the real findings get skimmed too.
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js"],
    plugins: { security },
    rules: {
      // ReDoS. Workers Free allows 10 ms of CPU per request, so a catastrophically
      // backtracking regex is a denial of service rather than a slow path — and the
      // assistant now reads THIRD-PARTY documents (estimates, CSV) with regexes.
      "security/detect-unsafe-regex": "error",
      // `===` on a credential leaks its prefix through timing. The staging gate
      // hand-rolls a constant-time compare; nothing stopped the next one from not.
      "security/detect-possible-timing-attacks": "error",
      // Trojan source: bidirectional unicode that makes the rendered code read
      // differently from what the compiler sees. Cheap to check, invisible to review.
      "security/detect-bidi-characters": "error",
    },
  },
  {
    // `no-restricted-syntax` rather than a plugin: React's escape hatch has exactly
    // ONE legitimate use here (the theme bootstrap in root.tsx, which must run before
    // first paint). Anywhere else it is how the model's prose would become markup.
    files: ["apps/web/app/**/*.tsx"],
    ignores: ["apps/web/app/root.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "dangerouslySetInnerHTML is allowed only in root.tsx (the pre-paint theme script). " +
            "Rendering anything else as HTML is how untrusted text becomes markup — render it as a text node.",
        },
      ],
    },
  },
  {
    // The build/ops scripts are plain JS and belong to no tsconfig, so type-aware
    // rules cannot parse them at all. Turning the type-aware set off HERE keeps it on
    // everywhere it can actually run, rather than disabling it globally to silence a
    // handful of files.
    files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Tests cast deliberately (`as never` for a fake binding, a hand-built context)
    // and 24 of the 30 `any`-flow findings were theirs. Relaxing them HERE keeps the
    // rules hard errors where untrusted data actually flows, instead of the whole
    // family being switched off to quieten the test suite.
    files: ["**/test/**", "**/*.test.ts", "**/*.test.tsx", "**/*.test.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
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
