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

function sessionStorage(env: Env) {
  return createCookieSessionStorage<SessionData>({
    cookie: {
      // `__Host-` binds the cookie to this exact host over Secure/Path=/, and is
      // accepted on http://localhost by Chrome/Firefox for local development.
      name: "__Host-vecta_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      secrets: sessionSecrets(env),
    },
  });
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
  const storage = sessionStorage(env);
  const session = await storage.getSession(request.headers.get("Cookie"));
  const principalId = session.get("principalId");
  const exp = session.get("exp");
  if (typeof principalId !== "string" || principalId.length === 0) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  if (exp <= nowSeconds(clock)) {
    return null;
  }
  return { principalId, exp };
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
