/**
 * Open-redirect guard (ADR 0012 §Decision 4, P0).
 *
 * Applied at BOTH `/login` (when writing `returnTo` into the `oidc_tx` cookie)
 * and `/auth/callback` (when consuming it), so a tampered cookie cannot smuggle
 * an off-site redirect either.
 *
 * ## Why this is two layers (2026-07-27 ASVS L2 scan, M2)
 *
 * The original guard was three string tests: starts with `/`, not `//`, not
 * `/\`. An ASCII TAB went straight through, and `/login?returnTo=%2F%09%2Fevil`
 * — a URL shape the auth middleware itself emits, so nothing looks odd to the
 * victim — became an off-site redirect after a successful Google sign-in.
 *
 * The reason is that browsers do not compare strings; they run the WHATWG URL
 * parser, which REMOVES tab, CR and LF anywhere in the input before resolving.
 * Measured: `new URL("/\t/evil.invalid", "https://vecta.example.com")` resolves
 * to `https://evil.invalid/`. `\r\n` never got that far (the Headers setter
 * throws), which is exactly why the omission survived review — the enumeration
 * had been tested against the character that fails loudly.
 *
 * So the fix is not "add tab to the list". The defect WAS the list: a hand-rolled
 * enumeration of what a URL parser does. Hence:
 *
 *   1. Reject any C0 control or DEL outright. Explicit, cheap, and it names the
 *      attack in the code rather than leaving it implicit in layer 2.
 *   2. Resolve the candidate with the SAME parser the browser will use, against a
 *      fixed sentinel origin, and require that it stayed on that origin. This one
 *      does not depend on anyone having enumerated correctly — protocol-relative,
 *      backslash, tab and whatever the next trick turns out to be all show up as
 *      "the origin moved".
 *
 * The value returned is the parser's normalised `pathname + search + hash`, so
 * what the guard approved and what the browser will resolve are the same string.
 */

/**
 * True if the candidate carries a C0 control (U+0000–U+001F) or DEL (U+007F) —
 * the set that includes TAB, LF and CR.
 *
 * Written as a character scan rather than a regex on purpose: `no-control-regex`
 * forbids control characters in a pattern even when escaped, and this repo has
 * already rewritten two regexes out of the parsing path for ReDoS. A loop has
 * neither problem and reads the same.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A host that cannot exist. `.invalid` is reserved by RFC 2606, so this can never
 * collide with a real origin, and it never leaves this function.
 */
const SENTINEL_ORIGIN = "https://same-site.invalid";

export function safeReturnTo(candidate: string | null | undefined): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "/";
  }
  // Layer 1 — the characters a URL parser deletes before resolving.
  if (hasControlCharacter(candidate)) {
    return "/";
  }
  if (!candidate.startsWith("/")) {
    return "/";
  }
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return "/";
  }
  // Layer 2 — resolve it the way the browser will, and insist it stayed here.
  let resolved: URL;
  try {
    resolved = new URL(candidate, SENTINEL_ORIGIN);
  } catch {
    return "/";
  }
  if (resolved.origin !== SENTINEL_ORIGIN) {
    return "/";
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
