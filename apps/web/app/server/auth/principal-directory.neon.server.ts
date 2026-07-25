import {
  principals,
  projectMemberships,
  tenantMemberships,
} from "@vecta/persistence";
import { and, eq, isNull } from "drizzle-orm";
import type { DbSession } from "../db-session.server";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
  PrincipalIdentity,
} from "./principal-directory";

/**
 * Neon-backed {@link PrincipalDirectory} built over the per-request
 * {@link DbSession}'s HTTP read transport. Every authenticated request resolves
 * the principal, so this is the hottest read in the app: `loadPrincipal` sends
 * the principal row and BOTH membership lookups as a single `db.batch(...)` —
 * one network round trip, where the earlier shape cost a WebSocket handshake
 * plus two sequential ones. The three queries are keyed only on `principalId`,
 * so none depends on another's result and batching changes no semantics: an
 * absent principal still yields `null` and its membership rows are discarded.
 *
 * The session's write connection is never opened by this path.
 */
export function createNeonPrincipalDirectory(
  session: DbSession,
): PrincipalDirectory {
  return {
    async findByIssuerSubject(issuer, subject) {
      const database = session.read();
      const [row] = await database
        .select({
          id: principals.id,
          issuer: principals.issuer,
          subject: principals.subject,
          displayName: principals.displayName,
          type: principals.type,
        })
        .from(principals)
        .where(
          and(
            eq(principals.issuer, issuer),
            eq(principals.subject, subject),
            isNull(principals.disabledAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async loadPrincipal(principalId) {
      const database = session.read();
      const [[principal], tenants, projects] = await database.batch([
        database
          .select({
            id: principals.id,
            issuer: principals.issuer,
            subject: principals.subject,
            displayName: principals.displayName,
            type: principals.type,
          })
          .from(principals)
          .where(
            and(eq(principals.id, principalId), isNull(principals.disabledAt)),
          )
          .limit(1),
        database
          .select({
            tenantId: tenantMemberships.tenantId,
            role: tenantMemberships.role,
          })
          .from(tenantMemberships)
          .where(eq(tenantMemberships.principalId, principalId)),
        database
          .select({
            tenantId: projectMemberships.tenantId,
            projectId: projectMemberships.projectId,
            role: projectMemberships.role,
          })
          .from(projectMemberships)
          .where(eq(projectMemberships.principalId, principalId)),
      ]);
      if (principal === undefined) {
        return null;
      }
      const resolved: AuthenticatedPrincipal = {
        principal: principal satisfies PrincipalIdentity,
        tenantMemberships: tenants,
        projectMemberships: projects,
      };
      return resolved;
    },
  };
}
