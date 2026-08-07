import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instrumentPoolRoundTrips } from "../src/neon-database.js";
import { openNeonHttpReadDatabase } from "../src/neon-http-database.js";
import * as schema from "../src/schema.js";
import { members, tasks } from "../src/schema.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * That the `Server-Timing` observers are actually WIRED.
 *
 * ## Why this file exists
 *
 * Both observers shipped dead, and the test suite could not tell. The only test
 * for them injected fake openers and called the observer by hand, so it measured
 * the accumulator and never the seam that was broken:
 *
 * - the read client was given `fetchFunction`, which `neon()` does not accept as
 *   a per-client option at all (it is module-wide config), so it was silently
 *   dropped and the real `fetch` ran;
 * - the write pool was wrapped on `pool.query`, but Drizzle opens a DEDICATED
 *   client for a transaction and the command write path is one transaction, so
 *   every statement went round the wrapper.
 *
 * Production would have emitted `db;dur=0, dbw;dur=0` on every request while the
 * header was the whole justification for calling the latency figure a
 * measurement rather than an estimate.
 *
 * So these tests drive the REAL objects — the real Drizzle handle over the real
 * Neon HTTP client, and a real `pg.Pool` against the test container — and each
 * has a control that reproduces the original defect.
 */

// Reserved by RFC 2606: guaranteed not to resolve, so the request fails at the
// network without leaving this machine. The observers are wrapped in `finally`
// precisely so a failed round trip is still a round trip that was paid for.
const UNREACHABLE = "postgresql://user:pw@db.example.invalid/vecta";

describe("HTTP read round trips", () => {
  it("times an awaited query, and counts a batch as ONE round trip", async () => {
    const durations: number[] = [];
    const database = openNeonHttpReadDatabase(UNREACHABLE, (ms) => durations.push(ms));

    await expect(database.select().from(tasks).limit(1)).rejects.toThrow();
    expect(durations).toHaveLength(1);

    // The batching claim, asserted rather than assumed: `db.batch` builds one
    // lazy query per statement and sends them in a SINGLE request. If the timer
    // were attached eagerly to each query it would both over-count here AND
    // execute the statements separately, which is the read transport's whole
    // reason for existing.
    await expect(
      database.batch([database.select().from(tasks).limit(1), database.select().from(members).limit(1)]),
    ).rejects.toThrow();
    expect(durations).toHaveLength(2);
  });

  it("CONTROL: `fetchFunction` passed to neon() is never called — the shape this replaced", async () => {
    // Reproduces the original defect directly. If a future Neon release starts
    // honouring a per-client `fetchFunction`, this fails and the simpler wiring
    // becomes available again.
    const { neon } = await import("@neondatabase/serverless");
    let fetchCalls = 0;
    const client = neon(UNREACHABLE, {
      // @ts-expect-error — deliberately passing the option the old code passed:
      // it is not part of `HTTPTransactionOptions`, which is exactly the point.
      fetchFunction: async () => {
        fetchCalls += 1;
        throw new Error("unreachable");
      },
    });
    await expect(client`select 1`).rejects.toThrow();
    expect(fetchCalls).toBe(0);
  });

  it("CONTROL: no observer means no wrapping, and the client still works the same way", async () => {
    const database = openNeonHttpReadDatabase(UNREACHABLE);
    await expect(database.select().from(tasks).limit(1)).rejects.toThrow();
  });
});

describe("write pool round trips", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("round_trip_timing");
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  /** One pool per test; `max: 1` forces a second transaction to REUSE the client. */
  function openPool(): Pool {
    return new Pool({ connectionString: testDatabase.connectionString, max: 1 });
  }

  it("times the statements a transaction issues through its dedicated client", async () => {
    const durations: number[] = [];
    const pool = openPool();
    instrumentPoolRoundTrips(pool, (ms) => durations.push(ms));
    try {
      await drizzle(pool, { schema }).transaction(async (transaction) => {
        await transaction.execute(sql`select 1`);
      });
    } finally {
      await pool.end();
    }
    // `begin`, the body, `commit` — at least three, and the point is that it is
    // not zero.
    expect(durations.length).toBeGreaterThanOrEqual(3);
  });

  it("CONTROL: wrapping only `pool.query` counts NOTHING — the defect this replaced", async () => {
    const pool = openPool();
    let viaPoolQuery = 0;
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { query: unknown }).query = (...args: unknown[]): unknown => {
      viaPoolQuery += 1;
      return query(...args);
    };
    try {
      await drizzle(pool, { schema }).transaction(async (transaction) => {
        await transaction.execute(sql`select 1`);
      });
    } finally {
      await pool.end();
    }
    expect(viaPoolQuery).toBe(0);
  });

  it("CONTROL: a reused client is not wrapped twice, so nothing is counted twice", async () => {
    const durations: number[] = [];
    const pool = openPool();
    instrumentPoolRoundTrips(pool, (ms) => durations.push(ms));
    try {
      const database = drizzle(pool, { schema });
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`select 1`);
      });
      const afterFirst = durations.length;
      // `max: 1`, so this second transaction gets the SAME client object back
      // from the pool. Without the per-pool guard the wrapper would be applied a
      // second time and every statement would be reported twice.
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`select 1`);
      });
      expect(durations.length).toBe(afterFirst * 2);
    } finally {
      await pool.end();
    }
  });
});
