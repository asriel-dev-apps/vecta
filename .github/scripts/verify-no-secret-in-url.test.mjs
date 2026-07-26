import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES, scanForSecretsInUrls } from "./verify-no-secret-in-url.mjs";

// The first test is the important one: it is the ACTUAL code that shipped the
// defect. If this scanner cannot report that, it is worthless no matter how clean it
// says the tree is.

const THE_ORIGINAL_DEFECT = `
const KEY_PARAM = "__stg";
function equalsConstantTime(a, b) { return a === b; }
const provided = url.searchParams.get(KEY_PARAM);
if (provided !== null && equalsConstantTime(provided, key)) { /* admit */ }
`;

test("reports the exact code that shipped the defect", () => {
  const findings = scanForSecretsInUrls([{ file: "app/server/staging-gate.server.ts", source: THE_ORIGINAL_DEFECT }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "co-located-credential-and-query");
});

test("catches it even though the parameter name looks innocent", () => {
  // This is why a `?secret=` grep would not have been enough: the name was a
  // constant called KEY_PARAM whose value was "__stg".
  assert.ok(!/secret|token|password/iu.test(THE_ORIGINAL_DEFECT));
  assert.equal(scanForSecretsInUrls([{ file: "a.ts", source: THE_ORIGINAL_DEFECT }]).length, 1);
});

test("catches an HMAC-verifying module that reads the query string", () => {
  const source = 'await crypto.subtle.verify("HMAC", k, sig, d); const t = u.searchParams.get("t");';
  assert.equal(scanForSecretsInUrls([{ file: "a.ts", source }]).length, 1);
});

test("catches createHmac / timingSafeEqual alongside a query read", () => {
  for (const primitive of ["createHmac('sha256', k)", "timingSafeEqual(a, b)"]) {
    const source = `${primitive}; const v = url.searchParams.get("v");`;
    assert.equal(scanForSecretsInUrls([{ file: "a.ts", source }]).length, 1, primitive);
  }
});

test("catches a credential-shaped URL parameter literal anywhere", () => {
  for (const literal of [
    'fetch("https://x.example/y?api_key=abc")',
    'const u = "/cb?access_token=" + t;',
    '`/thing?secret=${s}`',
    '"/p?signature=" + sig',
    '"/p?PASSWORD=" + p',
  ]) {
    const findings = scanForSecretsInUrls([{ file: "a.ts", source: literal }]);
    assert.equal(findings.length, 1, literal);
    assert.equal(findings[0].rule, "no-credential-parameter-literal");
  }
});

test("does NOT flag OAuth's own parameters — the spec puts them in a redirect", () => {
  // Listing `code` and `state` would make the rule unusable rather than the app safer.
  const source = 'const code = url.searchParams.get("code"); const state = url.searchParams.get("state");';
  assert.deepEqual(scanForSecretsInUrls([{ file: "auth/callback.ts", source }]), []);
});

test("does NOT flag reading a query string with no credential handling nearby", () => {
  const source = 'const returnTo = url.searchParams.get("returnTo") ?? "/";';
  assert.deepEqual(scanForSecretsInUrls([{ file: "routes/login.tsx", source }]), []);
});

test("does NOT flag credential handling with no query string nearby", () => {
  const source = "if (equalsConstantTime(request.headers.get('x-key'), key)) admit();";
  assert.deepEqual(scanForSecretsInUrls([{ file: "gate.ts", source }]), []);
});

test("does NOT flag the fixed gate — a form POST reads a body, not a URL", () => {
  const source = `
    function equalsConstantTime(a, b) { return a === b; }
    const provided = String((await request.formData()).get("__stg") ?? "");
    if (equalsConstantTime(provided, key)) admit();
  `;
  assert.deepEqual(scanForSecretsInUrls([{ file: "gate.ts", source }]), []);
});

test("exempts test files, which legitimately build a bad URL to assert refusal", () => {
  const findings = scanForSecretsInUrls([
    { file: "test/staging-gate.test.ts", source: THE_ORIGINAL_DEFECT },
  ]);
  assert.deepEqual(findings, []);
});

test("both rules exist and both can fire", () => {
  // Guards against a future edit that leaves one rule present but unreachable.
  assert.equal(RULES.length, 2);
  const fired = new Set(
    scanForSecretsInUrls([
      { file: "a.ts", source: THE_ORIGINAL_DEFECT },
      { file: "b.ts", source: '"/x?api_key=1"' },
    ]).map((finding) => finding.rule),
  );
  assert.deepEqual([...fired].sort(), ["co-located-credential-and-query", "no-credential-parameter-literal"]);
});
