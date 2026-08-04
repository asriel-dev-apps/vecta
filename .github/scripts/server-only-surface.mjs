/**
 * The single declaration of what "server-only" means in this repo.
 *
 * It exists because the two gates that enforce the client/server boundary used to
 * carry their own copies of this knowledge, and the copies drifted. Measured on
 * 2026-08-04, against the real gates:
 *
 *   * `eslint.config.js` listed `hono` as server-only; `verify-client-bundle.mjs`
 *     named hono in the prose of its rule and then did not put it in the pattern.
 *     So the AUTHORITATIVE gate — the one that reads what users receive — was the
 *     one with the hole.
 *   * The bundle scanner's secret-name list held four names while `Env` declared
 *     eight. `STAGING_ACCESS_KEY` and `SESSION_SECRET_PREVIOUS` were absent, and
 *     `STAGING_ACCESS_KEY` is the credential whose mishandling (`?__stg=<key>`)
 *     is the reason the layered defence exists at all.
 *
 * Both gates now read from here, so a list can still be wrong, but it can no
 * longer be wrong in two different ways.
 */

/**
 * Packages that exist only on the Worker. A value import of any of these from
 * client-reachable code puts the driver — and, as a build probe on 2026-07-26
 * showed, a literal `postgresql://` connection string — into the browser bundle,
 * with the build, the types, and the tests all still green.
 */
export const SERVER_ONLY_PACKAGES = [
  "@vecta/persistence",
  "drizzle-orm",
  "@neondatabase/serverless",
  "pg",
  "jose",
  "hono",
  // The Cloudflare Agents SDK: `createMcpHandler` from `agents/mcp` is how the
  // `/mcp` surface is built. It reaches `cloudflare:workers` at module load, so
  // it cannot run in a browser at all — and it was matched by neither gate.
  "agents",
  "@modelcontextprotocol/sdk",
];

/**
 * Directories whose every module is server-only. The `.server` suffix is what
 * actually enforces this — React Router's build refuses a client reference to a
 * `.server` module ("Server-only module referenced by client") — so these are
 * the directories where a missing suffix is a defect, not a style choice.
 *
 * Measured 2026-08-04, both directions: a route module that used a suffix-less
 * module from `app/server/` in its COMPONENT body built successfully and shipped
 * the implementation to `build/client`, with the bundle scanner exiting 0. The
 * same probe against a `.server.ts` module failed the build. Hence
 * `suffixViolations` below: the property is cheap to keep and silent to lose.
 */
export const SERVER_ONLY_DIRECTORIES = ["apps/web/app/server", "apps/web/app/middleware"];

/** Where `Env` is declared. The secret-name rule is derived from it, not copied. */
export const ENV_DECLARATION = "apps/web/app/server/env.d.ts";

/**
 * A declared binding is treated as a secret when its NAME ends in one of these.
 * Deliberately a name-shape rule rather than a curated list: the point is to
 * catch the binding somebody adds without reading this file.
 */
const SECRET_NAME_SUFFIX = /(SECRET|SECRET_PREVIOUS|KEY|TOKEN|PASSWORD|URL)$/u;

/** Every `readonly NAME` declared in the `Env` interface, in declaration order. */
export function declaredEnvNames(source) {
  return [...source.matchAll(/^\s*readonly\s+([A-Z][A-Z0-9_]*)\s*\??\s*:/gmu)].map((m) => m[1]);
}

/**
 * The declared names that look like credentials. These MUST all appear in the
 * bundle scanner's secret-name rule; the scanner fails if one does not, so
 * adding a secret to `Env` and forgetting the gate is not a thing that can
 * happen quietly.
 */
export function declaredSecretNames(source) {
  return declaredEnvNames(source).filter((name) => SECRET_NAME_SUFFIX.test(name));
}

/**
 * Modules under the server-only directories that do NOT carry the `.server`
 * suffix — i.e. the ones protected by a directory name, which enforces nothing.
 * `.d.ts` files are excluded: a declaration file emits no code and cannot ship.
 */
export function suffixViolations(files) {
  return files.filter(
    (file) => /\.tsx?$/u.test(file) && !file.endsWith(".d.ts") && !/\.server\.tsx?$/u.test(file),
  );
}
