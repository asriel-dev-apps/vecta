import {
  ProjectNotFoundError,
  decodeWbsSnapshot,
  encodeWbsSnapshot,
  readWbsChange,
  verifyWbsRange,
  type ProjectState,
  type RangeVerdict,
  type RevisionChange,
  type Sha256Hex,
} from "@vecta/application";
import { and, desc, eq, lte, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import { ProjectRepository } from "./project-repository.js";
import { toProjectState } from "./project-workspace.js";
import { schema, wbsSnapshot, wbsVerifiedRange } from "./schema.js";

type SnapshotExecutor =
  | NodePgDatabase<typeof schema>
  | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export interface WbsKey {
  readonly tenantId: string;
  readonly wbsId: string;
}

export class WbsSnapshotConflictError extends Error {
  constructor(
    readonly key: WbsKey,
    readonly revision: bigint,
  ) {
    super(`wbs_snapshot ${key.wbsId}@${revision} exists with a different hash`);
    this.name = "WbsSnapshotConflictError";
  }
}

/**
 * Encode and insert. A re-take of the same state returns "existed".
 * A different state at the same revision throws, so a disagreeing re-take is loud.
 */
export async function takeWbsSnapshot(
  executor: SnapshotExecutor,
  key: WbsKey,
  revision: bigint,
  state: ProjectState,
): Promise<"inserted" | "existed"> {
  const encoded = await encodeWbsSnapshot(state);
  const inserted = await executor
    .insert(wbsSnapshot)
    .values({
      tenantId: key.tenantId,
      wbsId: key.wbsId,
      revision,
      format: encoded.format,
      sha256: encoded.sha256,
      body: encoded.body,
      bodyBytes: encoded.body.byteLength,
      rawBytes: encoded.rawBytes,
    })
    .onConflictDoNothing({
      target: [wbsSnapshot.tenantId, wbsSnapshot.wbsId, wbsSnapshot.revision],
    })
    .returning({ revision: wbsSnapshot.revision });
  if (inserted.length > 0) return "inserted";

  const [row] = await executor
    .select({ sha256: wbsSnapshot.sha256 })
    .from(wbsSnapshot)
    .where(
      and(
        eq(wbsSnapshot.tenantId, key.tenantId),
        eq(wbsSnapshot.wbsId, key.wbsId),
        eq(wbsSnapshot.revision, revision),
      ),
    )
    .limit(1);
  if (row !== undefined && row.sha256 === encoded.sha256) return "existed";
  throw new WbsSnapshotConflictError(key, revision);
}

function failureText(verdict: RangeVerdict): string | null {
  if (verdict.ok) return null;
  if (verdict.reason === "gap") return `gap@${verdict.missing.toString()}`;
  if (verdict.reason === "stale") return `stale@${verdict.at.toString()}`;
  return "hash";
}

function asSha256(value: string): Sha256Hex {
  return value as Sha256Hex;
}

export class WbsSnapshotStore {
  constructor(private readonly database: SnapshotExecutor) {}

  /**
   * Cutover base. Locks the WBS, re-reads it, and stores that revision.
   * Re-running returns "existed" when the bytes still match.
   */
  async takeBase(key: WbsKey): Promise<{ readonly revision: bigint; readonly result: "inserted" | "existed" }> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.execute<{ revision: string }>(sql`
        select revision::text as revision
        from wbs
        where tenant_id = ${key.tenantId} and id = ${key.wbsId}
        for update
      `);
      const row = locked.rows[0];
      if (row === undefined) throw new ProjectNotFoundError(key.wbsId);
      const record = await new ProjectRepository(transaction).load(key.tenantId, key.wbsId);
      if (record === null) throw new ProjectNotFoundError(key.wbsId);
      const revision = BigInt(row.revision);
      const result = await takeWbsSnapshot(transaction, key, revision, toProjectState(record));
      return { revision, result };
    });
  }

  /** Newest snapshot at or before `revision`, decoded and hash-checked. */
  async latestAtOrBefore(
    key: WbsKey,
    revision: bigint,
  ): Promise<{ readonly revision: bigint; readonly state: ProjectState } | null> {
    const [row] = await this.database
      .select({
        revision: wbsSnapshot.revision,
        format: wbsSnapshot.format,
        sha256: wbsSnapshot.sha256,
        body: wbsSnapshot.body,
      })
      .from(wbsSnapshot)
      .where(
        and(
          eq(wbsSnapshot.tenantId, key.tenantId),
          eq(wbsSnapshot.wbsId, key.wbsId),
          lte(wbsSnapshot.revision, revision),
        ),
      )
      .orderBy(desc(wbsSnapshot.revision))
      .limit(1);
    if (row === undefined) return null;
    const state = await decodeWbsSnapshot({
      format: row.format,
      sha256: row.sha256,
      body: row.body,
    });
    return { revision: row.revision, state };
  }

  /**
   * Oldest consecutive snapshot pair that has no verdict yet.
   * Decodes the earlier snapshot, replays `wbs_change` through `readWbsChange`,
   * and inserts the verdict. Null when every pair is already verified.
   */
  async verifyNext(key: WbsKey): Promise<RangeVerdict | null> {
    return this.database.transaction(async (transaction) => {
      const found = await transaction.execute<{
        from_revision: string;
        from_format: number;
        from_sha256: string;
        from_body: Buffer;
        to_revision: string;
        to_sha256: string;
      }>(sql`
        select a.revision::text as from_revision,
               a.format as from_format,
               a.sha256 as from_sha256,
               a.body as from_body,
               b.revision::text as to_revision,
               b.sha256 as to_sha256
        from wbs_snapshot a
        join lateral (
          select revision, sha256
          from wbs_snapshot
          where tenant_id = a.tenant_id
            and wbs_id = a.wbs_id
            and revision > a.revision
          order by revision asc
          limit 1
        ) b on true
        where a.tenant_id = ${key.tenantId}
          and a.wbs_id = ${key.wbsId}
          and not exists (
            select 1
            from wbs_verified_range v
            where v.tenant_id = a.tenant_id
              and v.wbs_id = a.wbs_id
              and v.from_revision = a.revision
              and v.to_revision = b.revision
          )
        order by a.revision asc
        limit 1
      `);
      const pair = found.rows[0];
      if (pair === undefined) return null;

      const fromRevision = BigInt(pair.from_revision);
      const toRevision = BigInt(pair.to_revision);
      const state = await decodeWbsSnapshot({
        format: Number(pair.from_format),
        sha256: pair.from_sha256,
        body: pair.from_body,
      });
      const stored = await transaction.execute<{ revision: string; change: unknown }>(sql`
        select revision::text as revision, change
        from wbs_change
        where tenant_id = ${key.tenantId}
          and wbs_id = ${key.wbsId}
          and revision > ${fromRevision}
          and revision <= ${toRevision}
        order by revision asc
      `);
      const changes: RevisionChange[] = stored.rows.map((row) => ({
        revision: BigInt(row.revision),
        change: readWbsChange(row.change),
      }));
      const verdict = await verifyWbsRange(
        { revision: fromRevision, state },
        changes,
        { revision: toRevision, sha256: asSha256(pair.to_sha256) },
      );
      await transaction
        .insert(wbsVerifiedRange)
        .values({
          tenantId: key.tenantId,
          wbsId: key.wbsId,
          fromRevision,
          toRevision,
          failure: failureText(verdict),
        })
        .onConflictDoNothing();
      return verdict;
    });
  }
}
