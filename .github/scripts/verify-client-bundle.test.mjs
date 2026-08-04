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

test("rejects the two credentials the hand-written secret list used to miss", async () => {
  // Both were declared in `Env` and absent from the old four-name pattern
  // (measured 2026-08-04). `SESSION_SECRET_PREVIOUS` is the instructive one:
  // `\bSESSION_SECRET\b` does not match it, because `_` is a word character — so
  // the list looked like it covered a name it did not. The names are DERIVED from
  // `env.d.ts` now, and these assertions are what makes a broken derivation loud.
  for (const [name, contents] of [
    ["leak-6.js", "const k=env.STAGING_ACCESS_KEY;\n"],
    ["leak-7.js", "const k=env.SESSION_SECRET_PREVIOUS;\n"],
  ]) {
    const result = await run(bundleWith({ [name]: contents }));
    assert.equal(result.ok, false, `${name} should have been rejected`);
    assert.match(result.stderr, /secret-name/u);
  }
});

test("rejects the server-only dependencies the rule named but did not match", async () => {
  // The rule's own prose said "hono … and the MCP SDK", and its pattern contained
  // neither. `agents/mcp` builds the `/mcp` surface and was likewise unmatched.
  for (const [name, contents] of [
    ["leak-8.js", 'import{Hono}from"hono";\n'],
    ["leak-9.js", 'import{cors}from"hono/cors";\n'],
    ["leak-10.js", 'import{createMcpHandler}from"agents/mcp";\n'],
    ["leak-11.js", 'import * as jose from "jose";\n'],
    // SCOPED names, which the first version of this rule could not match at all:
    // `\b` before `@` never holds, because neither side is a word character. Two
    // of the eight shared packages were unmatchable, and the tests as first
    // written happened to probe only the unscoped ones.
    ["leak-12.js", 'import{X}from"@modelcontextprotocol/sdk";\n'],
    ["leak-13.js", 'import{neon}from"@neondatabase/serverless";\n'],
    // A package name can also survive as a path segment rather than a specifier.
    ["leak-14.js", "//# sourceMappingURL=../node_modules/hono/dist/index.js.map\n"],
    ["leak-15.js", 'await import("agents/mcp");\n'],
  ]) {
    const result = await run(bundleWith({ [name]: contents }));
    assert.equal(result.ok, false, `${name} should have been rejected`);
    assert.match(result.stderr, /server-only-dependency|persistence-driver/u);
  }
});

test("passes browser code whose text merely resembles a server dependency", async () => {
  // The other direction, and the reason the package names are matched in
  // module-specifier position rather than as bare words. A gate that flags
  // correct bundles teaches people to bypass it, which is a security property.
  // Every line here was a FALSE POSITIVE of the first version of the rule.
  for (const [name, contents] of [
    ["ok-1.js", 'const ua=navigator.userAgent;const s="phonon";const t="josephine";\n'],
    ["ok-2.js", "let a,pg,c;a=1;c=2;\n"], // a minifier-allocated name
    ["ok-3.js", "const o={};o.pg=1;o.hono=2;\n"], // properties, not modules
    ["ok-4.js", 'const label="Manage agents";\n'], // ordinary UI text
    ["ok-5.js", 'const route="/agents/list";\n'], // an application route
  ]) {
    const result = await run(bundleWith({ [name]: contents }));
    assert.equal(result.ok, true, `${name} should have passed: ${result.stderr}`);
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
