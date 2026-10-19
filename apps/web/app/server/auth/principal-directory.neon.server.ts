import {
  principal as principalTable,
  projectMembership,
  tenantMembership,
  wbs,
} from "@vecta/persistence";
import { and, eq, isNull } from "drizzle-orm";
import type { DbSession } from "../db-session.server";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
  PrincipalIdentity,
} from "./principal-directory.server";

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
          id: principalTable.id,
          issuer: principalTable.issuer,
          subject: principalTable.subject,
          displayName: principalTable.displayName,
          type: principalTable.type,
        })
        .from(principalTable)
        .where(
          and(
            eq(principalTable.issuer, issuer),
            eq(principalTable.subject, subject),
            isNull(principalTable.disabledAt),
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
            id: principalTable.id,
            issuer: principalTable.issuer,
            subject: principalTable.subject,
            displayName: principalTable.displayName,
            type: principalTable.type,
          })
          .from(principalTable)
          .where(
            and(eq(principalTable.id, principalId), isNull(principalTable.disabledAt)),
          )
          .limit(1),
        database
          .select({
            tenantId: tenantMembership.tenantId,
            role: tenantMembership.role,
          })
          .from(tenantMembership)
          .where(eq(tenantMembership.principalId, principalId)),
        database
          .select({
            tenantId: wbs.tenantId,
            projectId: wbs.id,
            role: projectMembership.role,
          })
          .from(projectMembership)
          .innerJoin(
            wbs,
            and(
              eq(wbs.tenantId, projectMembership.tenantId),
              eq(wbs.projectId, projectMembership.projectId),
            ),
          )
          .where(eq(projectMembership.principalId, principalId)),
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
