import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

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
const RULES = [
  {
    id: "secret-name",
    why: "A secret's NAME in the bundle means the code that reads it was shipped.",
    pattern:
      /\b(DATABASE_URL|SESSION_SECRET|OIDC_CLIENT_SECRET|CLOUDFLARE_API_TOKEN)\b/u,
    sample: 'env.DATABASE_URL',
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
    why: "jose (token verification), hono (the /api + /mcp surfaces) and the MCP SDK run only on the Worker.",
    pattern: /\b(jose\/|@modelcontextprotocol|jwtVerify|createRemoteJWKSet)\b/u,
    sample: "await jwtVerify(token, jwks)",
  },
  {
    id: "server-identifier",
    why:
      "Identifiers from the modules under app/server/ that carry NO .server suffix — " +
      "the ones reachable only by convention today, so the ones a refactor can leak.",
    pattern:
      /\b(createDbSession|NeonHttpProjectWorkspaceReader|PostgresProject[A-Za-z]*|createNeonPrincipalDirectory|createProjectAccessMiddleware|requirePrincipal|requireProjectWorkspace|loadProjectView|runCommandAction|applyCommands|findProjectMembership|projectWorkspaceContext|dbSessionContext)\b/u,
    sample: "const session = createDbSession(env)",
  },
];

/** A client asset built from a `.server` module is a leak by construction. */
const SERVER_SUFFIX_IN_FILENAME = /\.server[.-]/u;

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
      rules: RULES.length + 1,
    }),
  );
}

main();
