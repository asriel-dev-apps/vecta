/**
 * Open-redirect guard (ADR 0012 §Decision 4, P0). A candidate `returnTo` is
 * accepted only when it is a same-site absolute path: it must start with `/`
 * and must NOT start with `//` (protocol-relative) or `/\` (backslash trick,
 * which some browsers normalise to `//`). Anything else collapses to `/`.
 *
 * Applied at BOTH `/login` (when writing `returnTo` into the `oidc_tx` cookie)
 * and `/auth/callback` (when consuming it), so a tampered cookie cannot smuggle
 * an off-site redirect either.
 */
export function safeReturnTo(candidate: string | null | undefined): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "/";
  }
  if (!candidate.startsWith("/")) {
    return "/";
  }
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return "/";
  }
  return candidate;
}
