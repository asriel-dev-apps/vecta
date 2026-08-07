import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

/** The Drizzle handle the READ adapters run against on the Neon HTTP transport. */
export type NeonHttpReadDatabase = NeonHttpDatabase<typeof schema>;

/**
 * Open a Drizzle database over the Neon **SQL-over-HTTP** transport for reads.
 *
 * The WebSocket-Pool driver (`neon-database.ts`) is what the write path needs —
 * only it supports the interactive transactions (`SELECT ... FOR UPDATE`) the
 * command unit of work relies on. But every open of it is a TCP+TLS+WebSocket
 * handshake plus a Postgres startup/auth exchange, and a Worker invocation is
 * too short-lived to amortise that: a read-only request paid the whole handshake
 * before its first row.
 *
 * The HTTP transport has no connection to establish — each call is one `fetch`
 * to Neon's SQL endpoint — and `db.batch([...])` sends MANY statements in ONE
 * request, executed server-side as a single non-interactive transaction. So the
 * read path costs one network round trip regardless of how many tables it spans.
 *
 * There is nothing to close: no connection is held. Reads that need interactive
 * transaction semantics must keep using {@link openNeonPersistenceConnection}.
 *
 * `isolationLevel`/`readOnly` are set on the CLIENT, not per call: Neon sends
 * them as `Neon-Batch-*` headers so its proxy opens the batch's transaction with
 * them, and Drizzle's `batch()` passes no transaction options of its own, so
 * these defaults are what every batch runs under. REPEATABLE READ is the level
 * the pool-backed reader asks for — under Postgres' READ COMMITTED default each
 * statement in a batch takes its own snapshot, so a concurrent commit landing
 * mid-batch could tear a multi-table read against the revision it reports. READ
 * ONLY is a guard: this handle is for reads, and the server now enforces that.
 * Both headers apply to batches only, so single-statement reads are unaffected.
 */

/**
 * Called once per round trip with how long it took, in milliseconds.
 *
 * DURATION ONLY. It never sees the SQL, the parameters or the rows — the whole
 * point of measuring here is to answer "how long is Tokyo→Singapore" in
 * production, and a hook that could carry data would make that answer cost
 * something. `Server-Timing` is a response header on a public app.
 */
export type RoundTripObserver = (durationMs: number) => void;

export function openNeonHttpReadDatabase(
  connectionString: string,
  onRoundTrip?: RoundTripObserver,
): NeonHttpReadDatabase {
  const client = neon(connectionString, {
    isolationLevel: "RepeatableRead",
    readOnly: true,
  });
  if (onRoundTrip !== undefined) {
    instrumentNeonHttpRoundTrips(client, onRoundTrip);
  }
  return drizzle(client, { schema });
}

/** The two members of the Neon client that Drizzle's HTTP session ever calls. */
interface NeonHttpCallSites {
  query: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Time each HTTP round trip this client makes.
 *
 * **Not via `fetchFunction`, and the first version of this got it wrong.** Neon's
 * `neon(connectionString, options)` destructures a fixed set of options —
 * `arrayMode`, `fullResults`, `fetchOptions`, `isolationLevel`, `readOnly`,
 * `deferrable`, `authToken`, `disableWarningInBrowsers` — and `fetchFunction` is
 * not among them: the typings put it in `NeonConfigGlobalOnly` and the runtime
 * reads it from the module-wide `neonConfig`. Passing it per client is silently
 * ignored, and a conditional object spread is exactly what hides that from
 * excess-property checking. Measured 2026-08-07: a client built the old way ran
 * the real `fetch` and called the supplied function **zero** times, so the header
 * reported `read 0` on every request. `neonConfig.fetchFunction` is not the fix
 * either — it is per module, and one Worker isolate serves several requests at
 * once, so every session would be timing every other session's reads.
 *
 * So the timing sits on the two members Drizzle actually calls
 * (`clientQuery = client.query ?? client`, and `client.transaction` for
 * `db.batch`), which is one wrap per network round trip and no more:
 *
 * • `transaction` is the batch — many statements, ONE request — and is awaited,
 *   so it is timed directly.
 * • `query` returns a LAZY query object. Timing it eagerly would be a bug, not
 *   just an inaccuracy: inside `db.batch` Drizzle builds one of these per
 *   statement and hands the ARRAY to `transaction`, which reads their query data
 *   without ever awaiting them. Touching `.finally()` there would execute each
 *   statement on its own and dismantle the batching the read transport exists
 *   for. So the timer starts in an own `then` — the one thing a batch element is
 *   never subjected to, and the one thing an awaited query always is.
 */
export function instrumentNeonHttpRoundTrips(
  client: unknown,
  onRoundTrip: RoundTripObserver,
): void {
  const callSites = client as NeonHttpCallSites;

  const transaction = callSites.transaction.bind(callSites);
  callSites.transaction = (...args: unknown[]): Promise<unknown> => {
    const startedAt = Date.now();
    return transaction(...args).finally(() => onRoundTrip(Date.now() - startedAt));
  };

  const query = callSites.query.bind(callSites);
  callSites.query = (...args: unknown[]): unknown => {
    const pending = query(...args) as PendingQuery;
    // The prototype `then` is what runs the statement. Shadowing it with an own
    // property leaves the object's identity intact — `transaction` checks these
    // with `instanceof` and would reject a substitute.
    const run = pending.then.bind(pending);
    pending.then = (onFulfilled, onRejected): unknown => {
      const startedAt = Date.now();
      const stop = (): void => onRoundTrip(Date.now() - startedAt);
      return run(
        (value) => {
          stop();
          return onFulfilled === undefined || onFulfilled === null
            ? value
            : onFulfilled(value);
        },
        (error) => {
          stop();
          if (onRejected === undefined || onRejected === null) {
            throw error;
          }
          return onRejected(error);
        },
      );
    };
    return pending;
  };
}

/**
 * The lazy query object Neon's `query` hands back, in the only two respects this
 * touches: it is thenable, and its `then` is what actually runs the statement.
 * The callbacks are typed rather than `unknown` on purpose — narrowing `unknown`
 * with `typeof x === "function"` yields the bare `Function` type, which cannot be
 * called without losing every argument and return check.
 */
interface PendingQuery {
  then: (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((error: unknown) => unknown) | null,
  ) => unknown;
}
