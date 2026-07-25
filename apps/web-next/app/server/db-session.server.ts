import {
  openNeonHttpReadDatabase,
  openNeonPersistenceConnection,
  type NeonHttpReadDatabase,
  type NeonPersistenceConnection,
  type PersistenceDatabase,
} from "@vecta/persistence";

/**
 * A per-request, lazily-opened, memoised database session (ADR 0012 §4-pre,
 * extended post-cutover with the HTTP read transport).
 *
 * Two transports, because they are good at different things:
 *
 * • {@link DbSession.read} — Neon SQL-over-HTTP. No connection to establish, so
 *   no handshake to amortise, and `db.batch(...)` puts many statements in ONE
 *   request. Every read path uses it. Nothing to close.
 * • {@link DbSession.database} — the WebSocket Pool. The ONLY transport that
 *   supports interactive transactions (`SELECT ... FOR UPDATE`), so the command
 *   write path needs it. Each open is a WS handshake plus a Postgres
 *   startup/auth exchange, which a single Worker invocation cannot amortise —
 *   hence it is opened lazily, at most once per request, and only when something
 *   actually writes. A read-only request never opens it and `close()` is a no-op.
 *
 * The root middleware owns the lifecycle and calls `close()` in a `finally`
 * after the response.
 */
export interface DbSession {
  /** The read transport: one `fetch` per query or batch, no connection held. */
  read(): NeonHttpReadDatabase;
  /** Open (on first call) and return the write connection's database handle. */
  database(): PersistenceDatabase;
  /** Close the write connection if it was opened; otherwise a no-op. */
  close(): Promise<void>;
}

/**
 * Build a {@link DbSession} for the current request. Validates `DATABASE_URL`
 * eagerly (as the former env-based readers did) so a misconfigured environment
 * fails with a clear error rather than deep inside a query; the write
 * connection is still opened lazily on first use. Both openers are injectable
 * so tests can spy them without a real Neon endpoint.
 */
export function createDbSession(
  env: Env,
  open: (connectionString: string) => NeonPersistenceConnection =
    openNeonPersistenceConnection,
  openRead: (connectionString: string) => NeonHttpReadDatabase =
    openNeonHttpReadDatabase,
): DbSession {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for the database session");
  }
  let connection: NeonPersistenceConnection | undefined;
  let readDatabase: NeonHttpReadDatabase | undefined;
  return {
    read() {
      readDatabase ??= openRead(databaseUrl);
      return readDatabase;
    },
    database() {
      connection ??= open(databaseUrl);
      return connection.database;
    },
    async close() {
      if (connection === undefined) {
        return;
      }
      // Never let a close failure mask the original request error.
      await connection.close().catch(() => undefined);
    },
  };
}
