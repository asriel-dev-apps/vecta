#!/usr/bin/env node
// Workflow supply-chain posture, checked instead of remembered.
//
// The 2026-07-27 ASVS L2 scan's GitHub-Actions High was two defects that only
// matter together, and BOTH of them are invisible in a diff of this repository:
//
//   1. Three third-party actions were pinned by MUTABLE TAG (`@v4`). Whoever
//      controls the upstream repo can repoint that tag at a new commit, and the
//      next run fetches and executes it. Nothing changes here. Dependabot cannot
//      catch it either — it opens PRs on new RELEASES, not on a tag being moved.
//   2. `deploy.yml` declared `CLOUDFLARE_API_TOKEN` in a JOB-level `env:`. GitHub
//      materialises that into EVERY step, so the deploy credential was already in
//      the environment of those three actions before any of this repo's code ran —
//      and of `pnpm check`, which executes eslint, vitest, vite, esbuild, workerd
//      and every transitive dev dependency.
//
// The `production` Environment gate does not cover this: it authorises the job to
// START and never inspects step contents.
//
// TWO rules, because either alone leaves the shape reachable:
//
//   1. sha-pinned-actions — every third-party `uses:` must name a 40-hex commit.
//      Local actions (`./…`) and reusable workflows in this repo are exempt.
//   2. no-secret-in-job-env — no `secrets.*` expression may appear in a job-level
//      `env:` block. Step-level is fine; that is the fix this enforces.
//
// Each rule carries a CONTROL that must fire on synthetic input every run. A
// scanner that can only ever say "clean" is indistinguishable from a broken one —
// this repo has shipped exactly that mistake before.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SHA_PIN = /^[0-9a-f]{40}$/u;

export const RULES = ["sha-pinned-actions", "no-secret-in-job-env"];

/** Indentation width of a line, treating tabs as one column (YAML forbids them anyway). */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Find every `uses:` that is not pinned to a commit SHA.
 *
 * A reference is exempt when it is local (`./path`) — those live in this
 * repository and are covered by its own review — or a docker image, which is
 * pinned by digest elsewhere and is not what the finding is about.
 */
export function findUnpinnedUses(file, source) {
  const findings = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const withoutComment = line.split("#")[0] ?? "";
    const match = /(?:^|\s)uses:\s*(\S+)\s*$/u.exec(withoutComment);
    if (match === null) continue;
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const at = reference.lastIndexOf("@");
    const version = at === -1 ? "" : reference.slice(at + 1);
    if (SHA_PIN.test(version)) continue;
    findings.push({
      rule: "sha-pinned-actions",
      file,
      line: index + 1,
      reference,
      detail:
        at === -1
          ? "action reference carries no version at all"
          : `pinned by mutable ref \`${version}\`; use the 40-hex commit SHA`,
    });
  }
  return findings;
}

/**
 * Is the mapping key at `index` nested inside a step (a `- ` list item)?
 *
 * A step is a list item, and YAML indents an item's keys two columns past its
 * `- ` marker — so the owning marker sits at `indent - 2`. Walk back over this
 * mapping's sibling keys (same indent) and any nested content (deeper), then look
 * at the first shallower line: a `- ` there means we are inside a step.
 *
 * Getting this wrong is a FALSE POSITIVE on the very fix this gate protects,
 * which is worse than useless — a gate that flags correct workflows teaches
 * people to bypass it. Both directions are tested; the first version of this
 * function failed exactly here, twice.
 */
function isStepScoped(lines, index, indent) {
  for (let back = index - 1; back >= 0; back -= 1) {
    const previous = lines[back];
    if (previous === undefined || previous.trim() === "") continue;
    const previousIndent = indentOf(previous);
    if (previousIndent > indent) continue;
    if (previousIndent === indent) {
      if (previous.trimStart().startsWith("- ")) return true;
      continue;
    }
    return previousIndent === indent - 2 && previous.trimStart().startsWith("- ");
  }
  return false;
}

/**
 * Find `secrets.*` inside a JOB-level `env:` block.
 *
 * Parsed by indentation rather than with a YAML library, deliberately: adding a
 * parser dependency to a supply-chain gate is the wrong trade, and the shape being
 * detected is structural (an `env:` that is a sibling of `steps:`). A job-level
 * `env:` sits at the same indent as `steps:`/`runs-on:`; a step-level one is nested
 * under a `- ` list item and is therefore deeper than the block it belongs to.
 */
export function findSecretsInJobEnv(file, source) {
  const findings = [];
  const lines = source.split("\n");
  let envIndent = null;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);

    if (envIndent !== null) {
      // The block ends at the first line that is not more-indented than `env:`.
      if (indent <= envIndent) {
        envIndent = null;
      } else if (/\$\{\{\s*secrets\./u.test(line)) {
        findings.push({
          rule: "no-secret-in-job-env",
          file,
          line: index + 1,
          detail:
            "a job-level `env:` reaches every step, including third-party actions; " +
            "declare the secret on the step that needs it",
        });
        continue;
      }
    }

    // An `env:` mapping key — block style (`env:`) or flow style (`env: {…}`).
    // A list item (`- env:`) is always step-scoped, so it is excluded outright.
    const trimmed = line.trim();
    const isEnvKey = /^env:/u.test(trimmed) && !trimmed.startsWith("- ");
    if (isEnvKey && !isStepScoped(lines, index, indent)) {
      if (/^env:\s*\S/u.test(trimmed)) {
        // FLOW STYLE is a blind spot, so it is made loud instead of tolerated.
        // `env: { TOKEN: "${{ secrets.X }}" }` is valid YAML that this
        // indentation-based reader cannot see into — it would report clean. A
        // scanner that silently cannot read part of its own input is the exact
        // failure this repo has shipped before, so it is a finding regardless of
        // whether a secret is actually in there.
        findings.push({
          rule: "no-secret-in-job-env",
          file,
          line: index + 1,
          detail:
            "flow-style `env:` cannot be analysed by this gate; write it as an indented block",
        });
      } else {
        envIndent = indent;
      }
    }
  }
  return findings;
}

export function scanWorkflows(files) {
  return files.flatMap(({ file, source }) => [
    ...findUnpinnedUses(file, source),
    ...findSecretsInJobEnv(file, source),
  ]);
}

async function collectWorkflows(root) {
  const directory = path.join(root, ".github", "workflows");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (![".yml", ".yaml"].includes(path.extname(entry.name))) continue;
    files.push({
      file: `.github/workflows/${entry.name}`,
      source: await readFile(path.join(directory, entry.name), "utf8"),
    });
  }
  return files;
}

const CONTROL_WORKFLOW = `jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.SOME_TOKEN }}
    steps:
      - uses: actions/checkout@v4
`;

async function main() {
  const root = process.argv[2] ?? process.cwd();
  const files = await collectWorkflows(root);
  if (files.length === 0) {
    console.error(JSON.stringify({ event: "workflow_pins_no_files" }));
    process.exitCode = 1;
    return;
  }

  // Control: BOTH rules must fire on a workflow that commits both mistakes. If a
  // rule has stopped matching, this fails instead of reporting a clean tree.
  const control = scanWorkflows([{ file: "control.yml", source: CONTROL_WORKFLOW }]);
  const firedRules = new Set(control.map((finding) => finding.rule));
  if (RULES.some((rule) => !firedRules.has(rule))) {
    console.error(
      JSON.stringify({
        event: "workflow_pins_control_failed",
        expected: RULES,
        fired: [...firedRules],
      }),
    );
    process.exitCode = 1;
    return;
  }

  const findings = scanWorkflows(files);
  if (findings.length > 0) {
    console.error(JSON.stringify({ event: "workflow_pins", findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      event: "workflow_pins_verified",
      files: files.length,
      rules: RULES.length,
      controls: RULES.length,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
