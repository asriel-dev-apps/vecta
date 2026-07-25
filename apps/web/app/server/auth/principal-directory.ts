/**
 * The principal directory seam (ADR 0012 §Decision 4/5). Verifying the session
 * cookie is pure crypto; turning a principal id (or a verified `(issuer,
 * subject)` pair) into a real principal + its memberships needs the database.
 *
 * This module is DB-free on purpose: it declares only the shapes and the
 * interface, so loaders/middleware and their tests can depend on it without
 * pulling in the persistence layer. The Neon-backed implementation lives in
 * `principal-directory.neon.server.ts`; tests pass a fake.
 */

export interface PrincipalIdentity {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly type: "HUMAN" | "AGENT";
}

export interface TenantMembership {
  readonly tenantId: string;
  readonly role: "OWNER" | "ADMIN" | "MEMBER";
}

export interface ProjectMembership {
  readonly tenantId: string;
  readonly projectId: string;
  readonly role: "OWNER" | "EDITOR" | "VIEWER";
}

export interface AuthenticatedPrincipal {
  readonly principal: PrincipalIdentity;
  readonly tenantMemberships: readonly TenantMembership[];
  readonly projectMemberships: readonly ProjectMembership[];
}

/**
 * Find the principal's membership for a project by its (globally unique) id. A
 * project id is a primary key, so it maps to exactly one tenant and at most one
 * membership row per principal; the caller reads the tenant from the returned
 * row. Pure and DB-free so the access gate and its tests share one check
 * (ADR 0012 §Decision 2). Returns `null` when the principal is not a member —
 * the gate treats that identically to a nonexistent project.
 */
export function findProjectMembership(
  principal: AuthenticatedPrincipal,
  projectId: string,
): ProjectMembership | null {
  return (
    principal.projectMemberships.find(
      (membership) => membership.projectId === projectId,
    ) ?? null
  );
}

export interface PrincipalDirectory {
  /**
   * Resolve a verified `(issuer, subject)` to an active principal, or `null`
   * when no such (non-disabled) principal exists. Used at login; unknown pairs
   * are refused (no just-in-time provisioning in this step).
   */
  findByIssuerSubject(
    issuer: string,
    subject: string,
  ): Promise<PrincipalIdentity | null>;

  /**
   * Load an active principal by id together with its tenant/project
   * memberships, or `null` when it no longer exists / was disabled. Used per
   * request for authenticated routes.
   */
  loadPrincipal(principalId: string): Promise<AuthenticatedPrincipal | null>;
}
