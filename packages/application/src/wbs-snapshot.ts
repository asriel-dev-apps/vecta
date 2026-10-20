/**
 * Periodic WBS snapshot (Design 0016 §2.3, §3.5).
 *
 * The body is gzip(UTF-8(canonicalWbsState(state))). The hash is over the
 * uncompressed text, so a replay can be checked without decompressing the
 * next snapshot. Format 1 stays readable: a newer format adds an upgrader.
 */
import type { DependencyType } from "@vecta/domain";
import type {
  ProjectCalendar,
  ProjectDependency,
  ProjectMember,
  ProjectProcess,
  ProjectProduct,
  ProjectState,
  ProjectTask,
} from "./project-state.js";
import type { SubtaskTemplate, SubtaskTemplateStep } from "./subtask-templates.js";
import {
  applyWbsChange,
  canonicalWbsState,
  sha256Hex,
  WbsChangeStaleError,
  type Sha256Hex,
  type WbsChange,
} from "./wbs-change.js";

/** Serialization version of the snapshot body. Equals the `canonical` field inside the body. */
export const WBS_SNAPSHOT_FORMAT = 1;

/**
 * What one `wbs_snapshot` row holds. `body` is gzip(UTF-8(canonicalWbsState(state))).
 * The hash is over the uncompressed text.
 */
export interface EncodedWbsSnapshot {
  readonly format: typeof WBS_SNAPSHOT_FORMAT;
  readonly sha256: Sha256Hex;
  readonly rawBytes: number;
  readonly body: Uint8Array;
}

/** A row as read back from the DB. `format` is any stored format, past or current. */
export interface StoredWbsSnapshot {
  readonly format: number;
  readonly sha256: string;
  readonly body: Uint8Array;
}

export class WbsSnapshotCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WbsSnapshotCorruptError";
  }
}

/** One canonical pass, one hash, one gzip (CompressionStream: Node and Workers). */
export async function encodeWbsSnapshot(state: ProjectState): Promise<EncodedWbsSnapshot> {
  const text = canonicalWbsState(state);
  const sha256 = await sha256Hex(text);
  const raw = new TextEncoder().encode(text);
  const body = await gzip(raw);
  return { format: WBS_SNAPSHOT_FORMAT, sha256, rawBytes: raw.byteLength, body };
}

/**
 * Parse boundary. gunzip → re-hash → JSON → upgraders → strict format-1 parse.
 * A bad gzip, a hash that does not match the column, or a body that is not
 * format 1 after upgrading throws `WbsSnapshotCorruptError`.
 */
export async function decodeWbsSnapshot(stored: StoredWbsSnapshot): Promise<ProjectState> {
  if (!Number.isSafeInteger(stored.format) || stored.format < 1) {
    throw new WbsSnapshotCorruptError("format");
  }
  let text: string;
  try {
    const bytes = await gunzip(stored.body);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof WbsSnapshotCorruptError) throw error;
    throw new WbsSnapshotCorruptError(error instanceof Error ? error.message : "gzip");
  }
  const actual = await sha256Hex(text);
  if (actual !== stored.sha256) throw new WbsSnapshotCorruptError("sha256");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WbsSnapshotCorruptError(error instanceof Error ? error.message : "json");
  }
  return upgradeAndParse(stored.format, parsed);
}

/**
 * Each entry rewrites a stored body of that canonical version into the next.
 * Format 1 is current, so the table is empty.
 */
const WBS_SNAPSHOT_UPGRADERS: {
  readonly [format: number]: (old: Record<string, unknown>) => Record<string, unknown>;
} = {};

function upgradeAndParse(columnFormat: number, parsed: unknown): ProjectState {
  let current = plainRecord(parsed, "snapshot");
  if (typeof current.canonical !== "number" || !Number.isSafeInteger(current.canonical) || current.canonical < 1) {
    throw new WbsSnapshotCorruptError("canonical");
  }
  if (current.canonical !== columnFormat) throw new WbsSnapshotCorruptError("format");
  let format = current.canonical;
  const seen = new Set<number>();
  while (format < WBS_SNAPSHOT_FORMAT) {
    if (seen.has(format)) throw new WbsSnapshotCorruptError("upgrade cycle");
    seen.add(format);
    const upgrade = WBS_SNAPSHOT_UPGRADERS[format];
    if (upgrade === undefined) throw new WbsSnapshotCorruptError(`no upgrade from format ${format}`);
    current = plainRecord(upgrade(current), "upgraded snapshot");
    if (typeof current.canonical !== "number" || !Number.isSafeInteger(current.canonical) || current.canonical < 1) {
      throw new WbsSnapshotCorruptError("canonical");
    }
    format = current.canonical;
  }
  if (format !== WBS_SNAPSHOT_FORMAT) throw new WbsSnapshotCorruptError(`unsupported format ${format}`);
  return parseCanonicalFormat1(current);
}

const FORMAT1_KEYS = [
  "calendars",
  "canonical",
  "currency",
  "defaultCalendarId",
  "id",
  "members",
  "name",
  "nextBaselineVersion",
  "nextTaskSeq",
  "processes",
  "products",
  "projectStart",
  "statusDate",
  "tasks",
  "templates",
] as const;

function parseCanonicalFormat1(record: Record<string, unknown>): ProjectState {
  exactKeys(record, FORMAT1_KEYS, "snapshot");
  if (record.canonical !== WBS_SNAPSHOT_FORMAT) throw new WbsSnapshotCorruptError("canonical");
  const currency = requiredString(record, "currency", "snapshot");
  if (currency !== "JPY") throw new WbsSnapshotCorruptError("currency");
  return {
    id: requiredString(record, "id", "snapshot"),
    name: requiredString(record, "name", "snapshot"),
    projectStart: requiredString(record, "projectStart", "snapshot"),
    statusDate: requiredString(record, "statusDate", "snapshot"),
    currency,
    defaultCalendarId: requiredString(record, "defaultCalendarId", "snapshot"),
    nextTaskSeq: requiredNumber(record, "nextTaskSeq", "snapshot"),
    nextBaselineVersion: requiredNumber(record, "nextBaselineVersion", "snapshot"),
    calendars: parseArray(record.calendars, "calendars", parseCalendar),
    members: parseArray(record.members, "members", parseMember),
    processes: parseArray(record.processes, "processes", parseNamedSort),
    products: parseArray(record.products, "products", parseNamedSort),
    templates: parseArray(record.templates, "templates", parseTemplate),
    tasks: parseArray(record.tasks, "tasks", parseTask),
  };
}

function parseCalendar(value: unknown, label: string): ProjectCalendar {
  const record = plainRecord(value, label);
  exactKeys(record, ["id", "name", "nonWorkingDates", "workingWeekdays"], label);
  return {
    id: requiredString(record, "id", label),
    name: requiredString(record, "name", label),
    workingWeekdays: numberArray(record.workingWeekdays, label),
    nonWorkingDates: stringArray(record.nonWorkingDates, label),
  };
}

function parseMember(value: unknown, label: string): ProjectMember {
  const record = plainRecord(value, label);
  exactKeys(record, ["calendarId", "costRateMinorPerHour", "dailyCapacityMinutes", "id", "name"], label);
  return {
    id: requiredString(record, "id", label),
    name: requiredString(record, "name", label),
    calendarId: requiredString(record, "calendarId", label),
    dailyCapacityMinutes: requiredNumber(record, "dailyCapacityMinutes", label),
    costRateMinorPerHour: nullableNumber(record.costRateMinorPerHour, label),
  };
}

function parseNamedSort(value: unknown, label: string): ProjectProcess & ProjectProduct {
  const record = plainRecord(value, label);
  exactKeys(record, ["id", "name", "sortOrder"], label);
  return {
    id: requiredString(record, "id", label),
    name: requiredString(record, "name", label),
    sortOrder: requiredNumber(record, "sortOrder", label),
  };
}

function parseTemplate(value: unknown, label: string): SubtaskTemplate {
  const record = plainRecord(value, label);
  exactKeys(record, ["id", "name", "sortOrder", "subtasks"], label);
  return {
    id: requiredString(record, "id", label),
    name: requiredString(record, "name", label),
    sortOrder: requiredNumber(record, "sortOrder", label),
    subtasks: parseArray(record.subtasks, `${label} subtasks`, parseStep),
  };
}

function parseStep(value: unknown, label: string): SubtaskTemplateStep {
  const record = plainRecord(value, label);
  const name = requiredString(record, "name", label);
  const weightBp = requiredNumber(record, "weightBp", label);
  if (!Object.hasOwn(record, "dependsOnPrev")) {
    exactKeys(record, ["name", "weightBp"], label);
    return { name, weightBp };
  }
  exactKeys(record, ["dependsOnPrev", "name", "weightBp"], label);
  const dependency = plainRecord(record.dependsOnPrev, label);
  exactKeys(dependency, ["lagWorkingDays", "type"], label);
  return {
    name,
    weightBp,
    dependsOnPrev: {
      type: dependencyType(dependency.type, label),
      lagWorkingDays: requiredNumber(dependency, "lagWorkingDays", label),
    },
  };
}

const TASK_KEYS = [
  "actualEffortMinutes",
  "actualFinish",
  "actualStart",
  "assigneeMemberId",
  "contract",
  "dailyPlan",
  "datedActuals",
  "dependencies",
  "id",
  "name",
  "note",
  "parentId",
  "plannedEffortMinutes",
  "processId",
  "productId",
  "progressBasisPoints",
  "prorationWeightBp",
  "seq",
  "sortOrder",
] as const;

function parseTask(value: unknown, label: string): ProjectTask {
  const record = plainRecord(value, label);
  exactKeys(record, TASK_KEYS, label);
  return {
    id: requiredString(record, "id", label),
    parentId: nullableString(record.parentId, label),
    sortOrder: requiredNumber(record, "sortOrder", label),
    seq: requiredNumber(record, "seq", label),
    name: requiredString(record, "name", label),
    processId: nullableString(record.processId, label),
    productId: nullableString(record.productId, label),
    note: requiredString(record, "note", label),
    contract: requiredString(record, "contract", label),
    assigneeMemberId: nullableString(record.assigneeMemberId, label),
    plannedEffortMinutes: requiredNumber(record, "plannedEffortMinutes", label),
    progressBasisPoints: requiredNumber(record, "progressBasisPoints", label),
    actualEffortMinutes: requiredNumber(record, "actualEffortMinutes", label),
    prorationWeightBp: nullableNumber(record.prorationWeightBp, label),
    dailyPlan: numberRecord(record.dailyPlan, label),
    datedActuals: numberRecord(record.datedActuals, label),
    actualStart: nullableString(record.actualStart, label),
    actualFinish: nullableString(record.actualFinish, label),
    dependencies: parseArray(record.dependencies, `${label} dependencies`, parseDependency),
  };
}

function parseDependency(value: unknown, label: string): ProjectDependency {
  const record = plainRecord(value, label);
  exactKeys(record, ["lagWorkingDays", "predecessorId", "type"], label);
  return {
    predecessorId: requiredString(record, "predecessorId", label),
    type: dependencyType(record.type, label),
    lagWorkingDays: requiredNumber(record, "lagWorkingDays", label),
  };
}

const DEPENDENCY_TYPES: readonly DependencyType[] = ["FF", "FS", "SF", "SS"];

function dependencyType(value: unknown, label: string): DependencyType {
  if (typeof value !== "string" || !(DEPENDENCY_TYPES as readonly string[]).includes(value)) {
    throw new WbsSnapshotCorruptError(label);
  }
  return value as DependencyType;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WbsSnapshotCorruptError(label);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new WbsSnapshotCorruptError(label);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) throw new WbsSnapshotCorruptError(`${label} keys`);
  const expected = new Set(keys);
  for (const key of actual) {
    if (!expected.has(key)) throw new WbsSnapshotCorruptError(`${label} keys`);
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new WbsSnapshotCorruptError(`${label} ${key}`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WbsSnapshotCorruptError(`${label} ${key}`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new WbsSnapshotCorruptError(label);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WbsSnapshotCorruptError(label);
  return value;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new WbsSnapshotCorruptError(label);
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw new WbsSnapshotCorruptError(label);
    return entry;
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new WbsSnapshotCorruptError(label);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new WbsSnapshotCorruptError(label);
    return entry;
  });
}

function numberRecord(value: unknown, label: string): Record<string, number> {
  const record = plainRecord(value, label);
  const next: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw new WbsSnapshotCorruptError(label);
    next[key] = entry;
  }
  return next;
}

function parseArray<T>(value: unknown, label: string, parse: (entry: unknown, entryLabel: string) => T): T[] {
  if (!Array.isArray(value)) throw new WbsSnapshotCorruptError(label);
  return value.map((entry, index) => parse(entry, `${label}[${index}]`));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pushThrough(bytes, new CompressionStream("gzip"));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await pushThrough(bytes, new DecompressionStream("gzip"));
  } catch (error) {
    if (error instanceof WbsSnapshotCorruptError) throw error;
    throw new WbsSnapshotCorruptError(error instanceof Error ? error.message : "gzip");
  }
}

async function pushThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const pump = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      chunks.push(next.value);
    }
  })();
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  try {
    await writer.write(payload);
    await writer.close();
    await pump;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
    throw error;
  }
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ── When a snapshot is due ──

/** Floor of the interval. 45 columns measured about 14–34 MB per 10k revisions at this value. */
export const MIN_SNAPSHOT_INTERVAL = 100;
/** Snapshot storage budget per revision, so a wider WBS snapshots less often. */
export const SNAPSHOT_BYTES_PER_REVISION = 4096;

export interface LastSnapshot {
  readonly revision: bigint;
  /** gzip bytes stored in `body_bytes`, not `octet_length` of a TOAST value. */
  readonly bodyBytes: number;
}

/** Revisions between snapshots, given the last snapshot's gzip size. */
export type SnapshotInterval = (lastBodyBytes: number) => number;

/** max(100, ceil(lastBodyBytes / 4096)). Size decides the interval, per WBS. */
export const productionSnapshotInterval: SnapshotInterval = (lastBodyBytes) =>
  Math.max(MIN_SNAPSHOT_INTERVAL, Math.ceil(lastBodyBytes / SNAPSHOT_BYTES_PER_REVISION));

/**
 * `current` is the committed revision whose state the caller holds.
 * No previous snapshot is always due. Otherwise due when
 * `current − last.revision` has reached the interval for that snapshot's size.
 */
export function isSnapshotDue(
  current: bigint,
  last: LastSnapshot | null,
  interval: SnapshotInterval = productionSnapshotInterval,
): boolean {
  if (last === null) return true;
  return current - last.revision >= BigInt(interval(last.bodyBytes));
}

// ── Previous snapshot + the changes between = next snapshot ──

export interface RevisionChange {
  readonly revision: bigint;
  readonly change: WbsChange;
}

export type RangeVerdict =
  | { readonly ok: true; readonly from: bigint; readonly to: bigint }
  | {
      readonly ok: false;
      readonly from: bigint;
      readonly to: bigint;
      readonly reason: "gap";
      readonly missing: bigint;
    }
  | {
      readonly ok: false;
      readonly from: bigint;
      readonly to: bigint;
      readonly reason: "stale";
      readonly at: bigint;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly from: bigint;
      readonly to: bigint;
      readonly reason: "hash";
      readonly expected: Sha256Hex;
      readonly actual: Sha256Hex;
    }
  | {
      readonly ok: false;
      readonly from: bigint;
      readonly to: bigint;
      readonly reason: "corrupt";
      readonly at: bigint;
      readonly detail: string;
    };

/**
 * Pure. `changes` must be exactly revisions from+1 .. to (a hole is "gap").
 * Folds `applyWbsChange` (one call per revision). A {@link WbsChangeStaleError}
 * becomes "stale" at that revision. Any other throw becomes "corrupt" at that
 * revision. A replay that finishes with a different hash is "hash".
 */
export async function verifyWbsRange(
  from: { readonly revision: bigint; readonly state: ProjectState },
  changes: readonly RevisionChange[],
  to: { readonly revision: bigint; readonly sha256: Sha256Hex },
): Promise<RangeVerdict> {
  const bounds = { from: from.revision, to: to.revision };
  if (to.revision <= from.revision) {
    return { ok: false, ...bounds, reason: "gap", missing: from.revision + 1n };
  }
  let state = from.state;
  let expected = from.revision + 1n;
  for (const entry of changes) {
    if (entry.revision !== expected) {
      return { ok: false, ...bounds, reason: "gap", missing: expected };
    }
    try {
      state = applyWbsChange(state, entry.change);
    } catch (error) {
      if (error instanceof WbsChangeStaleError) {
        return { ok: false, ...bounds, reason: "stale", at: entry.revision, detail: error.message };
      }
      const detail = error instanceof Error ? error.message : "WBS change is corrupt";
      return { ok: false, ...bounds, reason: "corrupt", at: entry.revision, detail };
    }
    expected += 1n;
  }
  if (expected !== to.revision + 1n) {
    return { ok: false, ...bounds, reason: "gap", missing: expected };
  }
  const actual = await sha256Hex(canonicalWbsState(state));
  if (actual !== to.sha256) {
    return { ok: false, ...bounds, reason: "hash", expected: to.sha256, actual };
  }
  return { ok: true, ...bounds };
}
