#!/usr/bin/env node
// Two claims about the assistant that would otherwise be conventions someone has
// to remember (Design 0005 §5.4, acceptance A12 + A17):
//
//   A12  A provider swap touches ONE file. Nothing outside the Workers AI adapter
//        names a model or an inference binding — otherwise "swappable provider"
//        is a sentence in a document rather than a property of the code.
//   A17  The proposal path cannot write. The assistant route and its action do not
//        import the command service or the apply helper, so the "read-only"
//        arrow in the design's diagram is checked rather than asserted.
//
// Both break WITHOUT malice. "Small changes could just auto-apply, that would be
// convenient" is the whole failure mode, and it arrives as a helpful patch.
//
// Every rule carries a CONTROL: a pattern that MUST match, so a scanner that has
// silently stopped reading files fails instead of reporting a clean run. A check
// that can only ever say "clean" is indistinguishable from one that is broken.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** The single file allowed to name a provider (Design 0005 §3.4). */
export const ADAPTER_PATH = "apps/web/app/server/llm/workers-ai.server.ts";

/** The proposal path: these files must have no route to the write side. */
export const READ_ONLY_PATHS = [
  "apps/web/app/routes/project.assistant.tsx",
  "apps/web/app/server/project/assistant-action.server.ts",
];

export const RULES = [
  {
    id: "provider-confined-to-adapter",
    // `@cf/` is a Workers AI model id; `.AI.run(` / `env.AI` is its binding.
    forbidden: [/@cf\//u, /\benv\.AI\b/u, /\.AI\.run\s*\(/u],
    // Applies to every source file EXCEPT the adapter itself.
    applies: (file) => file !== ADAPTER_PATH,
    control: { file: ADAPTER_PATH, pattern: /@cf\//u },
  },
  {
    id: "proposal-path-cannot-write",
    // Import- and call-shaped, not bare mentions. The point is to stop the
    // proposal path from REACHING the write side, and a comment that explains
    // which endpoint does the applying is documentation worth keeping — rewording
    // prose to satisfy a regex would be the check bending the code, not the
    // other way round.
    forbidden: [
      /from\s+["'][^"']*apply-commands/u,
      /from\s+["'][^"']*command-action/u,
      /from\s+["'][^"']*project-command-service/u,
      /\bapplyCommands\s*\(/u,
      /\brunCommandAction\s*[(=]/u,
      /\bnew\s+ProjectCommandService\b/u,
    ],
    applies: (file) => READ_ONLY_PATHS.includes(file),
    // If the assistant action ever stops mentioning the proposal builder, this
    // scanner is pointed at the wrong file and must say so.
    control: { file: READ_ONLY_PATHS[1], pattern: /buildProposalDiff|runAssistantAction/u },
  },
];

/**
 * Pure core: given the repo's source files, return the violations and the control
 * results. Separated from the filesystem so the tests can drive it with synthetic
 * inputs — including inputs that MUST fail.
 */
export function scanAssistantBoundary(files) {
  const violations = [];
  const controls = [];

  for (const rule of RULES) {
    for (const { file, source } of files) {
      if (!rule.applies(file)) continue;
      for (const pattern of rule.forbidden) {
        if (pattern.test(source)) {
          violations.push({ rule: rule.id, file, pattern: String(pattern) });
        }
      }
    }
    const controlFile = files.find((entry) => entry.file === rule.control.file);
    const satisfied = controlFile !== undefined && rule.control.pattern.test(controlFile.source);
    controls.push({ rule: rule.id, file: rule.control.file, satisfied });
  }

  return { violations, controls };
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
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectSources(root, relative)));
      continue;
    }
    // The generated Workers runtime typings mention every Cloudflare product,
    // including AI. They are not source, and regenerating them is not a provider
    // change, so they are out of scope for the "one file" claim.
    if (relative.endsWith("worker-configuration.d.ts")) continue;
    // This scanner and its tests carry every forbidden pattern as data; scanning
    // them would be the check reporting on itself.
    if (entry.name.startsWith("verify-assistant-boundary.")) continue;
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
  const { violations, controls } = scanAssistantBoundary(files);

  const brokenControls = controls.filter((control) => !control.satisfied);
  if (brokenControls.length > 0) {
    console.error(JSON.stringify({ event: "assistant_boundary_control_failed", brokenControls }));
    process.exitCode = 1;
    return;
  }
  if (violations.length > 0) {
    console.error(JSON.stringify({ event: "assistant_boundary_violated", violations }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      event: "assistant_boundary_verified",
      files: files.length,
      rules: RULES.length,
      controls: controls.length,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
