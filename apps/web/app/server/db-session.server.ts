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
/**
 * What this request spent talking to the database, split by transport.
 *
 * Counts and milliseconds only — never a statement, a parameter or a row. It
 * leaves the Worker as a `Server-Timing` header on a public app, so the shape of
 * this type is the privacy boundary.
 */
export interface DbTimings {
  /** HTTP read round trips: one per query or `batch(...)`. */
  readonly readCount: number;
  readonly readMs: number;
  /** Statements issued over the WebSocket pool by the command write path. */
  readonly writeCount: number;
  readonly writeMs: number;
}

export interface DbSession {
  /** The read transport: one `fetch` per query or batch, no connection held. */
  read(): NeonHttpReadDatabase;
  /** Open (on first call) and return the write connection's database handle. */
  database(): PersistenceDatabase;
  /** Close the write connection if it was opened; otherwise a no-op. */
  close(): Promise<void>;
  /**
   * What has been spent so far. Read AFTER the response is produced, by the root
   * middleware — every loader and action has awaited its reads by then.
   */
  timings(): DbTimings;
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
  open: (
    connectionString: string,
    onRoundTrip?: (durationMs: number) => void,
  ) => NeonPersistenceConnection = openNeonPersistenceConnection,
  openRead: (
    connectionString: string,
    onRoundTrip?: (durationMs: number) => void,
  ) => NeonHttpReadDatabase = openNeonHttpReadDatabase,
): DbSession {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for the database session");
  }
  let connection: NeonPersistenceConnection | undefined;
  let readDatabase: NeonHttpReadDatabase | undefined;
  // Accumulated per request. Plain numbers rather than a list of samples: the
  // header carries a total, and keeping the samples would be keeping data this
  // has no use for.
  let readCount = 0;
  let readMs = 0;
  let writeCount = 0;
  let writeMs = 0;
  return {
    read() {
      readDatabase ??= openRead(databaseUrl, (durationMs) => {
        readCount += 1;
        readMs += durationMs;
      });
      return readDatabase;
    },
    database() {
      connection ??= open(databaseUrl, (durationMs) => {
        writeCount += 1;
        writeMs += durationMs;
      });
      return connection.database;
    },
    timings() {
      return { readCount, readMs, writeCount, writeMs };
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
