#!/usr/bin/env node
// A secret must never travel in a URL.
//
// Written after putting one there. The staging gate originally accepted its access
// key as `?__stg=<key>` and stripped it with a redirect. The code even carried a
// comment naming the exposures it was mitigating — "the address bar, history, a
// Referer" — and that comment was the whole problem: the list was INCOMPLETE. A
// query string is also written verbatim into Cloudflare's request logs, and a
// redirect does nothing about that. Mitigating the instances one happens to recall
// is not the same as the channel being safe, and the completeness of that recall
// had quietly become load-bearing.
//
// So the rule is one that needs no enumeration to apply, and it is checked rather
// than remembered.
//
// TWO rules, because the obvious grep would NOT have caught the original mistake:
// the parameter name there was a constant (`KEY_PARAM`), not a suspicious literal.
//
//   1. co-located-credential-and-query — a module that COMPARES or DERIVES a
//      credential may not read the query string. This is the one that catches the
//      real defect, and it catches it regardless of how the parameter is named.
//   2. no-credential-parameter-literal — no source file may contain a URL literal
//      with a credential-shaped parameter name (`?token=`, `&api_key=`, …). This
//      catches the common shape anywhere, including where no comparison is nearby.
//
// Each rule carries a CONTROL in the tests: an input that MUST be reported. A
// scanner that can only ever say "clean" is indistinguishable from a broken one.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** Signals that a module handles a credential rather than merely mentioning one. */
const CREDENTIAL_HANDLING = [
  /\bequalsConstantTime\b/u,
  /\btimingSafeEqual\b/u,
  /crypto\.subtle\.(sign|verify)\b/u,
  /\bcreateHmac\b/u,
];

/** Signals that a module reads the query string. */
const READS_QUERY_STRING = [/\bsearchParams\b/u, /\bnew URLSearchParams\(\s*(?:window\.)?location/u];

/**
 * Parameter names that should never appear in a URL. `code` and `state` are
 * deliberately ABSENT: OAuth puts them in a redirect by specification, so listing
 * them would make the rule unusable rather than make the app safer.
 */
const CREDENTIAL_PARAMETER_NAME = /[?&]([a-z0-9_-]+)=/giu;
const CREDENTIAL_WORD = /secret|token|passwo?rd|passwd|pwd|api[_-]?key|access[_-]?key|apikey|credential|bearer|hmac|signature/iu;

/**
 * Two simple patterns rather than one clever one. The original wrapped the keyword
 * alternation in `[a-z0-9_-]*` on both sides, and those classes overlap the keywords
 * themselves — ambiguous, so a long non-matching line backtracks. Extract the
 * parameter name with a single unambiguous class, then test the name.
 */
function findCredentialParameter(source) {
  CREDENTIAL_PARAMETER_NAME.lastIndex = 0;
  let match;
  while ((match = CREDENTIAL_PARAMETER_NAME.exec(source)) !== null) {
    if (CREDENTIAL_WORD.test(match[1])) return match[0];
  }
  return null;
}

/**
 * Two kinds of file are out of scope for BOTH rules:
 *   - tests, which legitimately build a bad URL in order to assert it is refused;
 *   - this scanner and its own test, which carry every forbidden pattern as data.
 * Excluding the scanner is not a loophole in the rule — it is the difference between
 * checking the tree and checking the ruler.
 */
function inScope(file) {
  if (/\.test\.[cm]?[jt]sx?$/u.test(file)) return false;
  return !path.basename(file).startsWith("verify-no-secret-in-url.");
}

export const RULES = [
  {
    id: "co-located-credential-and-query",
    applies: inScope,
    check(source) {
      const handles = CREDENTIAL_HANDLING.some((pattern) => pattern.test(source));
      if (!handles) return null;
      const reads = READS_QUERY_STRING.find((pattern) => pattern.test(source));
      if (reads === undefined) return null;
      return `handles a credential and also reads the query string (${String(reads)})`;
    },
  },
  {
    id: "no-credential-parameter-literal",
    applies: inScope,
    check(source) {
      const found = findCredentialParameter(source);
      return found === null ? null : `contains a credential-shaped URL parameter: ${found}`;
    },
  },
];

/**
 * Pure core: given `{ file, source }` entries, return the findings. Separated from
 * the filesystem so the tests can drive it with inputs that MUST be reported.
 */
export function scanForSecretsInUrls(files) {
  const findings = [];
  for (const rule of RULES) {
    for (const { file, source } of files) {
      if (!rule.applies(file)) continue;
      const detail = rule.check(source);
      if (detail !== null) findings.push({ rule: rule.id, file, detail });
    }
  }
  return findings;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "spikes",
  "scratchpad",
  ".wrangler",
]);

async function collectSources(root, directory = "") {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectSources(root, relative)));
      continue;
    }
    // Generated Workers typings mention every Cloudflare product and are not source.
    if (relative.endsWith("worker-configuration.d.ts")) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push({ file: relative, source: await readFile(path.join(root, relative), "utf8") });
  }
  return files;
}

async function main() {
  const root = process.argv[2] ?? process.cwd();
  const files = await collectSources(root);
  if (files.length < 50) {
    throw new Error(
      `Only ${files.length} source files were read — the scanner is pointed at the wrong tree, and a clean result would mean nothing`,
    );
  }

  // Control: the rule that matters must be able to fire. Prove it on a synthetic
  // input every run, so a clean report is never just an inert scanner.
  const control = scanForSecretsInUrls([
    { file: "control.ts", source: "equalsConstantTime(url.searchParams.get(P), key)" },
  ]);
  if (control.length === 0) {
    console.error(JSON.stringify({ event: "secret_in_url_control_failed" }));
    process.exitCode = 1;
    return;
  }

  const findings = scanForSecretsInUrls(files);
  if (findings.length > 0) {
    console.error(JSON.stringify({ event: "secret_in_url", findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      event: "no_secret_in_url_verified",
      files: files.length,
      rules: RULES.length,
      control: "fired",
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
