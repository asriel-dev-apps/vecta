import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  declaredSecretNames,
  ENV_DECLARATION,
  SERVER_ONLY_DIRECTORIES,
  SERVER_ONLY_PACKAGES,
  suffixViolations,
} from "./server-only-surface.mjs";

/**
 * The client/server boundary, checked against what users actually RECEIVE.
 *
 * The `.server.ts` suffix is the only thing that keeps server code out of the
 * browser bundle today, and it works by convention: one import from the wrong
 * file, one module moved without its suffix, and the persistence layer or a
 * secret name ships to every visitor. A source-level rule cannot prove the
 * absence — bundlers inline, rename, and tree-shake — so this inspects the built
 * artifact instead. Nothing a refactor does to the source can evade it.
 *
 * It is deliberately paranoid about its OWN correctness. A scan that reads zero
 * files reports exactly the same "no hits" as a scan of a clean bundle, so before
 * looking at anything real it proves each rule still matches a sample it is
 * supposed to match, and afterwards it refuses to pass if it did not read a
 * plausible amount of bundle.
 *
 * Usage: node .github/scripts/verify-client-bundle.mjs [bundle-dir]
 * Default bundle-dir: apps/web/build/client (produced by `pnpm build`).
 */

/**
 * `sample` is the point of this table: it is a string the rule MUST flag. If a
 * pattern is ever broken by an edit, the self-check fails loudly instead of the
 * scan quietly passing everything.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * The secret names are DERIVED from the `Env` declaration, not copied next to it.
 *
 * Measured 2026-08-04: the hand-written list held four names while `Env` declared
 * eight, and the two it was missing were `STAGING_ACCESS_KEY` and
 * `SESSION_SECRET_PREVIOUS`. The second is the more instructive miss —
 * `\bSESSION_SECRET\b` does NOT match `SESSION_SECRET_PREVIOUS`, because `_` is a
 * word character, so the list looked like it covered a name it did not.
 * `CLOUDFLARE_API_TOKEN` is appended by hand because it is a CI credential and
 * never appears in `Env`.
 */
const CI_ONLY_SECRETS = ["CLOUDFLARE_API_TOKEN"];
const ENV_SOURCE = readFileSync(path.join(REPO_ROOT, ENV_DECLARATION), "utf8");
const SECRET_NAMES = [...declaredSecretNames(ENV_SOURCE), ...CI_ONLY_SECRETS];

function alternation(names) {
  return names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
}

/**
 * The shared list minus the workspace packages. `@vecta/*` is a real server-only
 * boundary in SOURCE — eslint must forbid importing `@vecta/persistence` from a
 * component — but a workspace name is resolved away by the bundler and never
 * survives into a client asset, so scanning for it here would only ever be
 * theatre. What it would drag in (drizzle, the Neon driver, a connection string)
 * is what the `persistence-driver` and `connection-string` rules above catch.
 */
const BUNDLE_VISIBLE_PACKAGES = SERVER_ONLY_PACKAGES.filter(
  (name) => !name.startsWith("@vecta/"),
);

const RULES = [
  {
    id: "secret-name",
    why: "A secret's NAME in the bundle means the code that reads it was shipped.",
    pattern: new RegExp(`\\b(${alternation(SECRET_NAMES)})\\b`, "u"),
    // The sample only proves the rule compiles and matches SOMETHING. It cannot
    // prove the derivation produced the right names — with an empty derivation
    // this would still be a literal that matches. `selfCheck` names the
    // credentials that must survive derivation; that is the real check.
    sample: "env.CLOUDFLARE_API_TOKEN",
  },
  {
    id: "connection-string",
    why: "A Postgres connection string must never reach a browser.",
    pattern: /postgres(ql)?:\/\//u,
    sample: "postgresql://user@host/db",
  },
  {
    id: "persistence-driver",
    why: "Drizzle / the Neon or node-postgres drivers are server-only transports.",
    pattern: /\b(drizzle-orm|drizzle\/|@neondatabase|neondatabase\/|node-postgres|pg-core)\b/u,
    sample: 'import { eq } from "drizzle-orm"',
  },
  {
    id: "server-only-dependency",
    why: "jose (token verification), hono (the /api + /mcp surfaces), the Agents SDK and the MCP SDK run only on the Worker.",
    // Derived from the shared list, because this rule USED to name hono in the
    // prose above and then not match it. Measured 2026-08-04, all NOT caught by
    // the old pattern: `hono`, `hono/cors`, `import * as jose from "jose"`,
    // `agents/mcp`. eslint had hono all along — the hole was in the gate that
    // reads what users actually receive, which is the one that is authoritative.
    //
    // A package name is matched in MODULE-SPECIFIER position — after a quote, or
    // after `node_modules/` — not as a bare word. Two measurements forced that
    // shape, and the first version of this fix had both defects:
    //
    //   * `\b` before an `@` never matches, because neither side is a word
    //     character. So `"@neondatabase/serverless"` and
    //     `"@modelcontextprotocol/sdk"` were in the list and unmatchable — the
    //     very defect this rule was being rewritten to fix.
    //   * a bare word flags ordinary browser code: `\bpg\b` hits `let a,pg,c;`
    //     (a plausible minifier name) and `\bagents\b` hits the string
    //     "Manage agents". A gate that flags correct bundles teaches people to
    //     bypass it, which is a security property, not a UX one.
    //
    // `node_modules/` rather than any `/` on the left, because `"/agents/list"`
    // — an application route — otherwise matches. Verified in both directions:
    // 10 specifier shapes match (quoted, subpath, scoped, dynamic import,
    // sourcemap path), 8 look-alikes do not.
    pattern: new RegExp(
      `(?:["'\`]|node_modules/)(${alternation(BUNDLE_VISIBLE_PACKAGES)})(?=["'\`/])` +
        "|\\b(jwtVerify|createRemoteJWKSet)\\b",
      "u",
    ),
    sample: 'import { Hono } from "hono"',
  },
  {
    id: "server-identifier",
    why:
      "A backstop for server identifiers appearing in the bundle by some route other " +
      "than an import — a copy-paste, say. Since 2026-08-04 every module under " +
      "app/server/ carries the .server suffix, so the import route is a build error " +
      "(see the suffix invariant below) and this list is no longer load-bearing.",
    pattern:
      /\b(createDbSession|NeonHttpProjectWorkspaceReader|PostgresProject[A-Za-z]*|createNeonPrincipalDirectory|createProjectAccessMiddleware|requirePrincipal|requireProjectWorkspace|loadProjectView|runCommandAction|applyCommands|findProjectMembership|projectWorkspaceContext|dbSessionContext)\b/u,
    sample: "const session = createDbSession(env)",
  },
];

/** A client asset built from a `.server` module is a leak by construction. */
const SERVER_SUFFIX_IN_FILENAME = /\.server[.-]/u;

/**
 * The SOURCE-side invariant, checked before the bundle is even read.
 *
 * The bundle rules above can only recognise patterns somebody thought of. The
 * suffix is different in kind: React Router's build REFUSES a client reference to
 * a `.server` module, so a module that carries it cannot leak by import at all,
 * whatever it contains and whether or not anybody added it to a list.
 *
 * Measured 2026-08-04, both directions, on this repo:
 *   * suffix-less module used in a route COMPONENT → build exit 0, the
 *     implementation present in `build/client`, this scanner exit 0. Nothing stopped it.
 *   * `.server.ts` module, identical usage → build exit 1,
 *     "Server-only module referenced by client".
 *
 * So this check is what keeps that difference from quietly reverting. A file
 * added to `app/server/` without the suffix fails here, at the name, rather than
 * years later at whatever it happened to be carrying.
 */
function serverSuffixInvariant() {
  const offenders = [];
  for (const directory of SERVER_ONLY_DIRECTORIES) {
    const absolute = path.join(REPO_ROOT, directory);
    let files;
    try {
      files = collectFiles(absolute);
    } catch {
      throw new Error(`server-only directory missing: ${directory} — refusing to report a pass`);
    }
    if (files.length === 0) {
      throw new Error(`server-only directory ${directory} is empty — refusing to report a pass`);
    }
    offenders.push(
      ...suffixViolations(files).map((file) => path.relative(REPO_ROOT, file)),
    );
  }
  return offenders;
}

function selfCheck() {
  const broken = RULES.filter((rule) => !rule.pattern.test(rule.sample));
  if (broken.length > 0) {
    throw new Error(
      `scanner is broken: ${broken.map((rule) => rule.id).join(", ")} no longer match their own sample`,
    );
  }
  if (!SERVER_SUFFIX_IN_FILENAME.test("self-save-revalidation.server-a1b2.js")) {
    throw new Error("scanner is broken: the .server filename rule matches nothing");
  }
  // The secret rule is derived, so its failure mode is an EMPTY derivation rather
  // than a stale literal. Naming the credentials that must survive derivation
  // turns that into a loud failure — including the one whose mishandling is why
  // this defence exists (`STAGING_ACCESS_KEY`) and the one the old hand-written
  // pattern silently failed to match (`SESSION_SECRET_PREVIOUS`).
  for (const required of ["SESSION_SECRET", "SESSION_SECRET_PREVIOUS", "STAGING_ACCESS_KEY", "DATABASE_URL"]) {
    if (!SECRET_NAMES.includes(required)) {
      throw new Error(
        `scanner is broken: ${required} is no longer derived from ${ENV_DECLARATION} — ` +
          "the secret-name rule would pass on a bundle containing it",
      );
    }
    if (!RULES[0].pattern.test(`env.${required}`)) {
      throw new Error(`scanner is broken: the secret-name rule does not match ${required}`);
    }
  }
  // The suffix violation detector must be able to see a violation.
  if (suffixViolations(["a/b/leaky.ts"]).length !== 1) {
    throw new Error("scanner is broken: the suffix invariant matches nothing");
  }
  if (suffixViolations(["a/b/safe.server.ts", "a/b/types.d.ts"]).length !== 0) {
    throw new Error("scanner is broken: the suffix invariant flags correct files");
  }
}

function collectFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

// A bundle this small means the build did not run, or ran into the wrong place.
// Passing on an empty directory is the one failure mode this script exists to
// avoid, so the floor is asserted rather than assumed.
const MINIMUM_FILES = 5;
const MINIMUM_BYTES = 50_000;

function main() {
  selfCheck();

  const unsuffixed = serverSuffixInvariant();
  if (unsuffixed.length > 0) {
    for (const file of unsuffixed) {
      console.error(
        `${file} — server-module-without-suffix (a module under a server-only directory that the ` +
          "build cannot refuse to ship; rename it to *.server.ts)",
      );
    }
    throw new Error(
      `${unsuffixed.length} module(s) under a server-only directory carry no .server suffix — see above`,
    );
  }

  const bundleDirectory = path.resolve(
    process.argv[2] ?? path.join(import.meta.dirname, "..", "..", "apps", "web", "build", "client"),
  );
  let files;
  try {
    files = collectFiles(bundleDirectory);
  } catch {
    throw new Error(`no client bundle at ${bundleDirectory} — run \`pnpm build\` first`);
  }

  const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  if (files.length < MINIMUM_FILES || totalBytes < MINIMUM_BYTES) {
    throw new Error(
      `client bundle at ${bundleDirectory} looks empty (${files.length} files, ${totalBytes} bytes) — ` +
        "refusing to report a pass on a bundle that was never built",
    );
  }

  const findings = [];
  for (const file of files) {
    const relative = path.relative(bundleDirectory, file);
    if (SERVER_SUFFIX_IN_FILENAME.test(path.basename(file))) {
      findings.push({ file: relative, rule: "server-module-shipped", line: 0 });
    }
    const lines = readFileSync(file, "utf8").split("\n");
    for (const rule of RULES) {
      const index = lines.findIndex((line) => rule.pattern.test(line));
      if (index !== -1) {
        findings.push({ file: relative, rule: rule.id, line: index + 1 });
      }
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      const rule = RULES.find((candidate) => candidate.id === finding.rule);
      console.error(
        `${finding.file}:${finding.line} — ${finding.rule}${rule === undefined ? "" : ` (${rule.why})`}`,
      );
    }
    throw new Error(
      `${findings.length} server-only marker(s) reached the client bundle — see above`,
    );
  }

  console.log(
    JSON.stringify({
      event: "client_bundle_verified",
      files: files.length,
      bytes: totalBytes,
      // The bundle rules, plus the `.server` filename rule, plus the source-side
      // suffix invariant. Counted here so a rule that stops running shows up as a
      // number that changed rather than as continued silence.
      rules: RULES.length + 2,
      secretNames: SECRET_NAMES.length,
    }),
  );
}

main();
