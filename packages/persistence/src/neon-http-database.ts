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
export function openNeonHttpReadDatabase(
  connectionString: string,
): NeonHttpReadDatabase {
  return drizzle(
    neon(connectionString, { isolationLevel: "RepeatableRead", readOnly: true }),
    { schema },
  );
}
