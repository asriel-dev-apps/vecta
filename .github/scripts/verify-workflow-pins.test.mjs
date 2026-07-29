import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSecretsInJobEnv,
  findUnpinnedUses,
  scanWorkflows,
} from "./verify-workflow-pins.mjs";

/**
 * Both directions are tested for both rules. A gate's false-positive rate is a
 * security property too: one that flags correct workflows teaches people to
 * bypass it, which is worse than not having it.
 */

const SHA = "11d5960a326750d5838078e36cf38b85af677262";

test("sha-pinned-actions: CONTROL — a tag pin is reported", () => {
  const findings = findUnpinnedUses("w.yml", "      - uses: actions/checkout@v4\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "sha-pinned-actions");
  assert.equal(findings[0].line, 1);
});

test("sha-pinned-actions: a branch or a floating major is reported too", () => {
  const source = [
    "      - uses: some/action@main",
    "      - uses: other/action@v4.4.0",
  ].join("\n");
  assert.equal(findUnpinnedUses("w.yml", source).length, 2);
});

test("sha-pinned-actions: a reference with no version at all is reported", () => {
  const findings = findUnpinnedUses("w.yml", "      - uses: some/action\n");
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /no version/u);
});

test("sha-pinned-actions: a SHA pin passes, and its trailing version comment does not confuse it", () => {
  assert.deepEqual(findUnpinnedUses("w.yml", `      - uses: actions/checkout@${SHA} # v4.4.0\n`), []);
});

test("sha-pinned-actions: a local action and a commented-out line are exempt", () => {
  const source = [
    "      - uses: ./.github/actions/setup",
    "      # - uses: actions/checkout@v4",
  ].join("\n");
  assert.deepEqual(findUnpinnedUses("w.yml", source), []);
});

test("no-secret-in-job-env: CONTROL — a job-level env carrying a secret is reported", () => {
  const source = [
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "    steps:",
    `      - uses: actions/checkout@${SHA}`,
  ].join("\n");
  const findings = findSecretsInJobEnv("w.yml", source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "no-secret-in-job-env");
  assert.equal(findings[0].line, 5);
});

test("no-secret-in-job-env: a STEP-level env carrying a secret passes — that is the fix", () => {
  const source = [
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      ACCOUNT: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    "    steps:",
    "      - name: Deploy",
    "        env:",
    "          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: wrangler deploy",
  ].join("\n");
  assert.deepEqual(findSecretsInJobEnv("w.yml", source), []);
});

test("no-secret-in-job-env: a job-level env of non-secret vars passes", () => {
  const source = [
    "jobs:",
    "  deploy:",
    "    env:",
    "      ACCOUNT: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    "      NAME: ${{ vars.WORKER_NAME }}",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert.deepEqual(findSecretsInJobEnv("w.yml", source), []);
});

test("no-secret-in-job-env: the block ends where indentation returns, so a later step secret is not misattributed", () => {
  const source = [
    "jobs:",
    "  deploy:",
    "    env:",
    "      ACCOUNT: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    "    steps:",
    "      - name: Deploy",
    "        env:",
    "          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: wrangler deploy",
  ].join("\n");
  assert.deepEqual(findSecretsInJobEnv("w.yml", source), []);
});

test("the real workflows pass BOTH rules", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL("../workflows/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".yml"));
  assert.ok(names.length >= 2, "expected at least ci.yml and deploy.yml");
  const files = await Promise.all(
    names.map(async (name) => ({
      file: name,
      source: await readFile(new URL(name, directory), "utf8"),
    })),
  );
  assert.deepEqual(scanWorkflows(files), []);
});
