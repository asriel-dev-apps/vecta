// Pure pass/fail logic of the perf gate (design 0016 §5 #1). Unit-tested in
// `pnpm check`; measure.mjs only collects numbers and calls evaluate().

export const FRAME_GATE = { maxFramesOver50: 20, maxP95Ms: 33, worstFrameBelowMs: 100 };
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

/** The one tolerance rule: head <= max(baseline x 1.10, baseline + 20 ms). */
export function withinTolerance(baseline, head) {
  return head <= Math.max(baseline * 1.1, baseline + 20);
}

export function sameMachine(left, right) {
  return left?.os === right?.os && left?.cpu === right?.cpu && left?.chrome === right?.chrome;
}

/** sweeps: one {framesOver50, p95FrameMs, worstFrameMs} per run. Worst frame = max over runs. */
export function frameGate(sweeps) {
  const failures = [];
  const over = median(sweeps.map((run) => run.framesOver50));
  const p95 = median(sweeps.map((run) => run.p95FrameMs));
  const worst = Math.max(...sweeps.map((run) => run.worstFrameMs));
  if (!(over <= FRAME_GATE.maxFramesOver50)) failures.push(`frames>50ms median ${over} > ${FRAME_GATE.maxFramesOver50}`);
  if (!(p95 <= FRAME_GATE.maxP95Ms)) failures.push(`p95 median ${p95} > ${FRAME_GATE.maxP95Ms} ms`);
  if (!(worst < FRAME_GATE.worstFrameBelowMs)) failures.push(`worst frame ${worst} >= ${FRAME_GATE.worstFrameBelowMs} ms`);
  return { pass: failures.length === 0, failures, summary: { over, p95, worst } };
}

/**
 * doc: { machine, scenarios: {id: {sweeps[], correctness: string[]}}, load: {cols: {firstRowMs[], editMs[], editFailures[]}} }
 * baseline: a doc from the same script, or null (then only absolute gates apply).
 */
export function evaluate(doc, baseline) {
  const failures = [];
  if (baseline !== null && baseline !== undefined && !sameMachine(doc.machine, baseline.machine)) {
    return { ok: false, failures: ["baseline was recorded on a different machine/browser: refusing to compare"] };
  }
  for (const [id, scenario] of Object.entries(doc.scenarios)) {
    for (const message of scenario.correctness) failures.push(`${id}: correctness: ${message}`);
    for (const message of frameGate(scenario.sweeps).failures) failures.push(`${id}: ${message}`);
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
