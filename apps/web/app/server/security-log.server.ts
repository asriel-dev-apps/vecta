import { errorName } from "./api/edge-security.server";

/**
 * Authentication and authorization events for the DOCUMENT surface — the
 * 2026-07-27 ASVS L2 scan, finding M3, and the last Medium it left open.
 * Design: `design/0006-auth-authz-security-logging.md`.
 *
 * ## What the finding actually is
 *
 * Not "there is not enough logging". `operations/monitoring-and-alerts.md` lists
 * "changes in 401/403" as a REQUIRED signal on the OIDC boundary, and nothing in
 * this app produced it: `audit_events` records only SUCCESSFUL project changes,
 * and the one HTTP log (`writeHttpRequestLog`) exists only on `/api` and `/mcp`.
 *
 * And the required signal is unsatisfiable as written, because the browser
 * surface does not answer denial with 401/403 at all:
 *
 * | denial | what the browser surface actually returns |
 * | --- | --- |
 * | no / expired / tampered session | **302** to `/login?returnTo=…` |
 * | not a member of the project | **404**, indistinguishable from nonexistent by design |
 * | insufficient role on a write | 403 |
 * | verified by Google, no VECTA principal | 403 |
 *
 * Counting status codes therefore cannot see most authentication denials — 302
 * and 404 are also what a healthy app emits all day. So the fix is to make the
 * events explicit and redefine the operational signal on top of them.
 *
 * ## Why this is not a third outlet
 *
 * The two that exist — `writeHttpRequestLog` and `document_unhandled_error` —
 * are the SAME outlet: `console.*(JSON.stringify({event, …}))` into Cloudflare
 * Workers Logs via `observability.enabled`. Only the record type differs. This
 * adds a third record type to that one outlet, under two constraints:
 *
 * 1. The vocabulary is shared, not re-invented: `errorName` (the `/api`
 *    allowlist) and {@link documentRoute} (path templating) are the existing
 *    functions, imported rather than copied.
 * 2. Emission is closed in this module. Nothing else calls `console` for a
 *    security event, and callers pass a typed `kind`/`reason` — there is no
 *    free-text field a caller can push arbitrary content into.
 */

/** The eight events. Seven are named by the scan; `principal_revoked` is the eighth. */
export type SecurityEventKind =
  /** `/auth/callback` issued a session cookie. */
  | "login_succeeded"
  /** `/auth/callback` ended on a failure screen. */
  | "login_failed"
  /** Google verified the person; VECTA has no principal for them. */
  | "unknown_principal"
  /** A protected route was reached with no / an invalid / an expired session. */
  | "session_rejected"
  /** The session verified, but its principal is gone or disabled. */
  | "principal_revoked"
  /** The `/projects/:id` gate refused. */
  | "project_access_denied"
  /** A command batch was refused by the authorizer. */
  | "write_denied"
  /** The pre-authentication rate limit fired on the document surface. */
  | "rate_limited";

/**
 * The sub-reason. A closed union on purpose: a caller cannot invent one, and a
 * dashboard can enumerate them. The `login_failed` reasons are deliberately NOT
 * collapsed — the scan names "token exchange failure" and "nonce mismatch" as
 * separate unrecorded events, so a log that folds both into one value does not
 * answer the finding.
 */
export type SecurityEventReason =
  // login_succeeded — every record carries a reason, so success has one too and
  // a reader never has to branch on whether the field is there.
  | "session_issued"
  // login_failed / unknown_principal
  | "provider_reported_error"
  | "no_transaction"
  | "state_mismatch"
  | "token_exchange_failed"
  | "id_token_rejected"
  | "principal_not_found"
  | "directory_unavailable"
  | "unexpected_error"
  // session_rejected / principal_revoked
  | "cookie_absent"
  | "cookie_invalid"
  | "session_expired"
  | "principal_missing"
  // project_access_denied
  | "malformed_project_id"
  | "not_a_member"
  | "project_missing"
  // write_denied
  | "insufficient_role"
  // rate_limited
  | "pre_auth_rate_limit";

declare const subjectDigestBrand: unique symbol;

/**
 * A keyed, truncated digest of a verified `(issuer, subject)` pair — the ONLY
 * identifier the log is allowed to carry for someone who has no principal.
 *
 * Branded so a raw `sub`, an email, or a display name cannot be passed where a
 * digest is expected: the type is unconstructible outside {@link subjectDigest}.
 */
export type SubjectDigest = string & { readonly [subjectDigestBrand]: true };

/**
 * HMAC-SHA256 over `issuer:subject`, keyed with `SESSION_SECRET`, first 16 hex
 * characters (64 bits).
 *
 * `operations/monitoring-and-alerts.md` already forbade the OIDC subject in logs
 * and directed identification through internal UUIDs — which is exactly what
 * every other event here uses (`principalId`). This case is the one where no
 * internal UUID exists yet, and dropping the identifier entirely would make the
 * event useless: a spike of `unknown_principal` cannot be read without knowing
 * whether it is one person retrying or many people arriving.
 *
 * KEYED rather than a plain SHA-256, because the adversary this protects against
 * is someone with log access: a plain digest lets them confirm "was it this
 * account?" for any `sub` they can guess or already hold, which is the whole
 * disclosure being avoided. Keying with `SESSION_SECRET` also means a secret
 * rotation expires the ability to correlate — a retention bound, not a defect.
 */
export async function subjectDigest(
  env: Env,
  issuer: string,
  subject: string,
): Promise<SubjectDigest> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not configured for subject digests");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${issuer}:${subject}`),
  );
  return Array.from(new Uint8Array(mac).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") as SubjectDigest;
}

/**
 * Template the path so the log carries the ROUTE, not the identifiers on it.
 * Every matched param value is replaced by `:name`, which needs no guessing about
 * what an id looks like — React Router already told us. An unmatched path (a 404,
 * therefore attacker-chosen) is passed through but capped, and it is emitted
 * inside `JSON.stringify`, so it cannot break out into a forged log line.
 *
 * Moved here from `entry.server.tsx` (ASVS M3): the auth middleware and the
 * project gate both need it, and importing the document entry from a middleware
 * to get at it would be worse than moving the function. A copy would be worse
 * still — the two surfaces would drift into logging different route shapes.
 *
 * A segment is matched against the param value BOTH raw and percent-decoded.
 * React Router hands over DECODED params while `URL.pathname` keeps the encoded
 * bytes, so a value containing anything the path encoder touches (`<`, `>`, `"`,
 * space, …) would otherwise fail to match and be echoed into the log. Measured
 * on the malformed-project-id path, where the value is attacker-chosen: without
 * the decode, `/projects/not-a-uuid-%3Cscript%3E/wbs` is what gets recorded.
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
    .map((segment) => byValue.get(segment) ?? byValue.get(decodeSegment(segment)) ?? segment)
    .join("/");
  return templated.length > 128 ? `${templated.slice(0, 128)}…` : templated;
}

/**
 * `decodeURIComponent` THROWS on a lone `%` or a bad escape — and this input is
 * a request path, so that is reachable from outside. A failed decode simply
 * means the segment cannot be a param value, so it falls back to itself.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The request id `/api` and the document edge both use. `withDocumentEdge`
 * stamps it before React Router runs, so a middleware or loader reads the same
 * id the edge log and the response header carry.
 */
export function requestIdOf(request: Request): string {
  return request.headers.get("x-request-id") ?? "unknown";
}

export interface SecurityEventInput {
  readonly kind: SecurityEventKind;
  readonly reason: SecurityEventReason;
  /** The status the surface actually answers with — 302 and 404 included. */
  readonly status: number;
  readonly request: Request;
  /** React Router's matched params, so the route is templated rather than guessed. */
  readonly params?: Readonly<Record<string, string | undefined>>;
  /** Overrides the header-derived id, for the edge layer that mints it. */
  readonly requestId?: string;
  /** The internal principal UUID. Never an email, never a display name. */
  readonly principalId?: string;
  readonly subjectDigest?: SubjectDigest;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly projectRole?: string;
  /** Passed through `errorName`; the `Error` itself never reaches `console`. */
  readonly error?: unknown;
}

/**
 * Emit one JSON line. `event` is `"security_event"` for every kind, so the
 * operational signal is one predicate rather than a list a reader has to keep in
 * sync with this union.
 *
 * A successful login goes to `console.log`; every denial goes to `console.warn`,
 * so the level alone separates the two without parsing. `console.error` stays
 * reserved for the 5xx/unhandled records — a refused sign-in is the system
 * working, not failing.
 */
export function writeSecurityEvent(input: SecurityEventInput): void {
  const record: Record<string, string | number> = {
    event: "security_event",
    kind: input.kind,
    reason: input.reason,
    requestId: input.requestId ?? requestIdOf(input.request),
    method: input.request.method,
    route: documentRoute(new URL(input.request.url).pathname, input.params ?? {}),
    status: input.status,
  };
  if (input.principalId !== undefined) record.principalId = input.principalId;
  if (input.subjectDigest !== undefined) record.subjectDigest = input.subjectDigest;
  if (input.tenantId !== undefined) record.tenantId = input.tenantId;
  if (input.projectId !== undefined) record.projectId = input.projectId;
  if (input.projectRole !== undefined) record.projectRole = input.projectRole;
  if (input.error !== undefined) record.errorName = errorName(input.error);
  const serialized = JSON.stringify(record);
  if (input.kind === "login_succeeded") console.log(serialized);
  else console.warn(serialized);
}
