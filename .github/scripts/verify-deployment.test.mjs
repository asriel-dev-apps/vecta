import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, "verify-deployment.mjs");

const LIVE_ASSET = "entry.client-AAAA1111.js";
const STALE_ASSET = "entry.client-BBBB2222.js";

/**
 * Run `verify-deployment.mjs` against a stand-in Worker. `routes` is a function
 * of the (dynamically assigned) origin, because the MCP metadata document has to
 * advertise that origin to be correct.
 */
async function verify({ routes, assets = [LIVE_ASSET], env = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), "vecta-verify-deploy-"));
  const assetsDir = path.join(root, "assets");
  await mkdir(assetsDir, { recursive: true });
  for (const asset of assets) await writeFile(path.join(assetsDir, asset), "");

  let table = {};
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const handler = table[`${request.method} ${url.pathname}`] ?? table[url.pathname];
    if (handler === undefined) {
      response.writeHead(404).end();
      return;
    }
    const { status = 200, headers = {}, body = "" } = handler;
    response.writeHead(status, headers).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  table = routes(baseUrl);

  try {
    return await execute(process.execPath, [script], {
      env: {
        ...process.env,
        VECTA_BASE_URL: baseUrl,
        MCP_RESOURCE_URL: `${baseUrl}/mcp`,
        VECTA_CLIENT_ASSETS: assetsDir,
        VECTA_VERIFY_TIMEOUT_MS: "1500",
        VECTA_VERIFY_INTERVAL_MS: "100",
        ...env,
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

function document(asset) {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: `<!DOCTYPE html><html><head><script src="/assets/${asset}"></script></head><body></body></html>`,
  };
}

function json(body, status = 200) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const MCP_CHALLENGE = {
  status: 401,
  headers: {
    "www-authenticate":
      'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource/mcp"',
  },
};

/** A fully correct deployment; each test overrides the one route it breaks. */
function healthyRoutes(baseUrl, overrides = {}) {
  return {
    "/": document(LIVE_ASSET),
    "/api/health": json({ status: "ok" }),
    "/.well-known/oauth-protected-resource/mcp": json({ resource: `${baseUrl}/mcp` }),
    "POST /mcp": MCP_CHALLENGE,
    ...overrides,
  };
}

async function expectFailure(options, pattern) {
  await assert.rejects(
    () => verify(options),
    (error) => {
      assert.match(String(error.stderr), pattern);
      return true;
    },
  );
}

test("passes when the served bundle, health, and both MCP surfaces are correct", async () => {
  const result = await verify({ routes: (baseUrl) => healthyRoutes(baseUrl) });
  assert.match(result.stdout, /deployment_verified/u);
});

test("fails when the edge still serves the previous bundle", async () => {
  // The trap this script exists for: `wrangler deploy` reports success and a new
  // version id, and users keep getting the old app.
  await expectFailure(
    { routes: (baseUrl) => healthyRoutes(baseUrl, { "/": document(STALE_ASSET) }) },
    new RegExp(`still serving /assets/${STALE_ASSET}`, "u"),
  );
});

test("fails when the document references no assets at all", async () => {
  await expectFailure(
    {
      routes: (baseUrl) =>
        healthyRoutes(baseUrl, { "/": { status: 200, body: "<!DOCTYPE html><html></html>" } }),
    },
    /no \/assets\/\* references/u,
  );
});

test("fails when /api/health is not ok", async () => {
  await expectFailure(
    { routes: (baseUrl) => healthyRoutes(baseUrl, { "/api/health": { status: 503 } }) },
    /\/api\/health returned 503/u,
  );
});

test("fails when the MCP metadata advertises a different resource", async () => {
  // A mismatch means tokens were minted for a different audience than the one
  // the deployment now advertises — every MCP call would fail authentication.
  await expectFailure(
    {
      routes: (baseUrl) =>
        healthyRoutes(baseUrl, {
          "/.well-known/oauth-protected-resource/mcp": json({
            resource: "https://elsewhere.example.test/mcp",
          }),
        }),
    },
    /advertises https:\/\/elsewhere\.example\.test\/mcp/u,
  );
});

test("fails when an unauthenticated POST /mcp is not refused", async () => {
  await expectFailure(
    { routes: (baseUrl) => healthyRoutes(baseUrl, { "POST /mcp": json({}, 200) }) },
    /returned 200, expected 401/u,
  );
});

test("fails when the 401 from /mcp carries no resource_metadata challenge", async () => {
  await expectFailure(
    { routes: (baseUrl) => healthyRoutes(baseUrl, { "POST /mcp": { status: 401 } }) },
    /no resource_metadata challenge/u,
  );
});

test("requires the base URL and the MCP resource identifier", async () => {
  await expectFailure(
    { routes: (baseUrl) => healthyRoutes(baseUrl), env: { VECTA_BASE_URL: "" } },
    /VECTA_BASE_URL is required/u,
  );
});
