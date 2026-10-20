#!/usr/bin/env node
// Cutover base and range check for every WBS (Design 0016 §2.3, §3.5).
//
//   EXPECTED_DATABASE_HOST=<host> \
//   EXPECTED_DATABASE_NAME=<name> \
//   DATABASE_URL=... \
//   pnpm --filter @vecta/persistence db:snapshot -- base
//   pnpm --filter @vecta/persistence db:snapshot -- verify
//
// `base` prints one line per WBS (`inserted` or `existed`). A second run prints
// only `existed`. `verify` walks every unverified snapshot pair and exits
// non-zero if any verdict failed.
//
// Same host/name confirmation as seed-demo-project.mjs: the URL must match the
// two EXPECTED_ variables, so a stray DATABASE_URL cannot reach another database.

import { register } from "node:module";
import process from "node:process";

const TS_SOURCE_RESOLVE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(TS_SOURCE_RESOLVE_HOOK)}`);

const { default: pg } = await import("pg");
const { WbsSnapshotStore, createPersistenceDatabase } = await import(
  "../src/index.ts"
);

// pnpm passes the `--` separator through to the script.
const command = process.argv.slice(2).find((argument) => argument !== "--");
if (command !== "base" && command !== "verify") {
  throw new Error("usage: pnpm --filter @vecta/persistence db:snapshot -- base|verify");
}

const connectionString = process.env.DATABASE_URL;
const expectedHost = process.env.EXPECTED_DATABASE_HOST;
const expectedDatabase = process.env.EXPECTED_DATABASE_NAME;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required");
}
if (expectedHost === undefined || expectedHost.length === 0) {
  throw new Error("EXPECTED_DATABASE_HOST is required");
}
if (expectedDatabase === undefined || expectedDatabase.length === 0) {
  throw new Error("EXPECTED_DATABASE_NAME is required");
}

const target = new URL(connectionString);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ""));
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  throw new Error("DATABASE_URL must use PostgreSQL");
}
if (target.hostname !== expectedHost || databaseName !== expectedDatabase) {
  throw new Error("DATABASE_URL does not match the confirmed database target");
}

function formatVerdict(wbsId, verdict) {
  const span = `${verdict.from}->${verdict.to}`;
  if (verdict.ok) return `${wbsId} ${span} ok`;
  if (verdict.reason === "gap") return `${wbsId} ${span} gap@${verdict.missing}`;
  if (verdict.reason === "stale") return `${wbsId} ${span} stale@${verdict.at}`;
  return `${wbsId} ${span} hash`;
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const listed = await client.query("select tenant_id, id from wbs order by tenant_id, id");
  const store = new WbsSnapshotStore(createPersistenceDatabase(client));
  let failed = false;
  for (const row of listed.rows) {
    const key = { tenantId: row.tenant_id, wbsId: row.id };
    if (command === "base") {
      const outcome = await store.takeBase(key);
      console.log(`${row.id} ${outcome.result}`);
      continue;
    }
    for (;;) {
      const verdict = await store.verifyNext(key);
      if (verdict === null) break;
      console.log(formatVerdict(row.id, verdict));
      if (!verdict.ok) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  await client.end();
}
