import { Pool } from "@neondatabase/serverless";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import type { RoundTripObserver } from "./neon-http-database.js";
import type { PersistenceDatabase } from "./persistence-database.js";
import * as schema from "./schema.js";

export interface NeonPersistenceConnection {
  readonly database: PersistenceDatabase;
  close(): Promise<void>;
}

// The Neon serverless Pool is a WebSocket-backed, pg-wire-compatible client, so
// the node-postgres Drizzle driver drives it unchanged — including the
// interactive transactions (`SELECT ... FOR UPDATE`) the command write path
// relies on. This keeps the Repository adapters typed against a single
// `PersistenceDatabase`, identical to the Hyperdrive/pg path. The cast bridges
// the two packages' structurally-identical but nominally-distinct client types.
function createNeonDatabase(pool: Pool): PersistenceDatabase {
  return drizzle(pool as unknown as NodePgClient, { schema });
}

/**
 * Open a Drizzle database over the Neon serverless (WebSocket) driver for a
 * single Worker invocation. Unlike the neon-http driver, this transport
 * supports interactive transactions. The caller owns the connection and must
 * `close()` it when the invocation ends.
 */
export function openNeonPersistenceConnection(
  connectionString: string,
  onRoundTrip?: RoundTripObserver,
): NeonPersistenceConnection {
  const pool = new Pool({ connectionString });
  if (onRoundTrip !== undefined) {
    // Wrapping `pool.query` rather than Drizzle's logger, because the logger is
    // called BEFORE the statement and carries the SQL and its parameters — the
    // two things this measurement must not touch. Here there is a start, an end,
    // and nothing else.
    //
    // The write path issues one statement per task row, twice, so this is the
    // instrument that makes that cost visible instead of inferred.
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { query: unknown }).query = (...args: unknown[]): unknown => {
      const startedAt = Date.now();
      const result = query(...args);
      if (result instanceof Promise) {
        return result.finally(() => onRoundTrip(Date.now() - startedAt));
      }
      onRoundTrip(Date.now() - startedAt);
      return result;
    };
  }
  return {
    database: createNeonDatabase(pool),
    close: () => pool.end(),
  };
}
