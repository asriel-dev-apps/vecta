import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, "materialize-deploy-config.mjs");

const HOST = "https://vecta.example.test";

const VALID_ENV = {
  WORKER_NAME: "vecta",
  OIDC_ISSUER: "https://accounts.google.example.test",
  OIDC_CLIENT_ID: "1234-abc.apps.googleusercontent.example.test",
  OIDC_JWKS_URL: "https://www.googleapis.example.test/oauth2/v3/certs",
  OIDC_REDIRECT_URI: `${HOST}/auth/callback`,
  OIDC_AUTH_ENDPOINT: "https://accounts.google.example.test/o/oauth2/v2/auth",
  OIDC_TOKEN_ENDPOINT: "https://oauth2.googleapis.example.test/token",
  MCP_RESOURCE_URL: `${HOST}/mcp`,
  PRE_AUTH_RATE_LIMIT_NAMESPACE_ID: "2001",
  AUTH_RATE_LIMIT_NAMESPACE_ID: "2002",
  COMPUTE_RATE_LIMIT_NAMESPACE_ID: "2003",
};

/** A built config shaped like what `react-router build` emits for apps/web. */
function builtConfig(overrides = {}) {
  return {
    name: "vecta-next-local",
    main: "index.js",
    compatibility_date: "2026-07-17",
    assets: { binding: "ASSETS", directory: "../client" },
    vars: {
      OIDC_ISSUER: "https://accounts.google.example.invalid",
      OIDC_CLIENT_ID: "vecta-web-next-local.apps.googleusercontent.invalid",
      OIDC_JWKS_URL: "https://www.googleapis.example.invalid/oauth2/v3/certs",
      OIDC_REDIRECT_URI: "https://vecta-next.example.invalid/auth/callback",
      OIDC_AUTH_ENDPOINT: "https://accounts.google.example.invalid/o/oauth2/v2/auth",
      OIDC_TOKEN_ENDPOINT: "https://oauth2.googleapis.example.invalid/token",
      MCP_RESOURCE_URL: "https://vecta-next.example.invalid/mcp",
    },
    ratelimits: [
      { name: "PRE_AUTH_RATE_LIMIT", namespace_id: "1", simple: { limit: 120, period: 60 } },
      { name: "AUTH_RATE_LIMIT", namespace_id: "2", simple: { limit: 120, period: 60 } },
      { name: "COMPUTE_RATE_LIMIT", namespace_id: "3", simple: { limit: 10, period: 60 } },
    ],
    ...overrides,
  };
}

async function run(env, config = builtConfig()) {
  const root = await mkdtemp(path.join(tmpdir(), "vecta-deploy-config-"));
  const configPath = path.join(root, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  try {
    const result = await execute(process.execPath, [script], {
      env: { ...process.env, ...env, WEB_CONFIG: configPath },
    });
    return { result, config: JSON.parse(await readFile(configPath, "utf8")) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectRejection(env, pattern, config = builtConfig()) {
  await assert.rejects(() => run(env, config), (error) => {
    assert.match(String(error.stderr ?? error.message), pattern);
    return true;
  });
}

test("materializes every placeholder var, the namespace ids, and the worker name", async () => {
  const { result, config } = await run(VALID_ENV);

  assert.match(result.stdout, /deploy_config_materialized/u);
  // The whole point: the deployed config carries no placeholder.
  assert.doesNotMatch(JSON.stringify(config), /\.invalid/u);
  assert.equal(config.name, "vecta");
  assert.equal(config.vars.OIDC_CLIENT_ID, VALID_ENV.OIDC_CLIENT_ID);
  assert.equal(config.vars.MCP_RESOURCE_URL, `${HOST}/mcp`);
  assert.equal(config.vars.OIDC_REDIRECT_URI, `${HOST}/auth/callback`);
  assert.deepEqual(
    config.ratelimits.map((binding) => binding.namespace_id),
    ["2001", "2002", "2003"],
  );
  // Untouched by materializing — they come from the build.
  assert.equal(config.compatibility_date, "2026-07-17");
  assert.equal(config.assets.directory, "../client");
});

test("rejects an MCP resource URL that is not the /mcp route", async () => {
  await expectRejection(
    { ...VALID_ENV, MCP_RESOURCE_URL: `${HOST}/` },
    /MCP_RESOURCE_URL must have the path \/mcp/u,
  );
});

test("rejects a redirect URI pointing at a different origin than the MCP resource", async () => {
  await expectRejection(
    { ...VALID_ENV, OIDC_REDIRECT_URI: "https://other.example.test/auth/callback" },
    /must share the deployed origin/u,
  );
});

test("rejects placeholder and non-HTTPS values", async () => {
  await expectRejection(
    { ...VALID_ENV, OIDC_ISSUER: "https://accounts.google.example.invalid" },
    /reserved \.invalid domain/u,
  );
  await expectRejection(
    { ...VALID_ENV, OIDC_JWKS_URL: "http://www.googleapis.example.test/certs" },
    /must be an HTTPS URL/u,
  );
});

test("rejects rate-limit namespace ids that are missing or not distinct", async () => {
  await expectRejection(
    { ...VALID_ENV, AUTH_RATE_LIMIT_NAMESPACE_ID: "2001" },
    /three distinct positive integers/u,
  );
});

test("rejects a build whose config would serve stale assets", async () => {
  await expectRejection(
    VALID_ENV,
    /no assets\.directory/u,
    builtConfig({ assets: { binding: "ASSETS" } }),
  );
});

test("requires the worker name rather than trusting a --name flag at the call site", async () => {
  const withoutName = { ...VALID_ENV, WORKER_NAME: "" };
  await expectRejection(withoutName, /WORKER_NAME is required/u);
});
