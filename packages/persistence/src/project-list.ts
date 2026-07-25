import type { AuthenticatedIdentity, ProjectRole } from "@vecta/application";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ProjectReadDatabase } from "./project-read-queries.js";
import { principals, projectMemberships, projects } from "./schema.js";

/**
 * One accessible project for a principal: the project identity + the principal's
 * role on it. The web SSR loader and the later Hono `/api`+`/mcp` surfaces
 * (ADR 0012 §Decision 3) share this reader, so it lives in persistence rather
 * than in any one app.
 */
export interface AccessibleProject {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: ProjectRole;
}

/**
 * Principal-keyed project list. A single `project_memberships ⨝ projects` join
 * filtered by `principalId` — the composite FK
 * (`project_memberships_tenant_membership_fk`) already guarantees the matching
 * tenant membership, so no third join to `tenant_memberships` is needed. Sorted
 * by name (then id, since names are not unique) so the result is deterministic.
 */
export class PostgresProjectListReader {
  constructor(private readonly database: ProjectReadDatabase) {}

  async listForPrincipal(
    principalId: string,
  ): Promise<readonly AccessibleProject[]> {
    return this.database
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        name: projects.name,
        role: projectMemberships.role,
      })
      .from(projectMemberships)
      .innerJoin(
        projects,
        and(
          eq(projects.tenantId, projectMemberships.tenantId),
          eq(projects.id, projectMemberships.projectId),
        ),
      )
      .where(eq(projectMemberships.principalId, principalId))
      .orderBy(asc(projects.name), asc(projects.id));
  }

  /**
   * Identity-keyed accessible-project list (ADR 0012 Step 5 — the token `/api`
   * surface). Matches the principal on `(issuer, subject)` and, when the identity
   * carries a verified email, ALSO on the `email:<address>` key that
   * {@link PostgresProjectAccessGrantResolver} falls back to — a principal seeded
   * before its provider subject is known is keyed as `email:<address>`. The result
   * is the UNION of the direct-subject and `email:`-keyed memberships, deduped by
   * project (the direct-subject role wins on overlap, mirroring the resolver's
   * per-project "direct subject, else email" order). A per-project union rather
   * than "direct, else email" is required for coherence with the resolver, which
   * falls back per project: an identity that has both a subject-keyed principal
   * (≥1 membership) and an `email:`-seeded principal can write the latter's
   * projects, so those projects must not be absent from `/api/projects`. Joins
   * through `principals` so the `disabledAt IS NULL` guard the resolver applies
   * also holds; the composite `project_memberships_tenant_membership_fk` still
   * guarantees the tenant membership, so no third join is needed (as in
   * {@link listForPrincipal}).
   */
  async listForIdentity(
    identity: AuthenticatedIdentity,
  ): Promise<readonly AccessibleProject[]> {
    const direct = await this.listBySubject(identity.issuer, identity.subject);
    if (identity.email === undefined) {
      return direct;
    }
    const viaEmail = await this.listBySubject(identity.issuer, `email:${identity.email}`);
    // Union, deduped by (tenantId, project id). Insert the email-keyed rows first,
    // then overlay the direct rows so the direct-subject role wins on overlap.
    const byProject = new Map<string, AccessibleProject>();
    for (const project of viaEmail) byProject.set(`${project.tenantId}:${project.id}`, project);
    for (const project of direct) byProject.set(`${project.tenantId}:${project.id}`, project);
    // Re-sort by name then id (both `listBySubject` reads are individually sorted,
    // but the union is not), matching the SQL `asc(name), asc(id)` order.
    return [...byProject.values()].sort((a, b) =>
      a.name === b.name
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.name < b.name
          ? -1
          : 1,
    );
  }

  private async listBySubject(
    issuer: string,
    subject: string,
  ): Promise<readonly AccessibleProject[]> {
    return this.database
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        name: projects.name,
        role: projectMemberships.role,
      })
      .from(principals)
      .innerJoin(
        projectMemberships,
        eq(projectMemberships.principalId, principals.id),
      )
      .innerJoin(
        projects,
        and(
          eq(projects.tenantId, projectMemberships.tenantId),
          eq(projects.id, projectMemberships.projectId),
        ),
      )
      .where(
        and(
          eq(principals.issuer, issuer),
          eq(principals.subject, subject),
          isNull(principals.disabledAt),
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
  }
}
