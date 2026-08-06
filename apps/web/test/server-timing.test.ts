// @vitest-environment node

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
