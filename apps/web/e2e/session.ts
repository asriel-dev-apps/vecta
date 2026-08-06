import { readFileSync } from "node:fs";
import { commitNewSession } from "../app/server/auth/session.server";

/**
 * A signed session cookie for an authenticated screen, minted with the app's OWN
 * `commitNewSession` and the local `SESSION_SECRET`.
 *
 * The rule this exists to honour: **never add a test-only login bypass to product
 * code.** A bypass is a second authentication path, and a second path is one
 * nobody reviews — it would sit in the bundle that ships. Signing a real cookie
 * with the real secret exercises the real verifier instead, so a change that
 * breaks session validation breaks these tests too, which is the point.
 *
 * `.dev.vars` is the same file `wrangler dev` reads, and it is gitignored. Note
 * its values may be QUOTED — wrangler strips the quotes, a naive parser does not,
 * and that mismatch produced a `cookie_invalid` the first time this was done by
 * hand (2026-07-31). Hence `unquote`.
 */

const DEV_VARS = new URL("../.dev.vars", import.meta.url);

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function devVar(name: string): string {
  let raw: string;
  try {
    raw = readFileSync(DEV_VARS, "utf8");
  } catch {
    throw new Error(
      `apps/web/.dev.vars is missing — the e2e suite needs it for ${name}. See the HANDOFF.`,
    );
  }
  const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m").exec(raw);
  if (match?.[1] === undefined) {
    throw new Error(`apps/web/.dev.vars has no ${name}`);
  }
  return unquote(match[1]);
}

/**
 * A signed session as a `Cookie` REQUEST header, not as a cookie-jar entry.
 *
 * `context.addCookies` was the obvious route and does not work: the product's
 * cookie is `__Host-`-prefixed, and Chromium's CDP refuses to install a
 * `__Host-` cookie over plain `http://` however the fields are declared. It
 * reports that as "Invalid cookie fields", which reads like a signing failure and
 * sent the first attempt chasing the wrong thing — the cookie was correct
 * throughout (measured: right name, 146-byte value, no whitespace).
 *
 * Sending the header directly sidesteps the jar's prefix rules while still
 * exercising the REAL verifier on the server, which is the only part that matters
 * here. What it gives up is cookie-jar semantics — expiry, per-path scoping — and
 * this suite asserts nothing about those.
 */
export async function sessionCookieHeader(principalId: string): Promise<string> {
  const environment = { SESSION_SECRET: devVar("SESSION_SECRET") } as unknown as Env;
  const setCookie = await commitNewSession(environment, principalId);
  const pair = setCookie.split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    throw new Error(`unexpected Set-Cookie shape: ${pair}`);
  }
  return pair;
}
