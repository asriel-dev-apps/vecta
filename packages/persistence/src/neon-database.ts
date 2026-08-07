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
    instrumentPoolRoundTrips(pool, onRoundTrip);
  }
  return {
    database: createNeonDatabase(pool),
    close: () => pool.end(),
  };
}

/** Anything with a `query` method: the pool itself, or a client it hands out. */
interface Queryable {
  query: (...args: unknown[]) => unknown;
}

/**
 * Time every statement this pool issues, wherever it is issued from.
 *
 * Wrapping the pool's `query` rather than Drizzle's logger, because the logger
 * is called BEFORE the statement and carries the SQL and its parameters — the
 * two things this measurement must not touch. Here there is a start, an end, and
 * nothing else.
 *
 * **`pool.query` alone is not enough, and the first version of this got it
 * wrong.** Drizzle's node-postgres session, handed something whose constructor
 * name contains "Pool", opens a DEDICATED client for a transaction
 * (`new NodePgSession(await this.client.connect(), …)`) and sends `begin`, every
 * statement in the body and `commit` through that client. Measured 2026-08-07:
 * the Neon serverless pool's constructor name is `NeonPool`, so it takes that
 * branch, and the whole command write path is one `database.transaction(...)` —
 * every statement bypassed a wrapper placed on the pool. The header reported
 * `write 0` on every request while claiming to be the thing that replaced an
 * arithmetic estimate with a measurement. `connect()` is therefore wrapped too,
 * and that is the wrap that actually counts anything.
 */
export function instrumentPoolRoundTrips(pool: unknown, onRoundTrip: RoundTripObserver): void {
  // Per pool, not module-global: a pool belongs to one request, so everything it
  // hands out shares that request's observer. The guard exists because a pool
  // reuses a released client — a second transaction in the same request gets the
  // same object back, and a second wrap would count every statement twice.
  const instrumented = new WeakSet<object>();
  const instrument = (target: Queryable): void => {
    if (instrumented.has(target)) {
      return;
    }
    instrumented.add(target);
    const query = target.query.bind(target);
    target.query = (...args: unknown[]): unknown => {
      const startedAt = Date.now();
      const result = query(...args);
      if (result instanceof Promise) {
        return result.finally(() => onRoundTrip(Date.now() - startedAt));
      }
      onRoundTrip(Date.now() - startedAt);
      return result;
    };
  };

  const poolAsQueryable = pool as Queryable & {
    connect: (...args: unknown[]) => unknown;
  };
  // Statements issued straight on the pool, outside any transaction.
  instrument(poolAsQueryable);
  const connect = poolAsQueryable.connect.bind(poolAsQueryable);
  poolAsQueryable.connect = (...args: unknown[]): unknown => {
    const result = connect(...args);
    // The promise form is what Drizzle uses. The callback form returns nothing
    // to hook, and nothing in this codebase calls it.
    if (result instanceof Promise) {
      return result.then((client: Queryable) => {
        instrument(client);
        return client;
      });
    }
    return result;
  };
}
