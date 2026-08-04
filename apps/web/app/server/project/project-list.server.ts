import {
  PostgresProjectListReader,
  type AccessibleProject,
} from "@vecta/persistence";
import type { RouterContextProvider } from "react-router";
import { requirePrincipal } from "../auth/require-principal.server";
import { dbSessionContext } from "../context.server";

/**
 * A source of the current principal's accessible projects. `close()` exists for
 * the injectable seam (tests assert it runs), but the Neon-backed source now
 * reads the shared per-request {@link DbSession} and closes NOTHING itself — the
 * root middleware owns the connection lifecycle (ADR 0012 §4-pre).
 */
export interface ProjectListSource {
  listForPrincipal(
    principalId: string,
  ): Promise<readonly AccessibleProject[]>;
  close(): Promise<void>;
}

/**
 * A Neon-backed list source over the shared per-request session's HTTP read
 * transport (reused by the Hono surface via persistence). It opens no connection
 * of its own and its `close()` is a no-op.
 */
export function projectListSourceFromContext(
  context: Readonly<RouterContextProvider>,
): ProjectListSource {
  const session = context.get(dbSessionContext);
  return {
    listForPrincipal: (principalId) =>
      new PostgresProjectListReader(session.read()).listForPrincipal(
        principalId,
      ),
    close: async () => undefined,
  };
}

export interface ProjectListData {
  readonly projects: readonly AccessibleProject[];
}

export interface LoadProjectListOptions {
  readonly sourceFor?: (
    context: Readonly<RouterContextProvider>,
  ) => ProjectListSource;
}

/**
 * Load the signed-in principal's accessible projects for the `/projects` list.
 * The principal is the memoised one from the auth middleware; the list is read
 * over the shared per-request connection. `sourceFor` is injectable for tests;
 * production reads the session from context.
 */
export async function loadProjectList(
  context: Readonly<RouterContextProvider>,
  options: LoadProjectListOptions = {},
): Promise<ProjectListData> {
  const principal = await requirePrincipal(context);
  const sourceFor = options.sourceFor ?? projectListSourceFromContext;
  const source = sourceFor(context);
  try {
    const projects = await source.listForPrincipal(principal.principal.id);
    return { projects };
  } finally {
    await source.close();
  }
}
