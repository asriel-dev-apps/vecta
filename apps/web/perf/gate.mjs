// Pure pass/fail logic of the perf gate (design 0016 §5 #1). Unit-tested in
// `pnpm check`; measure.mjs only collects numbers and calls evaluate().
//
// The gate is MAIN-THREAD WORK TIME per scroll step, not frame intervals: the
// interval between rAF callbacks measures vsync scheduling and machine load (an
// empty scroller driven the same way showed p95 100-117 ms under load), the
// work time does not. An empty-scroller control lane is measured the same way
// and must pass the same gate, otherwise the measurement itself is invalid.

export const WORK_GATE = { p95AtMostMs: 16, maxBelowMs: 50 };
export const SCENARIOS = {
  V45c: { kind: "V45c", cols: 45 },
  V45: { kind: "V", cols: 45 },
  H45: { kind: "H", cols: 45 },
  V500: { kind: "V", cols: 500 },
  H500: { kind: "H", cols: 500 },
  D500: { kind: "D", cols: 500 },
};

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile95(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Per-step work times (ms) of one run -> { p95, max, mean, steps }. */
export function workStats(stepMs) {
  return {
    p95: percentile95(stepMs),
    max: Math.max(...stepMs),
    mean: stepMs.reduce((sum, value) => sum + value, 0) / stepMs.length,
    steps: stepMs.length,
  };
}

/** The one tolerance rule: head <= max(baseline x 1.10, baseline + 20 ms). */
export function withinTolerance(baseline, head) {
  return head <= Math.max(baseline * 1.1, baseline + 20);
}

export function sameMachine(left, right) {
  return left?.os === right?.os && left?.cpu === right?.cpu && left?.chrome === right?.chrome;
}

/** runs: one {p95, max} per run. p95 = median over runs; max = maximum over all runs. */
export function workGate(runs) {
  const failures = [];
  const p95 = median(runs.map((run) => run.p95));
  const max = Math.max(...runs.map((run) => run.max));
  if (!(p95 <= WORK_GATE.p95AtMostMs)) failures.push(`work p95 ${p95.toFixed(1)} ms > ${WORK_GATE.p95AtMostMs} ms`);
  if (!(max < WORK_GATE.maxBelowMs)) failures.push(`work max ${max.toFixed(1)} ms >= ${WORK_GATE.maxBelowMs} ms`);
  return { pass: failures.length === 0, failures, summary: { p95, max } };
}

/**
 * doc: { machine, scenarios: {id: {work[], control[], correctness: string[]}},
 *        load: {cols: {firstRowMs[], editMs[], editFailures[]}} }
 * baseline: a doc from the same script, or null (then only absolute gates apply).
 */
export function evaluate(doc, baseline) {
  const failures = [];
  if (baseline !== null && baseline !== undefined && !sameMachine(doc.machine, baseline.machine)) {
    return { ok: false, failures: ["baseline was recorded on a different machine/browser: refusing to compare"] };
  }
  for (const [id, scenario] of Object.entries(doc.scenarios)) {
    for (const message of scenario.correctness) failures.push(`${id}: correctness: ${message}`);
    for (const message of workGate(scenario.work).failures) failures.push(`${id}: ${message}`);
    for (const message of workGate(scenario.control).failures) {
      failures.push(`${id}: CONTROL lane (empty scroller) ${message}: the measurement is invalid`);
    }
  }
  for (const [cols, load] of Object.entries(doc.load)) {
    for (const message of load.editFailures) failures.push(`edit@${cols}: ${message}`);
    if (baseline === null || baseline === undefined) continue;
    const before = baseline.load?.[cols];
    if (before === undefined) {
      failures.push(`baseline has no ${cols}-column load numbers`);
      continue;
    }
    for (const metric of ["firstRowMs", "editMs"]) {
      const was = median(before[metric]);
      const now = median(load[metric]);
      if (!withinTolerance(was, now)) failures.push(`${metric}@${cols}: ${now} > max(${was} x 1.10, ${was} + 20)`);
    }
  }
  return { ok: failures.length === 0, failures };
}
