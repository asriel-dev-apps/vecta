import { createLocalJWKSet } from "jose";
import { createProjectMcpHandler } from "~/server/api/mcp";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "~/server/api/oidc-auth";
import type { ApiDeps } from "~/server/api/app";
import { fakeEnv } from "../helpers";
import {
  API_ISSUER,
  API_JWKS_URL,
  buildApiDeps,
  signAccessToken,
  type ApiDepsOverrides,
  type ApiTestKeys,
} from "./api";

/**
 * Test scaffolding for the token `/mcp` surface (ADR 0012 Step 5b). Reuses the
 * `/api` fixtures' local RS256 JWKS + in-memory persistence fakes (so the MCP
 * tools run against the SAME seams as `/api`, with no network / no Neon), and
 * adds the MCP-specific bits: the RFC 9728 resource URL / audience
 * (`MCP_RESOURCE_URL`, distinct from the REST audience) and JSON-RPC request
 * helpers driving the stateless handler with `enableJsonResponse` responses.
 */

// A valid RFC 9728 resource id: https, non-root path (`/mcp`), no query/hash.
export const MCP_RESOURCE_URL = "https://mcp.test/mcp";
export const MCP_METADATA_URL = "https://mcp.test/.well-known/oauth-protected-resource/mcp";

export const mcpCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

export function mcpEnv(): Env {
  return fakeEnv({
    OIDC_ISSUER: API_ISSUER,
    OIDC_JWKS_URL: API_JWKS_URL,
    MCP_RESOURCE_URL,
    DATABASE_URL: "postgres://user:pass@db.example.invalid/vecta",
  });
}

/** A production-shaped `authenticate` dep whose audience is the MCP resource. */
export function realMcpAuthenticate(keys: ApiTestKeys): ApiDeps["authenticate"] {
  const authenticator = createOidcBearerAuthenticator(
    createJoseOidcTokenVerifier(() => createLocalJWKSet(keys.publicJwks)),
  );
  return (request) =>
    authenticator.authenticate(request, {
      issuer: API_ISSUER,
      audience: MCP_RESOURCE_URL,
      jwksUrl: API_JWKS_URL,
    });
}

/** Sign an access token whose audience is the MCP resource (not the REST one). */
export function signMcpToken(
  privateKey: CryptoKey,
  claims: Parameters<typeof signAccessToken>[1] = {},
): Promise<string> {
  return signAccessToken(privateKey, { aud: MCP_RESOURCE_URL, ...claims });
}

/** Build the `/mcp` handler + the fakes a test asserts on, wiring overrides. */
export function buildMcpHandler(overrides: ApiDepsOverrides = {}) {
  const built = buildApiDeps(overrides);
  return { handler: createProjectMcpHandler(built.deps), ...built };
}

export interface JsonRpcOptions {
  readonly token?: string;
  readonly origin?: string;
  readonly url?: string;
  readonly method?: string;
}

/** Build a JSON-RPC-over-HTTP request for the stateless MCP transport. */
export function mcpRpcRequest(body: unknown, options: JsonRpcOptions = {}): Request {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  return new Request(options.url ?? MCP_RESOURCE_URL, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let nextId = 1;

/** POST a single JSON-RPC request to the handler and return the parsed response. */
export async function callMcp(
  handler: ReturnType<typeof buildMcpHandler>["handler"],
  method: string,
  params: Record<string, unknown>,
  options: JsonRpcOptions = {},
): Promise<{ status: number; body: JsonRpcResult; response: Response }> {
  const request = mcpRpcRequest(
    { jsonrpc: "2.0", id: nextId++, method, params },
    options,
  );
  const response = (await handler(request, mcpEnv(), mcpCtx)) as Response;
  const status = response.status;
  const text = await response.clone().text();
  const body = text.length > 0 ? (JSON.parse(text) as JsonRpcResult) : ({} as JsonRpcResult);
  return { status, body, response };
}

export interface McpToolResult {
  readonly content?: ReadonlyArray<{ type: string; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly tools?: ReadonlyArray<{ name: string; annotations?: Record<string, unknown> }>;
}

export interface JsonRpcResult {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: McpToolResult;
  readonly error?: { code: number; message: string };
}

/** Parse the JSON error envelope out of a tool-call `isError` content block. */
export function toolErrorCode(result: McpToolResult | undefined): string | undefined {
  const text = result?.content?.[0]?.text;
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as { error?: { code?: string } };
  return parsed.error?.code;
}
