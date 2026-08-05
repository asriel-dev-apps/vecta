/**
 * Dated actuals — the actuals side's time axis (Design 0011 §3).
 *
 * Stored per task as a sparse map, exactly like `dailyPlan`, because the write
 * path forced it: `project-command-unit-of-work.ts` re-writes every task row on
 * EVERY command, including `actualEffortMinutes` taken from `ProjectState`. So
 * the total has to live in the state, so the rows it is derived from have to live
 * in the state too — otherwise the next unrelated cell edit writes a stale total
 * back and quietly undoes an import.
 *
 * The key is `"<ISO date>|<member id>"`. `|` is safe as a separator because a
 * date is `YYYY-MM-DD` and a member id is a UUID; neither can contain it. Every
 * encode and decode goes through this module so that fact is asserted in one
 * place rather than assumed in several.
 */

/** `"YYYY-MM-DD|<memberId>"` → person-minutes. */
export type DatedActuals = Readonly<Record<string, number>>;

/**
 * One imported line, resolved to internal ids — the wire shape of an
 * `actuals.import` command and of the importer's output. Defined here, in the
 * module with no project-state dependency, so the command union and the CSV
 * importer can both name it without importing each other.
 */
export interface DatedActualEntry {
  readonly taskId: string;
  /** ISO `YYYY-MM-DD`. */
  readonly workDate: string;
  readonly memberId: string;
  /** Person-minutes. */
  readonly actualMinutes: number;
}

const SEPARATOR = "|";

export function datedActualKey(workDate: string, memberId: string): string {
  return `${workDate}${SEPARATOR}${memberId}`;
}

export interface DatedActualKeyParts {
  readonly workDate: string;
  readonly memberId: string;
}

/** Decode a key, or `null` if it is not one. Total, so bad stored data cannot throw. */
export function parseDatedActualKey(key: string): DatedActualKeyParts | null {
  const separator = key.indexOf(SEPARATOR);
  if (separator <= 0 || separator === key.length - 1) return null;
  return { workDate: key.slice(0, separator), memberId: key.slice(separator + 1) };
}

/** Σ over every entry — the value column W must equal for a task that has any. */
export function datedActualTotalMinutes(actuals: DatedActuals): number {
  let total = 0;
  for (const minutes of Object.values(actuals)) total += minutes;
  return total;
}

/**
 * Collapse the per-member detail to `date → minutes`, which is all the EVM
 * calculation needs: AC(t) sums by date, and the per-member dashboard segment
 * attributes a leaf by its ASSIGNEE, not by who logged the time. Keeping the
 * detail in storage and dropping it here is deliberate — the assignee-based
 * segment is existing behaviour and this feature does not redefine it.
 */
export function datedActualsByDate(actuals: DatedActuals): Record<string, number> {
  const byDate: Record<string, number> = {};
  for (const [key, minutes] of Object.entries(actuals)) {
    const parts = parseDatedActualKey(key);
    if (parts === null) continue;
    byDate[parts.workDate] = (byDate[parts.workDate] ?? 0) + minutes;
  }
  return byDate;
}

/**
 * Replace whole `(date, member)` partitions.
 *
 * The import's unit of change is "one person's one day" (Design 0011 §5.1), and
 * the reason is that anything smaller cannot express a REMOVAL: a corrected file
 * that drops a task from someone's Tuesday must delete that row, and an upsert of
 * only the rows present leaves it behind forever. Anything larger — replacing a
 * whole date — would delete another person's rows just because they were not in
 * this file.
 *
 * Idempotent by construction: replacing the same partitions with the same entries
 * yields the same map, so importing a file twice has the effect of importing it
 * once.
 */
export function replaceDatedActualPartitions(
  current: DatedActuals,
  partitions: readonly DatedActualKeyParts[],
  entries: readonly DatedActualEntry[],
): DatedActuals {
  const cleared = new Set(partitions.map((part) => datedActualKey(part.workDate, part.memberId)));
  const next: Record<string, number> = {};
  for (const [key, minutes] of Object.entries(current)) {
    const parts = parseDatedActualKey(key);
    // An undecodable key is left alone rather than dropped: this function's job
    // is the partitions it was given, and silently discarding data it cannot read
    // would turn a parsing bug into data loss.
    if (parts !== null && cleared.has(datedActualKey(parts.workDate, parts.memberId))) continue;
    next[key] = minutes;
  }
  for (const entry of entries) {
    // Assignment, not `+=`. `entries` are one task's rows, and a repeated
    // `(date, member)` within one task is a duplicate the importer has already
    // rejected (Design 0011 §5.2) — summing here would give that rejection a
    // silent second path where the two rows quietly merge instead.
    next[datedActualKey(entry.workDate, entry.memberId)] = entry.actualMinutes;
  }
  return next;
}
