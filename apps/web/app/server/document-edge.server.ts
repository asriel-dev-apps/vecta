import {
  boundedRequest,
  enforcePreAuthenticationLimit,
  errorName,
  rateLimitedResponse,
  requestId,
  RequestRateLimitedError,
  withRequestId,
} from "./api/edge-security";
import { writeSecurityEvent } from "./security-log.server";

/**
 * The edge layer for the DOCUMENT surface — the 2026-07-27 ASVS L2 scan, finding
 * M1, and the structural point the scan closes with: `/api` and `/mcp` were
 * designed as "the surface we expose", and got a bounded body, rate limits, a
 * request id and a request log; the browser surface was treated as "our own
 * screens" and got none of it. Real users only ever travel the browser surface.
 *
 * This module is the counterpart of `handleApiRequest`, and it deliberately
 * reuses that module's parts rather than growing new ones. What it does NOT do
 * is reuse its NUMBERS — those were measured for this surface, below.
 *
 * ## Why the body bound is 1 MiB here and 64 KiB on `/api`
 *
 * Copying 64 KiB across would have been an outage, not a hardening. Measured
 * 2026-07-27 against the real `CommandBatchSchema` shapes:
 *
 * | batch | bytes |
 * | --- | --- |
 * | 1,000 × `task.update` (a full sibling-group reorder — the largest gesture the contract's own comment names) | **165 KiB** |
 * | 1,000 × a realistic `task.add` | **620 KiB** |
 * | 1,000 × a contract-legal MAXIMAL `task.add` (2,000-char name/note/contract, 3,660 `dailyPlan` entries, 200 dependencies) | **~82.6 MiB** |
 *
 * So the interesting gap is between 620 KiB and 82.6 MiB, not around 64 KiB.
 * 1 MiB clears the largest batch a person can actually produce with headroom, and
 * refuses the one that could only be a bug or an attack. The scan's own timing —
 * `request.json()` at 3.4 ms for 1 MB against 94.6 ms for 32 MB, on a 10 ms CPU
 * budget — lands on the same side.
 *
 * `/api` keeps 64 KiB: it is a token surface for agents, it has never carried a
 * 1,000-command batch, and loosening it would be a widening nobody asked for.
 *
 * ## Why the rate limit is NOT applied to every document request
 *
 * `PRE_AUTH_RATE_LIMIT` is 120 requests / 60 s keyed on `cf-connecting-ip`. An
 * office shares one public IP, so an IP-keyed limit on the authenticated write
 * path divides 120 saves a minute among everyone in the building — and the save
 * queue coalesces to one in-flight POST per tab, which means a single continuous
 * editor can approach that alone. A false 429 there is not a slow page: the
 * client's queue rolls the optimistic state back. A guard whose false-positive
 * rate is that high teaches people to work around it, which is a security
 * property, not a UX one.
 *
 * So the limit is applied where the legitimate rate is genuinely near zero and the
 * cost of a flood is genuinely high: the three UNAUTHENTICATED routes. A POST to
 * `/auth/callback` makes the Worker perform an outbound Google token exchange and
 * a JWKS fetch — an unauthenticated request that spends someone else's budget —
 * and `/login` mints OIDC transaction state. Nobody legitimately touches those 120
 * times a minute.
 *
 * The authenticated write path is therefore still UNLIMITED, and that is recorded
 * rather than quietly dropped: doing it properly means keying on the VERIFIED
 * principal (available in the auth middleware, not here), sizing the limit against
 * a measured production save rate, and giving the client a typed contract for 429
 * so the queue rolls back instead of hitting an error boundary. See the HANDOFF's
 * carried debt.
 */

/** 1 MiB — see the table above. */
export const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;

/**
 * The unauthenticated document routes. React Router's single fetch asks for data
 * at `<path>.data`, so both spellings must map to the same bucket — otherwise the
 * limit is trivially doubled by asking for the data request instead.
 */
const RATE_LIMITED_DOCUMENT_PATHS = new Set(["/login", "/auth/callback", "/logout"]);

/** Strip React Router's single-fetch `.data` suffix, so `/login.data` is `/login`. */
export function documentPathname(pathname: string): string {
  return pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
}

export function isRateLimitedDocumentPath(pathname: string): boolean {
  return RATE_LIMITED_DOCUMENT_PATHS.has(documentPathname(pathname));
}

/**
 * A 413 for a browser, not for a JSON client: this surface answers documents, so
 * an API error envelope here would be rendered as text in the address bar's page.
 * Deliberately plain — no stylesheet, no app shell — because the request that
 * produced it was never parsed.
 */
export function documentBodyTooLargeResponse(): Response {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Request too large</title>" +
      "<p>The request body exceeds the 1 MiB limit for this surface.</p>",
    {
      status: 413,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/** The browser counterpart of `rateLimitedResponse`, for the same reason. */
export function documentRateLimitedResponse(): Response {
  const json = rateLimitedResponse();
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Too many requests</title>" +
      "<p>Too many requests. Please wait a moment and try again.</p>",
    {
      status: 429,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": json.headers.get("retry-after") ?? "60",
      },
    },
  );
}

function documentErrorResponse(): Response {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Something went wrong</title>" +
      "<p>Something went wrong. Please try again.</p>",
    {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/**
 * Wrap the React Router branch: bound the body, rate-limit the unauthenticated
 * routes, stamp a request id, and hand the correlated request to `render`.
 *
 * The request id is the same header `/api` uses (`x-request-id` in, `X-Request-Id`
 * out) and is what `entry.server.tsx`'s `handleError` reads — until this landed
 * that field logged `"unknown"`, by construction rather than by oversight.
 *
 * `render` is injected so this module can be tested without a React Router server
 * build, and so it stays free of React Router imports.
 */
export async function withDocumentEdge(
  request: Request,
  env: Env,
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  const id = requestId();
  const { pathname } = new URL(request.url);
  let response: Response;
  try {
    if (isRateLimitedDocumentPath(pathname)) {
      await enforcePreAuthenticationLimit(env.PRE_AUTH_RATE_LIMIT, request);
    }
    const bounded = await boundedRequest(request, MAX_DOCUMENT_BODY_BYTES);
    response =
      bounded === null
        ? documentBodyTooLargeResponse()
        : await render(withRequestId(bounded, id));
  } catch (error) {
    // Anything that escapes React Router itself lands here. Log the NAME only,
    // for the same reason `handleError` does: an exception's message is where a
    // library puts the thing it was given, and this one is given a connection
    // string.
    if (error instanceof RequestRateLimitedError) {
      // A rate-limit hit is not an error, it is a security event the ASVS scan
      // asked for by name (M3). It went out as `document_edge_error` before,
      // which put "someone is hammering /auth/callback" in the same bucket as a
      // failing database.
      response = documentRateLimitedResponse();
      writeSecurityEvent({
        kind: "rate_limited",
        reason: "pre_auth_rate_limit",
        status: response.status,
        request,
        // The request has not been stamped yet — the id exists only here — so it
        // is passed in rather than read back off a header that is not there.
        requestId: id,
      });
    } else {
      response = documentErrorResponse();
      console.error(
        JSON.stringify({
          event: "document_edge_error",
          requestId: id,
          method: request.method,
          status: response.status,
          errorName: errorName(error),
        }),
      );
    }
  }
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
