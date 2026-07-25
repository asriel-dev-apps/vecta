import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Write the deployment's real configuration into the BUILT Worker config
 * (`apps/web/build/server/wrangler.json`), never into the tracked source.
 *
 * `apps/web/wrangler.jsonc` deliberately ships `.invalid` placeholders so
 * the repository is not tied to one deployment. Filling them in by hand before a
 * deploy — and undoing it afterwards — puts real values in a tracked file of a
 * PUBLIC repository for the length of the deploy, where one mistimed `git commit
 * -a` makes them permanent. The build output is gitignored, so patching it
 * instead removes that window entirely, and the same script runs locally and in
 * CI, so what is deployed is reproducible rather than dependent on one machine.
 *
 * None of these values is a secret: an OIDC client id, issuer, endpoints, and
 * redirect URI are all visible in the browser during sign-in, and the MCP
 * resource identifier is served unauthenticated at
 * `/.well-known/oauth-protected-resource/mcp`. The real secrets
 * (OIDC_CLIENT_SECRET, SESSION_SECRET, DATABASE_URL) are Worker secrets and
 * never appear in this config, in the build, or in git. What this script buys is
 * reproducibility and the removal of hand-editing, not confidentiality.
 *
 * The validations below are the traps the cutover runbook records: a wrong
 * `MCP_RESOURCE_URL` path silently breaks the `/mcp` audience, and a redirect URI
 * left pointing at another host survives a deploy but fails at login.
 */

const CONFIG_PATH =
  process.env.WEB_CONFIG ?? "apps/web/build/server/wrangler.json";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** An HTTPS URL that carries no credentials and is not a reserved placeholder. */
function requiredHttpsUrl(name) {
  const value = required(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  if (url.hostname.endsWith(".invalid")) {
    throw new Error(`${name} must not use the reserved .invalid domain`);
  }
  return url;
}

/** An HTTPS URL whose path must be exactly `expectedPath`. */
function requiredHttpsUrlAtPath(name, expectedPath) {
  const url = requiredHttpsUrl(name);
  if (url.pathname !== expectedPath) {
    throw new Error(`${name} must have the path ${expectedPath}`);
  }
  return url;
}

const workerName = required("WORKER_NAME");

const issuer = requiredHttpsUrl("OIDC_ISSUER");
const jwksUrl = requiredHttpsUrl("OIDC_JWKS_URL");
const authEndpoint = requiredHttpsUrl("OIDC_AUTH_ENDPOINT");
const tokenEndpoint = requiredHttpsUrl("OIDC_TOKEN_ENDPOINT");
// The deployed origin appears twice, and the two must agree: a redirect URI left
// pointing at the previous host deploys cleanly and only fails at sign-in.
const redirectUri = requiredHttpsUrlAtPath("OIDC_REDIRECT_URI", "/auth/callback");
const mcpResourceUrl = requiredHttpsUrlAtPath("MCP_RESOURCE_URL", "/mcp");
if (redirectUri.origin !== mcpResourceUrl.origin) {
  throw new Error(
    "OIDC_REDIRECT_URI and MCP_RESOURCE_URL must share the deployed origin",
  );
}

const clientId = required("OIDC_CLIENT_ID");
if (clientId.length > 255 || clientId.endsWith(".invalid")) {
  throw new Error("OIDC_CLIENT_ID must be 1 to 255 characters and not a placeholder");
}

const rateLimitNamespaceIds = {
  PRE_AUTH_RATE_LIMIT: process.env.PRE_AUTH_RATE_LIMIT_NAMESPACE_ID,
  AUTH_RATE_LIMIT: process.env.AUTH_RATE_LIMIT_NAMESPACE_ID,
  COMPUTE_RATE_LIMIT: process.env.COMPUTE_RATE_LIMIT_NAMESPACE_ID,
};
const namespaceIds = Object.values(rateLimitNamespaceIds);
if (
  namespaceIds.some((value) => !/^[1-9]\d*$/u.test(value ?? "")) ||
  new Set(namespaceIds).size !== 3
) {
  throw new Error("Rate-limit namespace IDs must be three distinct positive integers");
}

const configPath = path.resolve(CONFIG_PATH);
const config = JSON.parse(await readFile(configPath, "utf8"));

// The build is what carries these; if they are missing the wrong file was built
// (the runbook's "stale assets" trap: a config without `assets.directory`
// uploads a Worker that serves the previous bundle).
if (typeof config.assets?.directory !== "string" || config.assets.directory.length === 0) {
  throw new Error(`${CONFIG_PATH} has no assets.directory — deploy would serve stale assets`);
}
if (typeof config.compatibility_date !== "string") {
  throw new Error(`${CONFIG_PATH} has no compatibility_date`);
}

// Naming the Worker here rather than relying on a `--name` flag at the call site:
// a forgotten flag deploys to the config's local name and leaves the live site
// silently unchanged.
config.name = workerName;

config.vars = {
  OIDC_ISSUER: issuer.href.replace(/\/$/u, ""),
  OIDC_CLIENT_ID: clientId,
  OIDC_JWKS_URL: jwksUrl.href,
  OIDC_REDIRECT_URI: redirectUri.href,
  OIDC_AUTH_ENDPOINT: authEndpoint.href,
  OIDC_TOKEN_ENDPOINT: tokenEndpoint.href,
  MCP_RESOURCE_URL: mcpResourceUrl.href,
};

if (!Array.isArray(config.ratelimits) || config.ratelimits.length !== 3) {
  throw new Error(`${CONFIG_PATH} must have three rate-limit bindings`);
}
for (const binding of config.ratelimits) {
  const namespaceId = rateLimitNamespaceIds[binding.name];
  if (namespaceId === undefined) {
    throw new Error(`Unexpected rate-limit binding ${binding.name}`);
  }
  binding.namespace_id = namespaceId;
}

const serialized = `${JSON.stringify(config, null, 2)}\n`;
// Belt and braces: nothing reserved may survive anywhere in the deployed config.
if (serialized.includes(".invalid")) {
  throw new Error(`${CONFIG_PATH} still contains .invalid placeholders after materializing`);
}
await writeFile(configPath, serialized);

console.log(
  JSON.stringify({
    event: "deploy_config_materialized",
    worker: config.name,
    origin: mcpResourceUrl.origin,
  }),
);
