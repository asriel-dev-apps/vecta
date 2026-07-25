import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, "verify-client-bundle.mjs");

// The scanner's value is entirely in what it REJECTS, so every test here builds a
// fake bundle and asserts the verdict. A clean bundle has to be big enough to
// clear the "did you actually build anything" floor, which is itself the point of
// the last test.
const FILLER = `export const x=${"0".repeat(60_000)};\n`;

function bundleWith(files) {
  const directory = mkdtempSync(path.join(tmpdir(), "vecta-bundle-"));
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "assets", "filler-aaaa.js"), FILLER);
  writeFileSync(path.join(directory, "assets", "b-bbbb.js"), "export const b=1;\n");
  writeFileSync(path.join(directory, "assets", "c-cccc.js"), "export const c=1;\n");
  writeFileSync(path.join(directory, "assets", "d-dddd.js"), "export const d=1;\n");
  writeFileSync(path.join(directory, "assets", "e-eeee.js"), "export const e=1;\n");
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, "assets", name), contents);
  }
  return directory;
}

async function run(directory) {
  try {
    const result = await execute(process.execPath, [script, directory]);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("passes a bundle carrying nothing server-only", async () => {
  const result = await run(bundleWith({}));
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /client_bundle_verified/u);
});

test("rejects a secret name, a connection string, a driver, and a server identifier", async () => {
  for (const [name, contents] of [
    ["leak-1.js", 'const u=env.DATABASE_URL;\n'],
    ["leak-2.js", 'const u="postgresql://user@host/db";\n'],
    ["leak-3.js", 'import{eq}from"drizzle-orm";\n'],
    ["leak-4.js", "const s=createDbSession(env);\n"],
    ["leak-5.js", "await jwtVerify(t,j);\n"],
  ]) {
    const result = await run(bundleWith({ [name]: contents }));
    assert.equal(result.ok, false, `${name} should have been rejected`);
    assert.match(result.stderr, /reached the client bundle/u);
  }
});

test("rejects a client asset built from a .server module, whatever its contents", async () => {
  // The filename alone is the finding: a `.server` module that got a client chunk
  // is a leak by construction, even if this particular chunk looks harmless.
  const result = await run(bundleWith({ "thing.server-a1b2.js": "export const ok=1;\n" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /server-module-shipped/u);
});

test("refuses to pass when there is no bundle to scan", async () => {
  // The failure mode this whole script exists to prevent: a scan that read
  // nothing reports the same "no hits" as a scan of a clean bundle.
  const missing = await run(path.join(tmpdir(), "vecta-bundle-does-not-exist"));
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /no client bundle/u);

  const empty = mkdtempSync(path.join(tmpdir(), "vecta-bundle-empty-"));
  const result = await run(empty);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /looks empty/u);
});
