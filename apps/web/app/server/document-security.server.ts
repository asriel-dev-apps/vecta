/**
 * Security headers for the DOCUMENT surface (Design 0005 §5.3 / ADR 0013
 * Decision 6).
 *
 * The design says to "confirm the existing CSP's `img-src` / `connect-src` block
 * outbound sends". Checking that turned up something the design had assumed away:
 * **there was no document CSP at all.** `edge-security.ts` sets a strict one, but
 * only on `/api` and `/mcp`, which are dispatched before React Router ever runs.
 * Every HTML response the browser rendered carried none.
 *
 * That matters for this feature specifically. Rendering the model's prose as a
 * text node stops the markdown-image channel — but it stops it by discipline, in
 * one component. A CSP stops it in the browser, for every component, including
 * the one somebody adds next year that renders markdown because it seemed
 * friendlier. The two are not redundant; one is a decision and the other is an
 * enforcement.
 *
 * ## What this header deliberately does NOT include
 *
 * **No `script-src`, and therefore no `default-src`.** `root.tsx` inlines a theme
 * bootstrap via `dangerouslySetInnerHTML`, and React Router's `<Scripts/>` inlines
 * the hydration context. Either directive without `'unsafe-inline'` or a
 * per-request nonce turns the whole app into a blank page. Doing it properly means
 * generating a nonce in middleware and threading it into `<Scripts/>` — a change
 * worth making, and worth making on its own, with its own verification, rather
 * than as a side effect of an assistant feature.
 *
 * **No `form-action`.** Sign-in POSTs to `/login`, whose action answers with a 302
 * to Google. Several browsers apply `form-action` to the redirect that FOLLOWS a
 * form submission, not just to its immediate target — which would break
 * authentication in exactly the environments hardest to notice from here. It buys
 * little in return: no attacker-supplied HTML is rendered anywhere, so there is no
 * injected form to constrain.
 */

/**
 * Directives chosen so that every one of them is provably unused by the app today
 * — verified by grep: no `<img>`, no `url()` in the stylesheets, no external URL in
 * any client module, no `<base>`, no plugin embed. So this cannot break a working
 * path; it can only stop one that does not exist yet, which is the point.
 *
 * - `img-src 'self' data:` — the exfiltration channel Design 0005 §5.3 names. A
 *   `data:` image makes no request, so allowing it costs nothing and spares a
 *   future inline SVG.
 * - `connect-src 'self'` — fetch / XHR / WebSocket / `sendBeacon` to any other
 *   host. The quiet sibling of the image channel.
 * - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` — free: no
 *   plugin embeds, no `<base>` tag, and nothing embeds this app in a frame.
 */
export const DOCUMENT_CSP = [
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The rest of the posture (2026-07-27 ASVS L2 scan, M5).
 *
 * Measured against production before the change: `/login` — a page a person
 * actually opens — carried the CSP above and NOTHING else, while `/api/health`,
 * which no browser ever visits, carried all six. The care had been applied to the
 * surface that was designed as a surface.
 *
 * **`Strict-Transport-Security` is the one that was doing nothing at all.** HSTS
 * protects a HOST, but a browser only learns the policy from a response it
 * receives — and browsers never fetch `/api`. So real users had never once been
 * told to pin HTTPS for this host. It is served without `includeSubDomains` on
 * purpose, matching `/api`: the app lives on a `workers.dev` subdomain, which is
 * on the Public Suffix List, and claiming siblings from here would be reaching
 * outside what this Worker owns.
 *
 * **`Cache-Control: no-store` is a disclosure fix, not a performance knob.** The
 * SSR HTML of `/projects/:id/wbs` embeds the whole grid, so without it the plan
 * sits in the browser's cache and the back button shows it after logout —
 * `/logout` clears the cookie but sends no `Clear-Site-Data`. It costs the
 * back/forward cache, which is the right trade for a page that renders another
 * company's effort data.
 *
 * `X-Frame-Options` duplicates `frame-ancestors 'none'` for browsers that predate
 * CSP framing; the others are the same values `secureResponse` uses, so the two
 * surfaces do not drift.
 */
const DOCUMENT_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Origin-Agent-Cluster", "?1"],
  ["Cache-Control", "no-store"],
];

/**
 * Attach the document security headers, preserving everything the response
 * already carries (status, redirect `Location`, `Set-Cookie`).
 *
 * A response that already declares its own `Content-Security-Policy` is left
 * alone ENTIRELY: `/api` and `/mcp` set a strict `default-src 'none'` of their
 * own, and silently widening it from here would be a downgrade applied by a
 * helper nobody was looking at.
 *
 * Individual headers are set only when the response has not already declared
 * them, so a route that has a reason to differ (a deliberately cacheable public
 * asset route, say) keeps its own value rather than having it overwritten by a
 * helper further out.
 */
export function withDocumentSecurityHeaders(response: Response): Response {
  if (response.headers.has("Content-Security-Policy")) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", DOCUMENT_CSP);
  for (const [name, value] of DOCUMENT_SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * HSTS, applied only over HTTPS. Split out because it is the one header whose
 * correctness depends on the request: sending it over plain HTTP is meaningless
 * (the spec says to ignore it) and would be misleading in local dev.
 */
export function withDocumentTransportSecurity(request: Request, response: Response): Response {
  if (new URL(request.url).protocol !== "https:") return response;
  if (response.headers.has("Strict-Transport-Security")) return response;
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
