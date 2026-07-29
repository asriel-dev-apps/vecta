#!/usr/bin/env node
// The dependency-maturity policy, checked instead of trusted.
//
// A package that was published minutes ago is the shape a compromised release
// takes: the window between "the attacker pushed it" and "the registry pulled
// it" is measured in hours, and `pnpm install` closes that window for us by
// refusing anything younger than `minimumReleaseAge`. The value is 7 days,
// decided by the user on 2026-07-26.
//
// WHY A GATE AND NOT JUST THE SETTING — measured with pnpm 11.12.0 on
// 2026-07-29, in an isolated workspace, both directions:
//
//   * With `minimumReleaseAge` set explicitly, an under-age dependency fails the
//     install (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`, exit 1) and nothing is
//     written. This is the posture we want.
//   * With the setting ABSENT, pnpm applies its built-in default of 1440 minutes
//     and enforces it by APPENDING the offending versions to
//     `minimumReleaseAgeExclude` and carrying on at exit 0. A protection that
//     writes its own exemptions is a prompt nobody reads.
//   * `minimumReleaseAgeStrict: true` turns that append back into a hard failure
//     even when the age value is missing. It is the second lock: remove the
//     value and the policy weakens to one day, but it does not go silent.
//
// So the danger is not the setting failing — it is the setting being REMOVED, or
// somebody getting past a red install by writing the offending version into the
// exclude list. Both are one-line edits that read as housekeeping in a diff.
//
// FOUR rules, each with a CONTROL that must fire on synthetic input every run.
// A scanner that can only ever say "clean" is indistinguishable from a broken
// one; this repo has shipped exactly that mistake before.
//
//   1. release-age-declared          — the value is present and at least 7 days.
//   2. auto-exemption-disabled       — `minimumReleaseAgeStrict: true`.
//   3. exemptions-are-justified      — every exclude entry carries a comment
//                                      saying why. pnpm's own append writes a
//                                      bare entry, so this separates "a human
//                                      decided" from "a tool wrote it".
//   4. exemptions-are-version-pinned — an entry with no `@version` asks for a
//                                      blanket exemption of every future release
//                                      of that package, forever.
//
// Parsed by indentation rather than with a YAML library, deliberately: adding a
// parser dependency to a supply-chain gate is the wrong trade — the gate would
// then be defended by the thing it exists to police.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** 7 days, in minutes. The user's decision, 2026-07-26. */
export const REQUIRED_MINIMUM_RELEASE_AGE = 10080;

export const RULES = [
  "release-age-declared",
  "auto-exemption-disabled",
  "exemptions-are-justified",
  "exemptions-are-version-pinned",
];

/** Indentation width of a line, treating tabs as one column (YAML forbids them anyway). */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  return line.trim() === "";
}

function isComment(line) {
  return line.trimStart().startsWith("#");
}

/** Strip YAML's single or double quotes from a scalar. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read a top-level scalar setting. Returns `{ value, line }`, or null when the
 * key is absent. Only column 0 counts: a key nested under `packages:` is not this
 * setting, and pnpm would not read it as one either.
 */
function readTopLevelScalar(lines, key) {
  for (const [index, line] of lines.entries()) {
    if (isBlank(line) || isComment(line) || indentOf(line) !== 0) continue;
    const match = new RegExp(`^${key}:\\s*(.*)$`, "u").exec(line);
    if (match === null) continue;
    return { value: unquote(match[1] ?? ""), line: index + 1 };
  }
  return null;
}

/**
 * Collect the `minimumReleaseAgeExclude` entries with the comment state that
 * precedes each one.
 *
 * Returns `{ entries, flowStyle }`. `flowStyle` is the line number of a one-line
 * `minimumReleaseAgeExclude: [...]`, which this reader cannot see into — made
 * loud rather than skipped, for the same reason as everything else here.
 */
export function readExemptions(source) {
  const lines = source.split("\n");
  const entries = [];
  let flowStyle = null;

  for (const [index, line] of lines.entries()) {
    if (isBlank(line) || isComment(line) || indentOf(line) !== 0) continue;
    const match = /^minimumReleaseAgeExclude:\s*(.*)$/u.exec(line);
    if (match === null) continue;

    if ((match[1] ?? "").trim() !== "") {
      flowStyle = index + 1;
      break;
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor];
      if (item === undefined) break;
      if (isBlank(item)) continue;
      if (indentOf(item) === 0 && !isComment(item)) break;
      if (isComment(item)) continue;
      const itemMatch = /^\s*-\s*(.+?)\s*$/u.exec(item);
      if (itemMatch === null) continue;

      // The justification must sit directly above the entry. A blank line is
      // allowed between them; another entry is not.
      let justified = false;
      for (let back = cursor - 1; back > index; back -= 1) {
        const previous = lines[back];
        if (previous === undefined || isBlank(previous)) continue;
        justified = isComment(previous);
        break;
      }

      entries.push({
        entry: unquote(itemMatch[1]),
        line: cursor + 1,
        justified,
      });
    }
    break;
  }

  return { entries, flowStyle };
}

/** Does an exclude entry name an exact version, rather than a whole package? */
export function isVersionPinned(entry) {
  const at = entry.lastIndexOf("@");
  // A scoped package's leading `@` is part of the name, so it does not count.
  return at > 0 && entry.slice(at + 1).trim() !== "";
}

export function scanWorkspace(file, source) {
  const findings = [];
  const lines = source.split("\n");

  const age = readTopLevelScalar(lines, "minimumReleaseAge");
  if (age === null) {
    findings.push({
      rule: "release-age-declared",
      file,
      line: 0,
      detail:
        `\`minimumReleaseAge\` is absent, so pnpm falls back to its default of 1440 minutes ` +
        `AND enforces that default by writing its own exemptions; set it to ` +
        `${REQUIRED_MINIMUM_RELEASE_AGE}`,
    });
  } else if (!/^\d+$/u.test(age.value) || Number(age.value) < REQUIRED_MINIMUM_RELEASE_AGE) {
    findings.push({
      rule: "release-age-declared",
      file,
      line: age.line,
      detail:
        `\`minimumReleaseAge\` is \`${age.value}\`; the policy is ` +
        `${REQUIRED_MINIMUM_RELEASE_AGE} minutes (7 days) or more`,
    });
  }

  const strict = readTopLevelScalar(lines, "minimumReleaseAgeStrict");
  if (strict === null || strict.value !== "true") {
    findings.push({
      rule: "auto-exemption-disabled",
      file,
      line: strict?.line ?? 0,
      detail:
        "`minimumReleaseAgeStrict` must be `true`; without it pnpm answers an age " +
        "violation by appending the offending versions to `minimumReleaseAgeExclude` " +
        "and exiting 0",
    });
  }

  const { entries, flowStyle } = readExemptions(source);
  if (flowStyle !== null) {
    findings.push({
      rule: "exemptions-are-justified",
      file,
      line: flowStyle,
      detail:
        "flow-style `minimumReleaseAgeExclude: [...]` cannot be analysed by this gate; " +
        "write it as an indented block",
    });
  }

  for (const { entry, line, justified } of entries) {
    if (!justified) {
      findings.push({
        rule: "exemptions-are-justified",
        file,
        line,
        detail:
          `\`${entry}\` carries no comment saying why it is exempt. pnpm writes bare ` +
          "entries when it exempts a package for you — if this one is yours, say what it is for",
      });
    }
    if (!isVersionPinned(entry)) {
      findings.push({
        rule: "exemptions-are-version-pinned",
        file,
        line,
        detail:
          `\`${entry}\` names no version, so it would exempt every future release of that ` +
          "package; pin the exact version being exempted",
      });
    }
  }

  return findings;
}

// Commits all four mistakes at once: no age, no strict, an unjustified entry and
// an unpinned one.
const CONTROL_WORKSPACE = `packages:
  - apps/*

minimumReleaseAgeExclude:
  - some-package@1.2.3
  - blanket-package
`;

async function main() {
  const root = process.argv[2] ?? process.cwd();
  const file = "pnpm-workspace.yaml";
  let source;
  try {
    source = await readFile(path.join(root, file), "utf8");
  } catch {
    console.error(JSON.stringify({ event: "release_age_policy_no_file", file }));
    process.exitCode = 1;
    return;
  }

  // Control: all four rules must fire on a workspace that commits all four
  // mistakes. If a rule has stopped matching, this fails instead of reporting a
  // clean tree.
  const control = scanWorkspace("control.yaml", CONTROL_WORKSPACE);
  const firedRules = new Set(control.map((finding) => finding.rule));
  if (RULES.some((rule) => !firedRules.has(rule))) {
    console.error(
      JSON.stringify({
        event: "release_age_policy_control_failed",
        expected: RULES,
        fired: [...firedRules],
      }),
    );
    process.exitCode = 1;
    return;
  }

  const findings = scanWorkspace(file, source);
  if (findings.length > 0) {
    console.error(JSON.stringify({ event: "release_age_policy", findings }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { entries } = readExemptions(source);
  console.log(
    JSON.stringify({
      event: "release_age_policy_verified",
      minimumReleaseAge: REQUIRED_MINIMUM_RELEASE_AGE,
      exemptions: entries.length,
      rules: RULES.length,
      controls: RULES.length,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
