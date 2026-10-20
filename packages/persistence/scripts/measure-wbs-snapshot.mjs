#!/usr/bin/env node
// Local-only size and cost of a 5,000-row WBS snapshot (Design 0016 §3.5).
// Refuses every host but localhost. Starts a Postgres container when
// DATABASE_URL is unset. One JSON line per date-column width.

import { register } from "node:module";
import { Buffer } from "node:buffer";
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

const {
  canonicalWbsState,
  createProjectCommandService,
  decodeWbsSnapshot,
  encodeWbsSnapshot,
  productionSnapshotInterval,
  sha256Hex,
  verifyWbsRange,
} = await import("@vecta/application");
const { default: pg } = await import("pg");
const {
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  createPersistenceDatabase,
  migratePersistenceDatabase,
  toProjectState,
} = await import("../src/index.ts");

const ROWS = 5000;
const REPLAY_CAP_AT_500 = 200;

function assertLocalHost(connectionString) {
  const target = new URL(connectionString);
  const host = target.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`measure-wbs-snapshot refuses host ${host}`);
  }
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
}

function percentile(samples, p) {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function dateKeys(count) {
  const keys = [];
  for (let index = 0; index < count; index += 1) {
    keys.push(new Date(Date.UTC(2026, 0, 5 + index)).toISOString().slice(0, 10));
  }
  return keys;
}

function cellValue(row, column) {
  return ((((row * 2654435761) ^ (column * 40503)) >>> 0) % 961) / 2;
}

function uuid(prefix, sequence) {
  return `${prefix}0000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function buildRecord(dateColumns, shapeIndex) {
  const tenantId = uuid("a", shapeIndex);
  const projectId = uuid("b", shapeIndex);
  const dates = dateKeys(dateColumns);
  const tasks = [];
  for (let row = 0; row < ROWS; row += 1) {
    const dailyPlan = {};
    for (let column = 0; column < dates.length; column += 1) {
      dailyPlan[dates[column]] = cellValue(row, column);
    }
    tasks.push({
      id: uuid("c", row + 1),
      tenantId,
      projectId,
      parentTaskId: null,
      sortOrder: row,
      seq: row + 1,
      name: `Task ${row + 1}`,
      processId: null,
      productId: null,
      note: "",
      contract: "",
      assigneeMemberId: null,
      plannedEffortMinutes: 0,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan,
      datedActuals: {},
      actualStart: null,
      actualFinish: null,
    });
  }
  return {
    tenant: { id: tenantId, name: "Snapshot measure" },
    project: {
      id: projectId,
      tenantId,
      name: `Measure ${dateColumns}`,
      currency: "JPY",
      timezone: "Asia/Tokyo",
      projectStart: "2026-01-05",
      statusDate: "2026-06-01",
      defaultCalendarId: "standard",
      revision: 1n,
      nextTaskSeq: ROWS + 1,
      nextBaselineVersion: 1,
    },
    calendars: [
      {
        tenantId,
        projectId,
        id: "standard",
        name: "Standard",
        workingWeekdays: [1, 2, 3, 4, 5],
        nonWorkingDates: [],
      },
    ],
    members: [],
    processes: [],
    products: [],
    templates: [],
    tasks,
    dependencies: [],
    auditEvents: [
      {
        id: uuid("9", shapeIndex),
        tenantId,
        projectId,
        projectRevision: 1n,
        actorType: "HUMAN",
        actorId: "measure",
        commandType: "project.seed",
        payload: {},
        occurredAt: "2026-01-05T00:00:00.000Z",
      },
    ],
  };
}

function tinyState() {
  return {
    id: uuid("b", 1),
    name: "Tiny",
    projectStart: "2026-01-05",
    statusDate: "2026-01-20",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
    ],
    members: [
      {
        id: uuid("a", 2),
        name: "Member",
        calendarId: "standard",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: null,
      },
    ],
    processes: [],
    products: [],
    templates: [
      {
        id: uuid("e", 1),
        name: "Standard build",
        sortOrder: 0,
        subtasks: [
          { name: "Design", weightBp: 7000 },
          { name: "Review", weightBp: 3000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
        ],
      },
    ],
    tasks: [
      {
        id: uuid("c", 1),
        parentId: null,
        sortOrder: 0,
        seq: 1,
        name: "Parent",
        processId: null,
        productId: null,
        note: "",
        contract: "",
        assigneeMemberId: null,
        plannedEffortMinutes: 1,
        progressBasisPoints: 0,
        actualEffortMinutes: 0,
        prorationWeightBp: null,
        dailyPlan: { "2026-01-05": 0.5, "2026-01-06": 1 },
        datedActuals: {},
        actualStart: null,
        actualFinish: null,
        dependencies: [],
      },
      {
        id: uuid("c", 2),
        parentId: uuid("c", 1),
        sortOrder: 1,
        seq: 2,
        name: "Child",
        processId: null,
        productId: null,
        note: "",
        contract: "",
        assigneeMemberId: null,
        plannedEffortMinutes: 0,
        progressBasisPoints: 0,
        actualEffortMinutes: 0,
        prorationWeightBp: null,
        dailyPlan: {},
        datedActuals: {},
        actualStart: null,
        actualFinish: null,
        dependencies: [{ predecessorId: uuid("c", 1), type: "FS", lagWorkingDays: 0 }],
      },
    ],
    nextTaskSeq: 3,
    nextBaselineVersion: 1,
  };
}

async function assertRoundTrip(state) {
  const text = canonicalWbsState(state);
  const encoded = await encodeWbsSnapshot(state);
  if ((await sha256Hex(text)) !== encoded.sha256) throw new Error("round trip hash mismatch");
  const decoded = await decodeWbsSnapshot(encoded);
  const again = canonicalWbsState(decoded);
  if (again !== text) {
    const limit = Math.min(again.length, text.length);
    let index = 0;
    while (index < limit && again[index] === text[index]) index += 1;
    throw new Error(
      `round trip canonical mismatch at ${index}: ${JSON.stringify(text.slice(index, index + 80))} vs ${JSON.stringify(again.slice(index, index + 80))}`,
    );
  }
}

async function timeWall(body) {
  const start = process.hrtime.bigint();
  await body();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function timeEncode(state) {
  const wall = [];
  const cpu = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const wallStart = process.hrtime.bigint();
    const cpuStart = process.cpuUsage();
    await encodeWbsSnapshot(state);
    const spent = process.cpuUsage(cpuStart);
    wall.push(Number(process.hrtime.bigint() - wallStart) / 1e6);
    cpu.push((spent.user + spent.system) / 1000);
  }
  return { wall, cpu };
}

async function measureShape(client, repository, dateColumns, shapeIndex) {
  console.error(`shape ${dateColumns}: build`);
  const record = buildRecord(dateColumns, shapeIndex);
  console.error(`shape ${dateColumns}: save`);
  await client.query("truncate table tenant cascade");
  await repository.save(record);

  const loaded = await repository.load(record.tenant.id, record.project.id);
  if (loaded === null) throw new Error("saved WBS could not be re-read");
  const state = toProjectState(loaded);
  const text = canonicalWbsState(state);

  console.error(`shape ${dateColumns}: encode`);
  const encodedSamples = await timeEncode(state);
  const probe = await encodeWbsSnapshot(state);
  await client.query("begin");
  let insertMs;
  try {
    insertMs = await timeWall(() =>
      client.query(
        `insert into wbs_snapshot
           (tenant_id, wbs_id, revision, format, sha256, body, body_bytes, raw_bytes)
         values ($1, $2, 2, $3, $4, $5, $6, $7)`,
        [
          record.tenant.id,
          record.project.id,
          probe.format,
          probe.sha256,
          Buffer.from(probe.body),
          probe.body.byteLength,
          probe.rawBytes,
        ],
      ),
    );
  } finally {
    await client.query("rollback");
  }

  const sized = await client.query(
    `select raw_bytes::int as raw_bytes,
            body_bytes::int as body_bytes,
            pg_column_size(body)::int as column_size
       from wbs_snapshot
      where wbs_id = $1 and revision = 1`,
    [record.project.id],
  );
  const size = sized.rows[0];
  if (size === undefined) throw new Error("base snapshot row missing");

  const stored = await client.query(
    "select format, sha256, body from wbs_snapshot where wbs_id = $1 and revision = 1",
    [record.project.id],
  );
  const storedRow = stored.rows[0];
  console.error(`shape ${dateColumns}: decode`);
  const decodeMs = await timeWall(() =>
    decodeWbsSnapshot({
      format: storedRow.format,
      sha256: storedRow.sha256,
      body: storedRow.body,
    }),
  );
  const decoded = await decodeWbsSnapshot({
    format: storedRow.format,
    sha256: storedRow.sha256,
    body: storedRow.body,
  });
  if (canonicalWbsState(decoded) !== text) throw new Error(`shape ${dateColumns} round trip mismatch`);

  const interval = productionSnapshotInterval(size.body_bytes);
  const replayChanges = dateColumns === 500 ? Math.min(interval, REPLAY_CAP_AT_500) : interval;
  const task = state.tasks[0];
  let name = task.name;
  const changes = [];
  for (let index = 0; index < replayChanges; index += 1) {
    const next = `N${index}`;
    changes.push({
      revision: BigInt(index + 2),
      change: {
        format: 1,
        changes: [
          {
            target: `task:${task.id}`,
            field: "name",
            before: name,
            after: next,
            kind: "direct",
          },
        ],
      },
    });
    name = next;
  }
  console.error(`shape ${dateColumns}: replay ${replayChanges} (interval ${interval})`);
  const replayMs = await timeWall(async () => {
    const verdict = await verifyWbsRange(
      { revision: 1n, state },
      changes,
      { revision: BigInt(replayChanges + 1), sha256: "0".repeat(64) },
    );
    if (verdict.ok || verdict.reason !== "hash") {
      throw new Error(`replay stopped before the hash compare: ${verdict.reason ?? "ok"}`);
    }
  });

  const database = createPersistenceDatabase(client);
  console.error(`shape ${dateColumns}: rename not due`);
  const notDue = await timeRenames(database, record, 1n, 5);
  console.error(`shape ${dateColumns}: rename due`);
  const due = await timeRenames(database, record, notDue.revision, 5, () => 1);

  const mbPer10000Revisions = ((10000 / interval) * size.body_bytes) / 1_000_000;
  console.log(
    JSON.stringify({
      rows: ROWS,
      dateColumns,
      rawBytes: size.raw_bytes,
      bodyBytes: size.body_bytes,
      pgColumnSize: size.column_size,
      encodeWallMsP50: roundMs(percentile(encodedSamples.wall, 50)),
      encodeWallMsP95: roundMs(percentile(encodedSamples.wall, 95)),
      encodeCpuMsP50: roundMs(percentile(encodedSamples.cpu, 50)),
      encodeCpuMsP95: roundMs(percentile(encodedSamples.cpu, 95)),
      insertMs: roundMs(insertMs),
      replayMs: roundMs(replayMs),
      replayChanges,
      perChangeMs: roundMs(replayMs / replayChanges),
      decodeMs: roundMs(decodeMs),
      renameNotDueMsP50: roundMs(percentile(notDue.samples, 50)),
      renameDueMsP50: roundMs(percentile(due.samples, 50)),
      interval,
      mbPer10000Revisions: Math.round(mbPer10000Revisions * 1000) / 1000,
    }),
  );
}

async function timeRenames(database, record, startRevision, count, snapshotInterval) {
  const unitOfWork = new PostgresProjectCommandUnitOfWork(
    database,
    snapshotInterval === undefined ? {} : { snapshotInterval },
  );
  const service = createProjectCommandService(unitOfWork);
  const samples = [];
  let revision = startRevision;
  const taskId = record.tasks[0].id;
  for (let index = 0; index < count; index += 1) {
    const start = process.hrtime.bigint();
    const execution = await service.execute({
      tenantId: record.tenant.id,
      projectId: record.project.id,
      expectedRevision: revision,
      operationId: `measure-${record.project.id}-${revision.toString()}`,
      actor: { type: "HUMAN", id: "measure" },
      commands: [
        { type: "task.update", taskId, changes: { name: `Renamed ${revision.toString()}` } },
      ],
    });
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    revision = execution.revision;
  }
  return { samples, revision };
}

console.error("round trip");
await assertRoundTrip(tinyState());

let connectionString = process.env.DATABASE_URL;
let container;
if (connectionString === undefined || connectionString.length === 0) {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  container = await new PostgreSqlContainer("postgres:17.6-alpine").start();
  connectionString = container.getConnectionUri();
}
assertLocalHost(connectionString);

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("set statement_timeout = 0");
  await migratePersistenceDatabase(client);
  const repository = new ProjectRepository(createPersistenceDatabase(client));
  await measureShape(client, repository, 45, 1);
  await measureShape(client, repository, 500, 2);
} finally {
  await client.end();
  await container?.stop();
}
