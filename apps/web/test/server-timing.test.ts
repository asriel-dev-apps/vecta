// @vitest-environment node

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDbSession } from "~/server/db-session.server";
import type {
  NeonHttpReadDatabase,
  NeonPersistenceConnection,
  PersistenceDatabase,
} from "@vecta/persistence";

/**
 * `Server-Timing` — the answer to "can production latency be measured, and how?"
 *
 * The question was asked on 2026-07-26 and left open, so the "~70 ms saved" that
 * this project has quoted since is an ARITHMETIC ESTIMATE from counting round
 * trips. This is the instrument that replaces it with a number, and it is the
 * only way to get the real Tokyo→Singapore figure: it has to be measured from
 * inside the Worker, because that is where the round trip starts.
 *
 * Two things are checked, and the second is the one that matters:
 *
 *   1. the durations and counts accumulate per transport;
 *   2. **nothing but numbers can get out.** The observer is handed a duration
 *      and nothing else, so there is no statement, parameter, row or table name
 *      for the header to carry. That is a property of the TYPE, and this asserts
 *      it against the real session rather than trusting the shape.
 *
 * **What this file deliberately does NOT check, and once wrongly appeared to.**
 * Every test here injects fake openers, so it exercises the ACCUMULATOR and never
 * the wiring between a driver and the observer. Both observers shipped inert —
 * the read client was handed an option `neon()` does not accept, and the write
 * pool was wrapped where Drizzle's transactions do not go — and every case below
 * stayed green throughout. That seam is now covered where the drivers are, in
 * `packages/persistence/test/round-trip-timing.test.ts`, which drives the real
 * clients and reproduces both defects as controls.
 */

function fakeRead(): NeonHttpReadDatabase {
  return {} as NeonHttpReadDatabase;
}

function fakeConnection(): NeonPersistenceConnection {
  return {
    database: {} as PersistenceDatabase,
    close: async () => undefined,
  };
}

const env = { DATABASE_URL: "postgresql://user:pw@example.invalid/db" } as unknown as Env;

describe("database round-trip timing", () => {
  it("accumulates reads and writes separately, with counts", () => {
    let readObserver: ((ms: number) => void) | undefined;
    let writeObserver: ((ms: number) => void) | undefined;
    const session = createDbSession(
      env,
      (_url, onRoundTrip) => {
        writeObserver = onRoundTrip;
        return fakeConnection();
      },
      (_url, onRoundTrip) => {
        readObserver = onRoundTrip;
        return fakeRead();
      },
    );

    expect(session.timings()).toEqual({ readCount: 0, readMs: 0, writeCount: 0, writeMs: 0 });

    session.read();
    readObserver?.(12);
    readObserver?.(30);
    session.database();
    writeObserver?.(7);

    // Separated by transport on purpose. A single total would hide the shape of
    // the write path, which issues one statement per task row: it is the COUNT
    // rising with the size of a project that names the problem, not the total.
    expect(session.timings()).toEqual({ readCount: 2, readMs: 42, writeCount: 1, writeMs: 7 });
  });

  it("opens each transport at most once, so the observers stay attached", () => {
    const open = vi.fn(() => fakeConnection());
    const openRead = vi.fn(() => fakeRead());
    const session = createDbSession(env, open, openRead);
    session.read();
    session.read();
    session.database();
    session.database();
    expect(openRead).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a request that touches no database reports zeroes, not absence", () => {
    // The header is emitted either way. A missing header and a zero header mean
    // different things — "nothing was measured" vs "nothing was needed" — and
    // `/login` legitimately needs nothing.
    const session = createDbSession(env, () => fakeConnection(), () => fakeRead());
    expect(session.timings()).toEqual({ readCount: 0, readMs: 0, writeCount: 0, writeMs: 0 });
  });

  it("counts a read through the REAL session — no fakes anywhere in the path", async () => {
    // The assembly, end to end: `createDbSession` with its DEFAULT openers, the
    // real Neon HTTP client, the real Drizzle handle. Every other case in this
    // file injects an opener, which is precisely how a session whose observer
    // was never wired kept them all green.
    //
    // The host is RFC 2606 `.invalid`, so the request fails at the network and
    // leaves this machine alone. A failed round trip is still a round trip that
    // was paid for, which is why the observers fire in `finally`.
    const session = createDbSession({
      DATABASE_URL: "postgresql://user:pw@db.example.invalid/vecta",
    } as unknown as Env);

    expect(session.timings().readCount).toBe(0);
    await expect(session.read().execute(sql`select 1`)).rejects.toThrow();
    expect(session.timings().readCount).toBe(1);
    // Reading must never open the write pool, so the write side stays at zero.
    expect(session.timings().writeCount).toBe(0);
    await session.close();
  });

  it("CONTROL (privacy): the observer is given a NUMBER and nothing else", () => {
    // The whole privacy argument rests on this. If the hook ever grew a second
    // parameter carrying the SQL, the header would become a data channel on a
    // public app — so the arity is asserted, not assumed.
    let observer: ((...args: unknown[]) => void) | undefined;
    const session = createDbSession(
      env,
      (_url, onRoundTrip) => {
        observer = onRoundTrip as ((...args: unknown[]) => void) | undefined;
        return fakeConnection();
      },
      () => fakeRead(),
    );
    session.database();
    expect(observer).toBeTypeOf("function");
    expect(observer?.length).toBe(1);
  });
});
