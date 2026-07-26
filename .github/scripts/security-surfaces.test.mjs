import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_TRAILER,
  SURFACES,
  classifySurfaces,
  parseDiff,
  parseReviewedSurfaces,
} from "./security-surfaces.mjs";

// The first test is the one that matters: the change that shipped `?__stg=<key>` must
// classify as a credential surface. A classifier that cannot flag the diff it was
// written for is decoration.

const THE_DEFECTIVE_DIFF = `
diff --git a/apps/web/app/server/staging-gate.server.ts b/apps/web/app/server/staging-gate.server.ts
--- a/apps/web/app/server/staging-gate.server.ts
+++ b/apps/web/app/server/staging-gate.server.ts
@@ -0,0 +1,4 @@
+const KEY_PARAM = "__stg";
+const key = env.STAGING_ACCESS_KEY?.trim();
+const provided = url.searchParams.get(KEY_PARAM);
+if (provided !== null && equalsConstantTime(provided, key)) return { response: null };
`;

function idsFor(diff) {
  return classifySurfaces(parseDiff(diff))
    .map((entry) => entry.surface.id)
    .sort();
}

test("flags the diff that shipped the defect as a credential surface", () => {
  assert.ok(idsFor(THE_DEFECTIVE_DIFF).includes("credential"));
});

test("hands back the questions that would have caught it", () => {
  const credential = classifySurfaces(parseDiff(THE_DEFECTIVE_DIFF)).find((e) => e.surface.id === "credential");
  const asked = credential.surface.questions.join(" ");
  // The one question that resolves it in a single step.
  assert.match(asked, /URL/u);
  assert.match(asked, /どの経路を通る/u);
});

test("shows the evidence, so an over-inclusive hit is cheap to dismiss", () => {
  const [entry] = classifySurfaces(parseDiff(THE_DEFECTIVE_DIFF));
  assert.ok(entry.evidence.length > 0);
  assert.match(entry.evidence[0].file, /staging-gate/u);
  assert.ok("line" in entry.evidence[0] || "path" in entry.evidence[0]);
});

test("flags a new route as an externally reachable surface", () => {
  const diff = `
+++ b/apps/web/app/routes/project.assistant.tsx
@@
+export async function action(args) { return runAssistantAction(args); }
`;
  assert.ok(idsFor(diff).includes("surface"));
});

test("flags an authorization decision", () => {
  const diff = `
+++ b/apps/web/app/server/project/thing.server.ts
@@
+  if (membership.projectRole === "VIEWER") return forbidden();
`;
  assert.ok(idsFor(diff).includes("authz"));
});

test("flags cookies and security headers", () => {
  const diff = `
+++ b/apps/web/app/server/x.server.ts
@@
+  headers.set("set-cookie", "a=b; HttpOnly; Secure; SameSite=Lax");
`;
  assert.ok(idsFor(diff).includes("cookie-header"));
});

test("flags a new deploy target — the case that started this", () => {
  const diff = `
+++ b/.github/workflows/deploy-staging.yml
@@
+  run: npx wrangler deploy -c build/server/wrangler.json
`;
  const ids = idsFor(diff);
  assert.ok(ids.includes("deploy-target"));
  // A new environment adds every surface at once, so its section list says so.
  const target = SURFACES.find((surface) => surface.id === "deploy-target");
  assert.deepEqual(target.sections, ["*"]);
});

test("flags the data boundary", () => {
  const diff = `
+++ b/packages/persistence/src/reader.ts
@@
+  const rows = await db.select().from(tasks);
`;
  assert.ok(idsFor(diff).includes("data-boundary"));
});

test("stays quiet on a change that touches none of it", () => {
  const diff = `
+++ b/apps/web/app/wbs/styles.css
@@
+.assistant-input { flex: none; min-height: 3lh; }
`;
  assert.deepEqual(idsFor(diff), []);
});

test("ignores deletions — removing an HMAC is a question about its replacement", () => {
  const diff = `
+++ b/a.ts
@@
-  const mac = createHmac("sha256", key);
`;
  assert.deepEqual(idsFor(diff), []);
});

test("parses only added lines, and drops files with none", () => {
  const files = parseDiff(`
+++ b/kept.ts
@@
+added
+++ b/removed-only.ts
@@
-gone
`);
  assert.deepEqual(files.map((f) => f.file), ["kept.ts"]);
});

test("every surface names both the checklist sections and its own questions", () => {
  // Guards against a surface that fires but tells the reader nothing to do.
  for (const surface of SURFACES) {
    assert.ok(surface.sections.length > 0, surface.id);
    assert.ok(surface.questions.length > 0, surface.id);
    assert.ok((surface.patterns ?? []).length + (surface.paths ?? []).length > 0, surface.id);
  }
});

test("the review trailer has a stable name, since CI keys on it", () => {
  assert.equal(REVIEW_TRAILER, "Security-Reviewed");
});

// Regression: the gate's FIRST real use recorded the line and was told it was
// missing, because git only treats the last paragraph of a message as trailers.
// A gate whose correct usage is a trap gets worked around rather than used.
test("counts a Security-Reviewed line even when it is not git's last paragraph", () => {
  const message = [
    "feat: something",
    "",
    "Security-Reviewed: credential, authz",
    "",
    "Co-Authored-By: someone <x@example.invalid>",
    "Claude-Session: https://example.invalid",
  ].join("\n");
  assert.deepEqual([...parseReviewedSurfaces(message)].sort(), ["authz", "credential"]);
});

test("counts it in the trailer block too, and is case-insensitive about the key", () => {
  assert.deepEqual([...parseReviewedSurfaces("x\n\nsecurity-reviewed: surface")], ["surface"]);
});

test("gathers surfaces across several commits in the range", () => {
  const log = "feat: a\n\nSecurity-Reviewed: credential\nfeat: b\n\nSecurity-Reviewed: authz";
  assert.deepEqual([...parseReviewedSurfaces(log)].sort(), ["authz", "credential"]);
});

test("finds nothing when nothing was recorded — the gate must still be able to fail", () => {
  assert.deepEqual([...parseReviewedSurfaces("feat: no review here\n\nCo-Authored-By: x")], []);
});

// The two surfaces added after comparing the checklist against ASVS 5.0 chapter by
// chapter. `logging` is the one that matters most: it is where the incident that
// prompted this whole exercise LANDED — a key in a query string is a key written
// verbatim into request logs — and the checklist had no logging class at all.
test("flags code that writes to a log", () => {
  const diff = `
+++ b/apps/web/app/server/x.server.ts
@@
+  console.error("failed for", principal.id);
`;
  assert.ok(idsFor(diff).includes("logging"));
});

test("flags session and token handling", () => {
  for (const line of [
    "+  const { payload } = await jwtVerify(token, jwks);",
    "+  const codeVerifier = makeVerifier(); // code_verifier",
    "+  await writeSession(response, principal);",
  ]) {
    const diff = `\n+++ b/apps/web/app/server/auth/x.server.ts\n@@\n${line}\n`;
    assert.ok(idsFor(diff).includes("session-token"), line);
  }
});

test("every surface names the ASVS chapters it maps to", () => {
  // Without this the surface tells a reader which questions to ask but not where the
  // authoritative wording lives, and the two references drift apart.
  for (const surface of SURFACES) {
    assert.ok(Array.isArray(surface.asvs) && surface.asvs.length > 0, surface.id);
    for (const chapter of surface.asvs) assert.match(chapter, /^V\d+ /u, surface.id);
  }
});
