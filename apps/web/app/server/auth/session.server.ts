import { createCookieSessionStorage } from "react-router";

/**
 * The signed, httpOnly session cookie (ADR 0012 §Decision 4). It carries ONLY
 * the principal id plus an absolute expiry — never roles (caching roles in the
 * cookie would make an authz change take up to 7 days to apply, i.e. a bypass).
 *
 * `exp` is epoch seconds and is LOAD-BEARING: React Router's cookie sessions do
 * not enforce expiry server-side (`maxAge`/`expires` are only client cookie
 * attributes; the signed payload has no timestamp), so a stolen-but-old cookie
 * whose `maxAge` the client ignored would otherwise still validate. Every read
 * therefore rejects a past `exp`, exactly like a missing cookie (P0).
 */
export interface SessionData {
  principalId: string;
  /** Epoch seconds. 7-day absolute lifetime, no sliding renewal. */
  exp: number;
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type Clock = () => number;

export function nowSeconds(clock: Clock = Date.now): number {
  return Math.floor(clock() / 1000);
}

function sessionSecrets(env: Env): string[] {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not configured for cookie signing");
  }
  const previous = env.SESSION_SECRET_PREVIOUS;
  return previous !== undefined && previous.length > 0
    ? [env.SESSION_SECRET, previous]
    : [env.SESSION_SECRET];
}

/**
 * `__Host-` binds the cookie to this exact host over Secure/Path=/, and is
 * accepted on http://localhost by Chrome/Firefox for local development.
 */
const SESSION_COOKIE_NAME = "__Host-vecta_session";

function sessionStorage(env: Env) {
  return createCookieSessionStorage<SessionData>({
    cookie: {
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      secrets: sessionSecrets(env),
    },
  });
}

/**
 * Why a session was refused. The distinction is the point (ASVS scan M3):
 * `cookie_absent` is everyday traffic — a crawler, a bookmark, a first visit —
 * and `session_expired` is a person coming back the next week, but
 * `cookie_invalid` means a cookie carrying THIS name arrived and did not verify.
 * That does not happen in normal use, and it is invisible if all three collapse
 * into one `null`.
 */
export type SessionRejection = "cookie_absent" | "cookie_invalid" | "session_expired";

export type SessionReadResult =
  | { readonly ok: true; readonly session: SessionData }
  | { readonly ok: false; readonly reason: SessionRejection };

/**
 * Was a cookie by this name sent at all?
 *
 * React Router's `getSession` returns an empty session both for "no cookie" and
 * for "cookie present, signature does not verify" — it does not report which. So
 * the header is checked directly for the name. Parsed by splitting rather than
 * with a regex: this reads an attacker-supplied header, and the repo's lint bans
 * unsafe patterns here for that reason (two ReDoS were found this way in `csv.ts`).
 */
function hasSessionCookie(cookieHeader: string | null): boolean {
  if (cookieHeader === null) return false;
  return cookieHeader
    .split(";")
    .some((part) => part.trimStart().startsWith(`${SESSION_COOKIE_NAME}=`));
}

/**
 * Read and verify the signed session cookie, reporting WHY it was refused.
 * {@link readSession} is the same check with the reason discarded.
 */
export async function readSessionResult(
  env: Env,
  request: Request,
  clock: Clock = Date.now,
): Promise<SessionReadResult> {
  const cookieHeader = request.headers.get("Cookie");
  const storage = sessionStorage(env);
  const session = await storage.getSession(cookieHeader);
  const principalId = session.get("principalId");
  const exp = session.get("exp");
  if (
    typeof principalId !== "string" ||
    principalId.length === 0 ||
    typeof exp !== "number" ||
    !Number.isFinite(exp)
  ) {
    // Nothing readable came out. If the name was on the wire, the payload was
    // tampered with or corrupted; otherwise there was simply no session.
    return { ok: false, reason: hasSessionCookie(cookieHeader) ? "cookie_invalid" : "cookie_absent" };
  }
  if (exp <= nowSeconds(clock)) {
    return { ok: false, reason: "session_expired" };
  }
  return { ok: true, session: { principalId, exp } };
}

/**
 * Read and verify the signed session cookie. Returns `null` — indistinguishable
 * from "no session" for callers — when the cookie is absent, tampered, or its
 * in-payload `exp` is missing or in the past.
 */
export async function readSession(
  env: Env,
  request: Request,
  clock: Clock = Date.now,
): Promise<SessionData | null> {
  const result = await readSessionResult(env, request, clock);
  return result.ok ? result.session : null;
}

/**
 * Issue a fresh session cookie with a 7-day absolute lifetime. `maxAge` is
 * matched to the in-payload `exp`.
 */
export async function commitNewSession(
  env: Env,
  principalId: string,
  clock: Clock = Date.now,
): Promise<string> {
  const storage = sessionStorage(env);
  const session = await storage.getSession();
  const exp = nowSeconds(clock) + SESSION_TTL_SECONDS;
  session.set("principalId", principalId);
  session.set("exp", exp);
  return storage.commitSession(session, { maxAge: SESSION_TTL_SECONDS });
}

/** Clear the session cookie (logout). */
export async function destroySession(env: Env, request: Request): Promise<string> {
  const storage = sessionStorage(env);
  const session = await storage.getSession(request.headers.get("Cookie"));
  return storage.destroySession(session);
}
