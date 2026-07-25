import { projects } from "@vecta/persistence";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "../db-session.server";
import type { ProjectReader } from "./project-access";

/**
 * Neon-backed {@link ProjectReader} built over the per-request {@link DbSession}'s
 * HTTP read transport. Fetches the project row by its composite `(tenantId, id)`
 * key — never by global id alone — so the row is read through the same tenant
 * scope the membership was matched on. Opens no connection: one `fetch`, and the
 * session's write pool stays untouched.
 */
export function createNeonProjectReader(session: DbSession): ProjectReader {
  return {
    async loadProject(tenantId, projectId) {
      const database = session.read();
      const [row] = await database
        .select({
          id: projects.id,
          tenantId: projects.tenantId,
          name: projects.name,
        })
        .from(projects)
        .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
        .limit(1);
      return row ?? null;
    },
  };
}
