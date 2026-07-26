import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { errorName } from "~/server/api/edge-security";

/**
 * Server entry for the DOCUMENT surface (the 2026-07-27 ASVS L2 scan, finding H1).
 *
 * ## Why this file exists at all
 *
 * React Router only lets an app override `handleError` by owning its server
 * entry, so everything below `handleError` is the framework's own default web
 * entry, revealed verbatim from `@react-router/dev` 8.2.0 — with ONE change,
 * marked at the `onError` callback.
 *
 * Without an entry the framework installs this default error handler:
 *
 * ```js
 * console.error(isRouteErrorResponse(error) && error.error ? error.error : error)
 * ```
 *
 * That prints the whole `Error` — message and stack. It matters here because
 * `@neondatabase/serverless`'s `neon()` throws
 * `"…not a valid URL. Connection string: " + String(connectionString)` when the
 * string will not parse as a URL, and `wrangler.jsonc` sets
 * `observability.enabled`, so the message lands in Cloudflare Workers Logs — a
 * Worker secret that cannot otherwise be read back, disclosed to everyone with
 * log access and to any Logpush destination. The trigger is not an attack but a
 * paste: `wrangler secret put` reads stdin, so quotes or a leading `psql ` come
 * through, and both of those shapes were measured to put the password in the
 * message.
 *
 * `/api` already had the care — `createApiApp`'s `onError` logs a validated
 * `errorName` and nothing else. The browser surface, which is the only one real
 * users visit, had none. This closes that asymmetry rather than the single Neon
 * message, because the next library to put a secret in an exception will not
 * announce itself either.
 *
 * `errorName` is reused from the `/api` edge-security module deliberately: it is
 * the same allowlist (`/^[A-Za-z][A-Za-z0-9]*$/`, else `"UnknownError"`), so the
 * two surfaces cannot drift into logging different things.
 */

export const streamTimeout = 5_000;

/**
 * Template the path so the log carries the ROUTE, not the identifiers on it.
 * Every matched param value is replaced by `:name`, which needs no guessing about
 * what an id looks like — React Router already told us. An unmatched path (a 404,
 * therefore attacker-chosen) is passed through but capped, and it is emitted
 * inside `JSON.stringify`, so it cannot break out into a forged log line.
 */
export function documentRoute(
  pathname: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) byValue.set(value, `:${name}`);
  }
  const templated = pathname
    .split("/")
    .map((segment) => byValue.get(segment) ?? segment)
    .join("/");
  return templated.length > 128 ? `${templated.slice(0, 128)}…` : templated;
}

/**
 * Emit the one line the document surface is allowed to emit about a failure:
 * a validated error NAME, the request id, and the templated route. The `Error`
 * itself — message, stack, `cause` — is never handed to `console`.
 *
 * The request id comes from the `x-request-id` header, the same source
 * `createApiApp`'s `onError` reads. Nothing stamps that header on the document
 * branch yet (M1 will, when the shared edge layer moves in front of React
 * Router), so it reads `"unknown"` today — a field that is present and empty
 * rather than a field that has to be added later.
 */
function writeDocumentErrorLog(input: {
  readonly error: unknown;
  readonly request: Request;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly phase: "handler" | "stream";
}): void {
  console.error(
    JSON.stringify({
      event: "document_unhandled_error",
      requestId: input.request.headers.get("x-request-id") ?? "unknown",
      method: input.request.method,
      route: documentRoute(new URL(input.request.url).pathname, input.params),
      phase: input.phase,
      errorName: errorName(input.error),
    }),
  );
}

export function handleError(
  error: unknown,
  { request, params }: { request: Request; params: Readonly<Record<string, string | undefined>> },
): void {
  // A client that navigated away aborts its own request; React Router's default
  // stays quiet for those and so do we, or every cancelled prefetch becomes an
  // error line.
  if (request.signal.aborted) return;
  writeDocumentErrorLog({ error, request, params, phase: "handler" });
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  // The framework default declares a fifth `loadContext: RouterContextProvider`
  // parameter and does not use it; it is dropped here rather than renamed,
  // because the repo's lint has no unused-argument escape hatch and a trailing
  // positional parameter can simply be left off.
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        //
        // THE ONE DEVIATION from the framework default, and the reason it is
        // marked: the default calls `console.error(error)` here. That is the
        // same disclosure as the missing `handleError` — a render that touches a
        // failing DB seam throws the same Neon exception — so it goes through the
        // same name-only log. `params` is not available at this point in the
        // render, so the route is templated from the path alone.
        if (shellRendered) {
          writeDocumentErrorLog({ error, request, params: {}, phase: "stream" });
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
