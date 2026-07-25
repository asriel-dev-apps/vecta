import type { WbsGridTaskRow } from "@vecta/application";

/**
 * Cross-project ("other PJ") daily load, keyed by member and ISO date to the
 * minutes that member is already committed to on OTHER projects that day.
 *
 * This is the seam for feature #6: today the values come from
 * {@link synthesizeExternalLoad} (a deterministic client-side fixture so the
 * preview can demonstrate the overlay and the capacity-overflow alert with no
 * backend), but the shape is the eventual contract for a real cross-project
 * load read. Phase 2 replaces the synthesizer with an API call that resolves the
 * same person across projects (see `../project-docs/vecta/cross-project-load.md`,
 * in the private documentation repo — see `docs/README.md`); every consumer
 * below reads only this structure, so nothing else has to change.
 */
export type ExternalLoad = Record<string, Record<string, number>>;

/** Minimal member shape the load math needs: identity plus daily capacity. */
export interface CapacityMember {
  readonly id: string;
  readonly dailyCapacityMinutes: number;
}

/**
 * Type guard for a member whose privileged `dailyCapacityMinutes` is present.
 * The connected GENERAL read model strips capacity at the API boundary
 * (project-projection `stripSensitiveMemberFields`), so a member may arrive
 * without it; such members are simply excluded from capacity math rather than
 * assumed to have some default capacity.
 */
export function hasCapacity(member: {
  readonly id: string;
  readonly dailyCapacityMinutes?: number;
}): member is CapacityMember {
  return typeof member.dailyCapacityMinutes === "number";
}

/**
 * Deterministic synthetic "other-project" load for the preview. No `Date.now`
 * and no `Math.random`: every value is a pure function of the member index, the
 * date index, and the member's own capacity, so the same members+dates always
 * yield the same fixture (asserted in the tests).
 *
 * The shape is deliberately *light*: only ~1 in 7 members are shared with another
 * project, and each carries load on only a sparse handful of days (~1 in 50), at
 * a modest 120–240 min. The intent is a grid that is quiet most of the time and
 * only occasionally shows a bar — most of which stay within the 480-min daily
 * capacity once combined with this-project effort. Overflow is therefore the
 * exception (a few clear hotspots), not the rule, so the red alert stands out
 * against the calm baseline instead of washing the grid red. Against the full
 * demo this yields ~20 (member, date) overflows.
 */
export function synthesizeExternalLoad(
  members: readonly { readonly id: string; readonly dailyCapacityMinutes?: number }[],
  dates: readonly string[],
): ExternalLoad {
  const load: ExternalLoad = {};
  members.forEach((member, memberIndex) => {
    if (!hasCapacity(member)) return;
    // ~1 in 7 members are "shared" with another project and carry external load.
    if (memberIndex % 7 !== 2) return;
    const perDate: Record<string, number> = {};
    dates.forEach((date, dateIndex) => {
      // Deterministic sparse wave: ~1 day in 50 for a shared member.
      if ((memberIndex * 5 + dateIndex * 11) % 50 !== 0) return;
      const minutes = 120 + ((memberIndex + dateIndex) % 3) * 60; // 120..240
      perDate[date] = Math.min(minutes, member.dailyCapacityMinutes);
    });
    if (Object.keys(perDate).length > 0) load[member.id] = perDate;
  });
  return load;
}

/**
 * Aggregate this-project planned minutes per (assigned member, ISO date). A
 * member's daily figure sums the day's plan across every task they are assigned,
 * so two tasks the same person owns on the same day stack — exactly what the
 * capacity check must see. Unassigned tasks contribute nothing.
 */
export function projectLoadByMember(
  rows: readonly WbsGridTaskRow[],
): Map<string, Map<string, number>> {
  const byMember = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const memberId = row.assigneeMemberId;
    if (memberId === null) continue;
    let byDate = byMember.get(memberId);
    if (byDate === undefined) {
      byDate = new Map<string, number>();
      byMember.set(memberId, byDate);
    }
    for (const [date, minutes] of Object.entries(row.dailyPlan)) {
      if (minutes <= 0) continue;
      byDate.set(date, (byDate.get(date) ?? 0) + minutes);
    }
  }
  return byMember;
}

/** External minutes for one (member, date), or 0 when none is recorded. */
export function externalMinutesFor(
  external: ExternalLoad,
  memberId: string,
  date: string,
): number {
  return external[memberId]?.[date] ?? 0;
}

/** One member×day whose combined (this-project + other-project) load overflows. */
export interface OverloadEntry {
  readonly memberId: string;
  readonly date: string;
  readonly projectMinutes: number;
  readonly externalMinutes: number;
  readonly totalMinutes: number;
  readonly capacityMinutes: number;
  /** How far over capacity the day runs (> 0 by construction). */
  readonly overflowMinutes: number;
}

/**
 * Detect the (member, date) pairs whose **total** committed minutes —
 * this-project daily plan plus other-project external load — strictly exceed
 * that member's daily capacity. This is the "1日キャパ超過" rule (not mere
 * overlap): a day at exactly capacity is fine, one minute over is an overflow.
 *
 * Only members with a known capacity are considered; a member the GENERAL read
 * model stripped of capacity cannot be range-checked and is skipped. The result
 * is sorted by descending overflow so the worst days lead any summary.
 */
export function detectOverloads(params: {
  readonly rows: readonly WbsGridTaskRow[];
  readonly external: ExternalLoad;
  readonly members: readonly { readonly id: string; readonly dailyCapacityMinutes?: number }[];
}): OverloadEntry[] {
  const projectLoad = projectLoadByMember(params.rows);
  const entries: OverloadEntry[] = [];
  for (const member of params.members) {
    if (!hasCapacity(member)) continue;
    const capacity = member.dailyCapacityMinutes;
    // Every date the member carries load on either side is a candidate.
    const dates = new Set<string>([
      ...(projectLoad.get(member.id)?.keys() ?? []),
      ...Object.keys(params.external[member.id] ?? {}),
    ]);
    for (const date of dates) {
      const projectMinutes = projectLoad.get(member.id)?.get(date) ?? 0;
      const externalMinutes = externalMinutesFor(params.external, member.id, date);
      const totalMinutes = projectMinutes + externalMinutes;
      if (totalMinutes <= capacity) continue;
      entries.push({
        memberId: member.id,
        date,
        projectMinutes,
        externalMinutes,
        totalMinutes,
        capacityMinutes: capacity,
        overflowMinutes: totalMinutes - capacity,
      });
    }
  }
  entries.sort(
    (a, b) => b.overflowMinutes - a.overflowMinutes || a.date.localeCompare(b.date),
  );
  return entries;
}

/** Fast lookup key for "does (member, date) overflow?" used by the grid cells. */
export function overloadKey(memberId: string, date: string): string {
  return `${memberId}\u0000${date}`;
}
