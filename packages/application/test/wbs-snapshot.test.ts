import { describe, expect, it } from "vitest";
import fixture from "./fixtures/wbs-snapshot-format-1.json" with { type: "json" };
import {
  canonicalWbsState,
  decodeWbsSnapshot,
  diffOperation,
  encodeWbsSnapshot,
  hashWbsState,
  isSnapshotDue,
  sha256Hex,
  productionSnapshotInterval,
  verifyWbsRange,
  WbsSnapshotCorruptError,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
  type RevisionChange,
  type Sha256Hex,
  type WbsChange,
} from "../src/index.js";

const task = (overrides: Partial<ProjectTask> & Pick<ProjectTask, "id">): ProjectTask => ({
  parentId: null,
  sortOrder: 0,
  seq: 1,
  name: "Task",
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
  dependencies: [],
  ...overrides,
});

/** 2 parents (p1, p2), 3 leaves (a, b under p1; c under p2), listed in canonical id order, one dependency, a rate, a holiday, a template. */
const STATE: ProjectState = {
  id: "w1",
  name: "Snapshot WBS",
  projectStart: "2026-01-05",
  statusDate: "2026-01-07",
  currency: "JPY",
  defaultCalendarId: "std",
  calendars: [{ id: "std", name: "Std", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: ["2026-01-12"] }],
  members: [{ id: "m1", name: "Member One", calendarId: "std", dailyCapacityMinutes: 480, costRateMinorPerHour: 4500 }],
  processes: [{ id: "pr1", name: "Design", sortOrder: 0 }],
  products: [{ id: "pd1", name: "Core", sortOrder: 0 }],
  templates: [
    {
      id: "tpl",
      name: "Two steps",
      sortOrder: 0,
      subtasks: [
        { name: "First", weightBp: 6000 },
        { name: "Second", weightBp: 4000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
      ],
    },
  ],
  tasks: [
    task({
      id: "a",
      parentId: "p1",
      seq: 2,
      sortOrder: 0,
      name: "Leaf A",
      processId: "pr1",
      productId: "pd1",
      assigneeMemberId: "m1",
      plannedEffortMinutes: 480,
      progressBasisPoints: 5000,
      actualEffortMinutes: 240,
      dailyPlan: { "2026-01-05": 240, "2026-01-06": 120, "2026-01-07": 120 },
      datedActuals: { "2026-01-05|m1": 240 },
      actualStart: "2026-01-05",
    }),
    task({
      id: "b",
      parentId: "p1",
      seq: 3,
      sortOrder: 1,
      name: "Leaf B",
      plannedEffortMinutes: 480,
      dailyPlan: { "2026-01-08": 0.5 },
      dependencies: [{ predecessorId: "a", type: "FS", lagWorkingDays: 0 }],
    }),
    task({ id: "c", parentId: "p2", seq: 5, sortOrder: 0, name: "Leaf C", plannedEffortMinutes: 100, note: "n" }),
    task({ id: "p1", seq: 1, sortOrder: 0, name: "Parent One", plannedEffortMinutes: 960 }),
    task({ id: "p2", seq: 4, sortOrder: 1, name: "Parent Two", plannedEffortMinutes: 100 }),
  ],
  nextTaskSeq: 6,
  nextBaselineVersion: 1,
};


const STATE_SHA256 = "70b49e30eef5dbbe19287c16d6a17730f02514577854d90364e959dc2b698e91";

describe("encode / decode round trip", () => {
  it("decodes to the identical state and canonical text, with the literal hash", async () => {
    const encoded = await encodeWbsSnapshot(STATE);
    const decoded = await decodeWbsSnapshot({ format: encoded.format, sha256: encoded.sha256, body: encoded.body });

    expect(encoded.format).toBe(1);
    expect(encoded.sha256).toBe(STATE_SHA256);
    expect(await hashWbsState(STATE)).toBe(STATE_SHA256);
    expect(decoded).toEqual(STATE);
    expect(canonicalWbsState(decoded)).toBe(canonicalWbsState(STATE));
    expect(encoded.rawBytes).toBe(new TextEncoder().encode(canonicalWbsState(STATE)).byteLength);
  });

  it("the cell 0.5 and the dated actual survive as literals", async () => {
    const encoded = await encodeWbsSnapshot(STATE);
    const decoded = await decodeWbsSnapshot(encoded);
    expect(decoded.tasks.find((t) => t.id === "b")?.dailyPlan).toEqual({ "2026-01-08": 0.5 });
    expect(decoded.tasks.find((t) => t.id === "a")?.datedActuals).toEqual({ "2026-01-05|m1": 240 });
    expect(decoded.tasks.find((t) => t.id === "a")?.actualStart).toBe("2026-01-05");
  });
});

describe("format 1 fixture (checked in, must keep decoding)", () => {
  it("decodes to the literal state with the literal hash", async () => {
    expect(fixture.format).toBe(1);
    expect(fixture.sha256).toBe(STATE_SHA256);
    const decoded = await decodeWbsSnapshot({
      format: fixture.format,
      sha256: fixture.sha256,
      body: Uint8Array.from(atob(fixture.bodyBase64), (char) => char.charCodeAt(0)),
    });
    expect(decoded).toEqual(STATE);
    expect(await hashWbsState(decoded)).toBe(STATE_SHA256);
  });
});

describe("corruption", () => {
  const stored = async () => {
    const encoded = await encodeWbsSnapshot(STATE);
    return { format: 1, sha256: encoded.sha256 as string, body: encoded.body };
  };

  it("one flipped byte in the gzip body is a WbsSnapshotCorruptError", async () => {
    const good = await stored();
    const body = new Uint8Array(good.body);
    body[body.length - 6] = body[body.length - 6]! ^ 0xff; // crc32 trailer
    const error = await decodeWbsSnapshot({ ...good, body }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WbsSnapshotCorruptError);
    // The gunzip stream's own message is runtime text (empty on this Node); what matters is that it
    // failed at gunzip, before the hash check, which would say "sha256".
    expect((error as Error).message).not.toBe("sha256");
  });

  it("a correct body with a different sha256 is a WbsSnapshotCorruptError", async () => {
    const good = await stored();
    const error = await decodeWbsSnapshot({ ...good, sha256: "0".repeat(64) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WbsSnapshotCorruptError);
    expect((error as Error).message).toBe("sha256");
  });

  it("a column format that is not the body's canonical version names the format", async () => {
    const good = await stored();
    const error = await decodeWbsSnapshot({ ...good, format: 99 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WbsSnapshotCorruptError);
    expect((error as Error).message).toBe("format");
  });

  it("a body of format 99 (hash and column agree) is refused as unsupported format 99", async () => {
    const text = JSON.stringify({ canonical: 99 });
    const sha256 = await sha256Hex(text);
    const body = new Uint8Array(
      await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
    );
    const error = await decodeWbsSnapshot({ format: 99, sha256, body }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WbsSnapshotCorruptError);
    expect((error as Error).message).toBe("unsupported format 99");
  });
});

describe("snapshot interval", () => {
  it("productionSnapshotInterval is max(100, ceil(bytes / 4096))", () => {
    expect(productionSnapshotInterval(0)).toBe(100);
    expect(productionSnapshotInterval(409_600)).toBe(100);
    expect(productionSnapshotInterval(409_601)).toBe(101);
    expect(productionSnapshotInterval(906_282)).toBe(222);
  });

  it("isSnapshotDue: no previous snapshot is due; due exactly at the interval", () => {
    expect(isSnapshotDue(5n, null)).toBe(true);
    expect(isSnapshotDue(100n, { revision: 0n, bodyBytes: 1000 })).toBe(true);
    expect(isSnapshotDue(99n, { revision: 0n, bodyBytes: 1000 })).toBe(false);
  });
});

describe("verifyWbsRange", () => {
  const renames: ProjectCommand[][] = [
    [{ type: "task.update", taskId: "a", changes: { name: "A1" } }],
    [{ type: "task.update", taskId: "b", changes: { name: "B1" } }],
    [{ type: "task.update", taskId: "c", changes: { name: "C1", note: "m" } }],
  ];
  const run = async () => {
    let state: ProjectState = STATE;
    const changes: RevisionChange[] = [];
    for (const [index, commands] of renames.entries()) {
      const diffed = diffOperation(state, commands);
      state = diffed.after;
      changes.push({ revision: BigInt(index + 2), change: diffed.change });
    }
    return { changes, to: { revision: 4n, sha256: (await hashWbsState(state)) as Sha256Hex } };
  };
  const from = { revision: 1n, state: STATE };

  it("complete range is ok", async () => {
    const { changes, to } = await run();
    expect(changes.map((c) => c.change.changes.length)).toEqual([1, 1, 2]);
    expect(await verifyWbsRange(from, changes, to)).toEqual({ ok: true, from: 1n, to: 4n });
  });

  it("the changes of revision 2 missing is a gap at 2", async () => {
    const { changes, to } = await run();
    expect(await verifyWbsRange(from, changes.slice(1), to)).toEqual({
      ok: false,
      from: 1n,
      to: 4n,
      reason: "gap",
      missing: 2n,
    });
  });

  it("a change whose before is altered is stale at that revision", async () => {
    const { changes, to } = await run();
    const [first, second, third] = changes as [RevisionChange, RevisionChange, RevisionChange];
    const altered: WbsChange = {
      ...second.change,
      changes: second.change.changes.map((entry) => ({ ...entry, before: "not the old name" })),
    };
    expect(await verifyWbsRange(from, [first, { revision: 3n, change: altered }, third], to)).toEqual({
      ok: false,
      from: 1n,
      to: 4n,
      reason: "stale",
      at: 3n,
      detail: 'WBS change is stale for task:b field "name"',
    });
  });

  it("a dropped FieldChange (hash taken from the true final state) is a hash failure", async () => {
    const { changes, to } = await run();
    const [first, second, third] = changes as [RevisionChange, RevisionChange, RevisionChange];
    const dropped: WbsChange = {
      ...third.change,
      changes: third.change.changes.filter((entry) => entry.field !== "name"),
    };
    const verdict = await verifyWbsRange(from, [first, second, { revision: 4n, change: dropped }], to);
    expect(verdict).toMatchObject({ ok: false, from: 1n, to: 4n, reason: "hash", expected: to.sha256 });
    expect((verdict as { actual: string }).actual).not.toBe(to.sha256);
  });
});
