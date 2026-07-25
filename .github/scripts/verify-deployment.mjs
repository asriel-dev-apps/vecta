import { readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Post-deploy smoke against the live Worker — the checks that were previously
 * run by hand after every cutover, made into a gate that fails the deploy.
 *
 * The one that matters most is the asset-graph check. `wrangler deploy` reports
 * success and a new version id even when it uploaded a Worker that keeps serving
 * the PREVIOUS bundle (the cutover runbook records exactly this trap: a config
 * without `assets.directory`). A version id therefore proves nothing about what
 * users receive; only comparing the served HTML's asset references against the
 * build output does. Cloudflare needs a moment to propagate, so this polls
 * rather than asserting once.
 *
 * The remaining checks are the two token surfaces, which have no cookie session
 * and so can be verified without credentials: `/api/health`, the RFC 9728
 * metadata document, and that an unauthenticated `POST /mcp` is refused with the
 * `WWW-Authenticate` challenge that points a client back at that metadata.
 */

const baseUrl = new URL(requiredEnv("VECTA_BASE_URL"));
const mcpResourceUrl = requiredEnv("MCP_RESOURCE_URL");
const clientAssetsDir =
  process.env.VECTA_CLIENT_ASSETS ?? "apps/web/build/client/assets";
const timeoutMs = Number(process.env.VECTA_VERIFY_TIMEOUT_MS ?? 90_000);
const intervalMs = Number(process.env.VECTA_VERIFY_INTERVAL_MS ?? 5_000);

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function at(pathname) {
  return new URL(pathname, baseUrl).href;
}

/** Every `/assets/<file>` the served document references. */
function referencedAssets(html) {
  return [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/gu) ?? [])];
}

async function builtAssets() {
  const entries = await readdir(path.resolve(clientAssetsDir));
  return new Set(entries);
}

/**
 * Fetch a document, following redirects only WITHIN the deployed origin.
 *
 * `/` answers 302 to `/login` for an unauthenticated caller, and CI is always
 * unauthenticated, so the document to inspect is a hop away. Following blindly
 * is not an option either: `/login`'s own flow ends at the identity provider,
 * and chasing that would have us asserting against Google's HTML.
 */
async function fetchDocument(pathname, hops = 3) {
  let url = at(pathname);
  for (let hop = 0; hop <= hops; hop += 1) {
    const response = await fetch(url, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      return { response, html: await response.text(), url };
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new Error(`${url} answered ${response.status} with no Location`);
    }
    const next = new URL(location, url);
    if (next.origin !== baseUrl.origin) {
      throw new Error(`${url} redirected off-origin to ${next.origin}`);
    }
    url = next.href;
  }
  throw new Error(`more than ${hops} redirects starting at ${at(pathname)}`);
}

/**
 * Poll the app's document until every asset it references exists in the build we
 * just deployed. A stale edge still serves the previous bundle's filenames,
 * which are not in this build's output — so this is the check that a mismatch
 * cannot pass.
 */
async function verifyServedBundle(built) {
  const deadline = Date.now() + timeoutMs;
  let lastMismatch;
  for (;;) {
    try {
      const { response, html } = await fetchDocument("/");
      const referenced = referencedAssets(html);
      if (referenced.length === 0) {
        lastMismatch = `no /assets/* references in the document (status ${response.status})`;
      } else {
        const missing = referenced.filter(
          (asset) => !built.has(asset.slice("/assets/".length)),
        );
        if (missing.length === 0) {
          return referenced.length;
        }
        lastMismatch = `still serving ${missing.join(", ")}`;
      }
    } catch (error) {
      lastMismatch = `fetch failed: ${error.message}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `served bundle never matched the build within ${timeoutMs} ms — ${lastMismatch}`,
      );
    }
    await delay(intervalMs);
  }
}

async function verifyApiHealth() {
  const response = await fetch(at("/api/health"));
  if (!response.ok) {
    throw new Error(`/api/health returned ${response.status}`);
  }
}

async function verifyMcpMetadata() {
  const response = await fetch(at("/.well-known/oauth-protected-resource/mcp"));
  if (!response.ok) {
    throw new Error(`MCP resource metadata returned ${response.status}`);
  }
  const metadata = await response.json();
  // A mismatch here means the deployed MCP_RESOURCE_URL is not the audience
  // tokens were minted for — every MCP call would fail authentication.
  if (metadata.resource !== mcpResourceUrl) {
    throw new Error(
      `MCP resource metadata advertises ${metadata.resource}, expected ${mcpResourceUrl}`,
    );
  }
}

async function verifyMcpRefusesAnonymous() {
  const response = await fetch(at("/mcp"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  if (response.status !== 401) {
    throw new Error(`unauthenticated POST /mcp returned ${response.status}, expected 401`);
  }
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (!challenge.includes("resource_metadata")) {
    throw new Error("401 from /mcp carries no resource_metadata challenge");
  }
}

const assetCount = await verifyServedBundle(await builtAssets());
await verifyApiHealth();
await verifyMcpMetadata();
await verifyMcpRefusesAnonymous();

console.log(
  JSON.stringify({ event: "deployment_verified", origin: baseUrl.origin, assetCount }),
);
