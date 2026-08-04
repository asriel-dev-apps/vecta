import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  REQUIRED_MINIMUM_RELEASE_AGE,
  isVersionPinned,
  readExemptions,
  scanWorkspace,
} from "./verify-release-age-policy.mjs";

/**
 * Both directions for all four rules. A gate's false-positive rate is a security
 * property too: one that flags a correct workspace teaches people to bypass it,
 * and the thing being bypassed here is the only automatic defence against a
 * freshly-compromised release.
 */

const COMPLIANT = `packages:
  - apps/*
  - packages/*

minimumReleaseAge: 10080
minimumReleaseAgeStrict: true
`;

function rulesOf(findings) {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

test("the compliant shape passes all four rules", () => {
  assert.deepEqual(scanWorkspace("w.yaml", COMPLIANT), []);
});

test("release-age-declared: CONTROL — an absent value is reported", () => {
  const findings = scanWorkspace("w.yaml", "packages:\n  - apps/*\nminimumReleaseAgeStrict: true\n");
  assert.deepEqual(rulesOf(findings), ["release-age-declared"]);
  assert.match(findings[0].detail, /1440/u);
});

test("release-age-declared: a value BELOW the policy is reported, and its own line is named", () => {
  const source = COMPLIANT.replace("10080", "1440");
  const findings = scanWorkspace("w.yaml", source);
  assert.deepEqual(rulesOf(findings), ["release-age-declared"]);
  assert.equal(findings[0].line, 5);
});

test("release-age-declared: a LONGER wait than the policy passes", () => {
  assert.deepEqual(scanWorkspace("w.yaml", COMPLIANT.replace("10080", "20160")), []);
});

test("release-age-declared: a non-numeric value is reported rather than coerced", () => {
  const findings = scanWorkspace("w.yaml", COMPLIANT.replace("10080", "a-week"));
  assert.deepEqual(rulesOf(findings), ["release-age-declared"]);
});

test("release-age-declared: a QUOTED number is accepted — the quotes are YAML's, not the value's", () => {
  assert.deepEqual(scanWorkspace("w.yaml", COMPLIANT.replace("10080", "'10080'")), []);
});

test("release-age-declared: an indented key of the same name is NOT the setting", () => {
  // pnpm reads this setting at the top level only, so neither does the gate —
  // otherwise a nested lookalike would satisfy it while pnpm ignored it.
  const source = `packages:\n  - apps/*\n  minimumReleaseAge: 10080\nminimumReleaseAgeStrict: true\n`;
  assert.deepEqual(rulesOf(scanWorkspace("w.yaml", source)), ["release-age-declared"]);
});

test("auto-exemption-disabled: CONTROL — a missing strict flag is reported", () => {
  const findings = scanWorkspace("w.yaml", "packages:\n  - apps/*\nminimumReleaseAge: 10080\n");
  assert.deepEqual(rulesOf(findings), ["auto-exemption-disabled"]);
  assert.match(findings[0].detail, /appending/u);
});

test("auto-exemption-disabled: `false` is reported too, not just absence", () => {
  const source = COMPLIANT.replace("minimumReleaseAgeStrict: true", "minimumReleaseAgeStrict: false");
  assert.deepEqual(rulesOf(scanWorkspace("w.yaml", source)), ["auto-exemption-disabled"]);
});

test("exemptions-are-justified: CONTROL — a bare entry, the shape pnpm writes itself, is reported", () => {
  // Verbatim from a measured pnpm 11.12.0 auto-append: quoted, no comment.
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  - '@tanstack/react-virtual@3.14.9'
`;
  const findings = scanWorkspace("w.yaml", source);
  assert.deepEqual(rulesOf(findings), ["exemptions-are-justified"]);
  assert.equal(findings[0].line, 9);
});

test("exemptions-are-justified: a commented entry passes", () => {
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # Taken early on purpose: it is the fix named by GHSA-7p8r-x3mc-p8w7.
  - 'some-package@1.2.3'
`;
  assert.deepEqual(scanWorkspace("w.yaml", source), []);
});

test("exemptions-are-justified: one comment does NOT cover the entry after it", () => {
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # Only the first one has a reason, and it cites CVE-2026-12345.
  - 'some-package@1.2.3'
  - 'other-package@4.5.6'
`;
  const findings = scanWorkspace("w.yaml", source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /other-package@4\.5\.6/u);
});

test("exemptions-cite-an-advisory: CONTROL — a justified entry naming no advisory is reported", () => {
  // The lane exists so a PATCHED version can skip the cooldown. "We need it" is a
  // reason available to every exemption, good or bad; an advisory id points at a
  // report someone else published on a date, which a reviewer can go and read.
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # We need this now, the build is red.
  - 'some-package@1.2.3'
`;
  const findings = scanWorkspace("w.yaml", source);
  assert.deepEqual(rulesOf(findings), ["exemptions-cite-an-advisory"]);
});

test("exemptions-cite-an-advisory: GHSA and CVE forms are both accepted", () => {
  for (const id of ["GHSA-7p8r-x3mc-p8w7", "CVE-2026-12345", "ghsa-mwp4-54f8-5fhr"]) {
    const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # Patched release for ${id}; diff read, no new deps or install scripts.
  - 'some-package@1.2.3'
`;
    assert.deepEqual(scanWorkspace("w.yaml", source), [], id);
  }
});

test("exemptions-cite-an-advisory: stays quiet on an entry rule 3 already reports", () => {
  // Two findings for one defect is how a list gets skimmed, and the skimming is
  // what the whole gate exists to prevent.
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  - 'some-package@1.2.3'
`;
  assert.deepEqual(rulesOf(scanWorkspace("w.yaml", source)), ["exemptions-are-justified"]);
});

test("exemptions-are-justified: flow style is REFUSED rather than silently skipped", () => {
  // The blind spot made loud: this reader cannot see inside a one-line sequence,
  // so it must not report clean on one. Note the entries here are irreproachable —
  // being unanalysable is itself the finding.
  const source = `${COMPLIANT}
minimumReleaseAgeExclude: ['some-package@1.2.3']
`;
  const findings = scanWorkspace("w.yaml", source);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /flow-style/u);
});

test("exemptions-are-version-pinned: CONTROL — a bare package name is reported", () => {
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # A reason citing GHSA-mwp4-54f8-5fhr, so only the missing version is at fault here.
  - some-package
`;
  const findings = scanWorkspace("w.yaml", source);
  assert.deepEqual(rulesOf(findings), ["exemptions-are-version-pinned"]);
});

test("exemptions-are-version-pinned: a SCOPED name's leading @ is not a version", () => {
  assert.equal(isVersionPinned("@tanstack/react-virtual"), false);
  assert.equal(isVersionPinned("@tanstack/react-virtual@3.14.9"), true);
  assert.equal(isVersionPinned("hono"), false);
  assert.equal(isVersionPinned("hono@4.12.30"), true);
});

test("readExemptions: quotes are stripped and the block ends at the next top-level key", () => {
  const source = `${COMPLIANT}
minimumReleaseAgeExclude:
  # reason
  - 'hono@4.12.30'

overrides:
  - not-an-exemption@1.0.0
`;
  const { entries } = readExemptions(source);
  assert.deepEqual(
    entries.map(({ entry }) => entry),
    ["hono@4.12.30"],
  );
});

test("the real pnpm-workspace.yaml passes every rule", async () => {
  const source = await readFile(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.deepEqual(scanWorkspace("pnpm-workspace.yaml", source), []);
  assert.equal(REQUIRED_MINIMUM_RELEASE_AGE, 10080);
});
