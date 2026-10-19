import type {
  ProjectAccessGrant,
  ProjectAccessGrantRequest,
  ProjectAccessGrantResolver,
  ProjectRole,
} from "@vecta/application";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProjectReadDatabase } from "./project-read-queries.js";
import {
  principal,
  projectMembership,
  schema,
  tenantMembership,
  wbs,
} from "./schema.js";

export type AgentScope = "project:progress:write" | "project:actuals:write";
export type TenantRole = "OWNER" | "ADMIN" | "MEMBER";

export interface ProjectAccessProvision {
  readonly principal: {
    readonly id: string;
    readonly issuer: string;
    readonly subject: string;
    readonly type: "HUMAN" | "AGENT";
    readonly displayName: string;
    readonly allowedScopes: readonly AgentScope[];
  };
  readonly tenantId: string;
  readonly tenantRole: TenantRole;
  readonly projectId: string;
  readonly projectRole: ProjectRole;
}

function validateProvision(provision: ProjectAccessProvision): void {
  const { principal } = provision;
  const issuer = new URL(principal.issuer);
  const localIssuer = issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1";
  if (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && localIssuer)) {
    throw new Error("OIDC issuer must use HTTPS");
  }
  if (
    principal.subject.trim().length === 0 ||
    principal.displayName.trim().length === 0 ||
    (principal.type === "HUMAN" && principal.allowedScopes.length > 0)
  ) {
    throw new Error("Project access provision is invalid");
  }
}

export class ProjectAccessRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async provision(provision: ProjectAccessProvision): Promise<void> {
    validateProvision(provision);
    await this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(principal)
        .where(eq(principal.id, provision.principal.id))
        .limit(1);
      const allowedScopes = [...new Set(provision.principal.allowedScopes)];
      if (existing === undefined) {
        await transaction.insert(principal).values({
          ...provision.principal,
          allowedScopes,
        });
      } else {
        if (
          existing.issuer !== provision.principal.issuer ||
          existing.subject !== provision.principal.subject ||
          existing.type !== provision.principal.type
        ) {
          throw new Error("Principal identity cannot be reassigned");
        }
        await transaction
          .update(principal)
          .set({ displayName: provision.principal.displayName, allowedScopes })
          .where(eq(principal.id, provision.principal.id));
      }
      await transaction
        .insert(tenantMembership)
        .values({
          tenantId: provision.tenantId,
          principalId: provision.principal.id,
          role: provision.tenantRole,
        })
        .onConflictDoUpdate({
          target: [tenantMembership.tenantId, tenantMembership.principalId],
          set: { role: provision.tenantRole },
        });
      // `provision.projectId` is the WBS id. Membership is stored on the project
      // that owns that WBS.
      const [wbsRow] = await transaction
        .select({ projectId: wbs.projectId })
        .from(wbs)
        .where(and(eq(wbs.tenantId, provision.tenantId), eq(wbs.id, provision.projectId)))
        .limit(1);
      if (wbsRow === undefined) {
        throw new Error("Project access provision is invalid");
      }
      await transaction
        .insert(projectMembership)
        .values({
          tenantId: provision.tenantId,
          projectId: wbsRow.projectId,
          principalId: provision.principal.id,
          role: provision.projectRole,
        })
        .onConflictDoUpdate({
          target: [
            projectMembership.tenantId,
            projectMembership.projectId,
            projectMembership.principalId,
          ],
          set: { role: provision.projectRole },
        });
    });
  }
}

export class PostgresProjectAccessGrantResolver implements ProjectAccessGrantResolver {
  // Read-only, so it accepts either transport — the token surfaces resolve a
  // grant over the HTTP read database rather than opening the write pool.
  constructor(private readonly database: ProjectReadDatabase) {}

  async resolve(request: ProjectAccessGrantRequest): Promise<ProjectAccessGrant | null> {
    const direct = await this.resolveBySubject(request, request.identity.subject);
    if (direct !== null) {
      return direct;
    }
    // Fallback: a principal seeded before its provider subject is known may be keyed by a
    // verified email claim as `email:<address>` (e.g. the admin seed).
    if (request.identity.email !== undefined) {
      return this.resolveBySubject(request, `email:${request.identity.email}`);
    }
    return null;
  }

  private async resolveBySubject(
    request: ProjectAccessGrantRequest,
    subject: string,
  ): Promise<ProjectAccessGrant | null> {
    const [grant] = await this.database
      .select({
        principalId: principal.id,
        principalType: principal.type,
        projectRole: projectMembership.role,
        allowedScopes: principal.allowedScopes,
      })
      .from(principal)
      .innerJoin(
        tenantMembership,
        and(
          eq(tenantMembership.tenantId, request.tenantId),
          eq(tenantMembership.principalId, principal.id),
        ),
      )
      .innerJoin(
        wbs,
        and(eq(wbs.tenantId, request.tenantId), eq(wbs.id, request.projectId)),
      )
      .innerJoin(
        projectMembership,
        and(
          eq(projectMembership.tenantId, wbs.tenantId),
          eq(projectMembership.projectId, wbs.projectId),
          eq(projectMembership.principalId, principal.id),
        ),
      )
      .where(
        and(
          eq(principal.issuer, request.identity.issuer),
          eq(principal.subject, subject),
          isNull(principal.disabledAt),
        ),
      )
      .limit(1);

    return grant ?? null;
  }
}
