import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import { appContext } from "../app/server/context";
import { handleApiRequest, handleMcpRequest } from "../app/server/api";
import {
  withDocumentSecurityHeaders,
  withDocumentTransportSecurity,
} from "../app/server/document-security.server";
import { withDocumentEdge } from "../app/server/document-edge.server";
import { stagingGate } from "../app/server/staging-gate.server";

const reactRouterHandler = createRequestHandler(
  // React Router's generated virtual-build exports type each optional field as
  // `T | undefined`, which the repo's `exactOptionalPropertyTypes` rejects
  // against `ServerBuild`'s `field?: T`. The runtime shape is correct, so bridge
  // the generated type to `ServerBuild` explicitly.
  () =>
    import("virtual:react-router/server-build") as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

// External API + MCP surface (ADR 0012 §Decision 3). `/api` (the token-auth
// zod-openapi surface) is live as of Step 5a; `/mcp` (the stateless remote MCP
// server) as of Step 5b. Both are cookie-session-free by construction: they are
// dispatched here and never reach the React Router auth middleware. The MCP
// branch also owns `/.well-known/oauth-protected-resource*` (the RFC 9728
// metadata) — without that here the metadata request would fall through to the
// React Router auth middleware and die.

/** Exact-or-subpath match so `/apifoo` falls through to React Router, not `/api`. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Exact-or-subpath match so `/mcpfoo` falls through to React Router, not `/mcp`.
 * Also matches the RFC 9728 metadata subtree `/.well-known/oauth-protected-resource*`,
 * which the MCP handler serves (`.../mcp`) — so the metadata request is answered
 * by the token surface, never the cookie pipeline.
 */
export function isMcpPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/")
  );
}

export default {
  async fetch(request, env, ctx) {
    // ADR 0014 — the staging gate runs BEFORE anything else, including the `/api`
    // and `/mcp` dispatch: an environment that is meant to be unreachable must not
    // have a surface that is reachable. Armed by `DEPLOY_ENV === "staging"` OR by
    // the presence of the `STAGING_ACCESS_KEY` secret — see `isStagingGateArmed`
    // for why the second signal exists (ASVS M4).
    const gate = await stagingGate(request, env);
    if (gate.response !== null) return gate.response;

    const { pathname } = new URL(request.url);
    if (isApiPath(pathname)) {
      return handleApiRequest(request, env, ctx);
    }
    if (isMcpPath(pathname)) {
      return handleMcpRequest(request, env, ctx);
    }
    // The document surface gets the same class of edge protection `/api` has had
    // since Step 5a — a bounded body, a rate limit on the unauthenticated routes,
    // and a request id — with limits measured for THIS surface rather than copied
    // (ASVS scan M1; the numbers and their reasons are in `document-edge.server`).
    return withDocumentEdge(request, env, async (correlated) => {
      // React Router v8 requires the load context to be a `RouterContextProvider`
      // (a plain object no longer type-checks or works). Seed it with the Worker
      // bindings + execution context for loaders/middleware to read via `appContext`.
      const context = new RouterContextProvider();
      context.set(appContext, { env, ctx });
      // The document CSP is attached HERE rather than in root middleware, because
      // this is the one point every HTML response passes through — including the
      // ones React Router produces from a thrown error, which never reach a
      // middleware's return path (ADR 0013 Decision 6 / Design 0005 §5.3).
      return withDocumentTransportSecurity(
        correlated,
        withDocumentSecurityHeaders(await reactRouterHandler(correlated, context)),
      );
    });
  },
} satisfies ExportedHandler<Env>;
