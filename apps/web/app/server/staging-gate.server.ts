/**
 * The staging gate (ADR 0014).
 *
 * A staging environment exists so an agent can deploy and look at the result
 * without a person in the loop. That only works if it is unreachable by anyone
 * else, and the enforcement is HERE — in the artifact being tested — rather than
 * in a Cloudflare Access policy attached to a hostname.
 *
 * The reason is not that Access is weak; it is stronger in most respects (it
 * rejects at the edge, keeps an audit log, supports MFA). It is that a policy
 * attached to a hostname can be detached by a change somewhere else, and that
 * detachment is SILENT — you learn about it from the thing being public. A check
 * in the request path has no hostname to be separated from. Access can be layered
 * on later without touching this file.
 *
 * Fail-closed in the direction that matters: on staging, a MISSING key rejects
 * everything. A deploy that forgot to set the secret serves nothing, rather than
 * serving everything.
 */

export interface StagingGateBindings {
  /** `"staging"` arms the gate. Anything else (including absent) leaves it inert. */
  readonly DEPLOY_ENV?: string;
  /** The shared key. On staging its ABSENCE rejects every request. */
  readonly STAGING_ACCESS_KEY?: string;
  /** Optional comma-separated exact IPs, matched against `CF-Connecting-IP`. */
  readonly STAGING_ALLOWED_IPS?: string;
}

const COOKIE_NAME = "vecta_stg";
/**
 * Form FIELD, not a query parameter. A key in a query string is the weakest place
 * to put one: it is written verbatim into Cloudflare's request logs, appears in the
 * address bar, survives in history, and travels in a `Referer`. Stripping it with a
 * redirect fixes only the last two. A POST body is in none of those places.
 */
const KEY_FIELD = "__stg";
const HEADER_NAME = "x-staging-key";
/** Bound into the cookie token so a key reused elsewhere cannot produce this cookie. */
const COOKIE_CONTEXT = "vecta-staging-cookie-v1";

/**
 * Constant-time comparison. A length-sensitive early return would leak the key's
 * length, and a short-circuiting compare leaks a prefix — neither is expensive to
 * avoid, and this value is the only thing standing in front of the environment.
 */
function equalsConstantTime(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  // Compare over a fixed width so the loop count does not depend on the inputs.
  const width = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < width; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * The cookie carries an HMAC of a fixed context under the key, never the key
 * itself: a cookie is stored on disk, syncs between devices, and shows up in
 * devtools, so it should not be the credential that can also be replayed as a
 * header. Deterministic, so the gate needs no server-side state.
 */
async function cookieTokenFor(key: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    imported,
    new TextEncoder().encode(COOKIE_CONTEXT),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function allowedIps(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const REFUSAL_HEADERS = {
  "cache-control": "no-store",
  // Nothing here should ever be indexed, even if the gate is later relaxed.
  "x-robots-tag": "noindex, nofollow",
  // The form is the only markup this page has; nothing else may load or connect.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const;

/**
 * The refusal. Deliberately uninformative about what is behind it — but for a
 * browser it carries the one thing a person needs: somewhere to put the key that
 * is not a URL.
 *
 * `type="password"` with `autocomplete="current-password"` so a password manager
 * can hold it; otherwise the key gets copied out of Keychain by hand every time,
 * and a key that is inconvenient gets pasted somewhere it should not be.
 */
function refuse(wantsHtml: boolean): Response {
  if (!wantsHtml) {
    return new Response("Not available.\n", {
      status: 403,
      headers: { ...REFUSAL_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  const page = [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>Restricted</title>",
    "<style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#3d434d}",
    "form{display:flex;gap:8px}input,button{font:inherit;padding:8px 10px;border:1px solid #dce0e6;border-radius:8px}",
    "button{background:#5b57d6;color:#fff;border-color:#5b57d6;cursor:pointer}</style></head><body>",
    "<form method=\"post\">",
    `<input type="password" name="${KEY_FIELD}" autocomplete="current-password" aria-label="Access key" autofocus>`,
    "<button type=\"submit\">Enter</button>",
    "</form></body></html>",
  ].join("");
  return new Response(page, {
    status: 403,
    headers: { ...REFUSAL_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

/** Did the caller ask for a page, or is it an agent / a script? */
function acceptsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export interface StagingGateResult {
  /** Non-null means STOP: return this response and never run the app. */
  readonly response: Response | null;
}

/**
 * Decide whether a request may reach the application at all.
 *
 * Returns `{ response: null }` to continue. Any other result must be returned to
 * the client as-is — including the redirect that mints the cookie.
 */
export async function stagingGate(
  request: Request,
  env: StagingGateBindings,
): Promise<StagingGateResult> {
  if (env.DEPLOY_ENV !== "staging") return { response: null };

  const key = env.STAGING_ACCESS_KEY?.trim();
  if (key === undefined || key.length === 0) {
    // Armed but unkeyed: refuse everything, and offer no form — there is no key
    // that would work. A staging deploy that forgot the secret must be unusable,
    // not open, and must not invite someone to guess.
    return { response: refuse(false) };
  }

  // 1. The agent path: one header, no browser, no cookie jar.
  const header = request.headers.get(HEADER_NAME);
  if (header !== null && equalsConstantTime(header, key)) return { response: null };

  // 2. The human path, already admitted.
  const expectedCookie = await cookieTokenFor(key);
  const cookie = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (cookie !== null && equalsConstantTime(cookie, expectedCookie)) return { response: null };

  // 3. The human path, first visit: the key arrives in a POST BODY from the form on
  //    the refusal page. A 303 sends the browser back to the same address with GET,
  //    so the person lands where they were going and the key was never in a URL.
  if (request.method === "POST") {
    let provided: string | null;
    try {
      // `FormData.get` returns `string | File | null`. Coercing a File would compare
      // the literal text "[object File]" — harmless here, but a credential path is
      // the last place to let a type quietly widen. Only a string is a candidate.
      const field = (await request.formData()).get(KEY_FIELD);
      provided = typeof field === "string" ? field : null;
    } catch {
      provided = null; // not a form body; fall through to the refusal
    }
    if (provided !== null && provided.length > 0 && equalsConstantTime(provided, key)) {
      return {
        response: new Response(null, {
          status: 303,
          headers: {
            location: new URL(request.url).pathname,
            "cache-control": "no-store",
            "set-cookie": [
              `${COOKIE_NAME}=${expectedCookie}`,
              "Path=/",
              "HttpOnly",
              "Secure",
              "SameSite=Lax",
              "Max-Age=2592000",
            ].join("; "),
          },
        }),
      };
    }
  }

  // 4. Optional convenience, never the primary control: a residential IP moves, so
  //    this is an ADDITIONAL way in rather than the one the environment relies on.
  const ips = allowedIps(env.STAGING_ALLOWED_IPS);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp !== null && ips.includes(clientIp)) return { response: null };

  return { response: refuse(acceptsHtml(request)) };
}

/** Exported for the deploy guard and the tests; not part of the request path. */
export const STAGING_GATE_INTERNALS = {
  COOKIE_NAME,
  KEY_FIELD,
  HEADER_NAME,
  cookieTokenFor,
} as const;
