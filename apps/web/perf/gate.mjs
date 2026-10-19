// Pure pass/fail logic of the perf gate (design 0016 §5 #1). Unit-tested in
// `pnpm check`; measure.mjs only collects numbers and calls evaluate().
//
// The gate is MAIN-THREAD WORK TIME per scroll step, not frame intervals (those
// track vsync and machine load). Lane definitions, tiers and expected
// displacements live HERE, keyed by lane id: a document can never pick its own
// gate or its own expected movement. A control lane (an empty scroller driven by
// the same wheel input) must pass the same gate, otherwise the measurement is
// invalid.

export const NOTCHES = 60;
export const START_ROW = 2000;
export const START_LEFT = 1728;
/** Harness choice (not in the design): rounding slack between expected and observed scroll offsets. */
export const MOVE_TOLERANCE_PX = 1;
export const GATES = {
  primary: { p95AtMostMs: 16, maxBelowMs: 50 },
  secondary: { p95AtMostMs: 33, maxBelowMs: 100 },
};
export const LANES = {
  W45: { tier: "primary", cols: 45, wheel: { dx: 0, dy: 100 } },
  W500: { tier: "primary", cols: 500, wheel: { dx: 0, dy: 100 } },
  WH500: { tier: "primary", cols: 500, wheel: { dx: 100, dy: 0 } },
  WF500: { tier: "primary", cols: 500, wheel: { dx: 0, dy: 300 } },
  V45c: { tier: "secondary", cols: 45, kind: "V45c" },
  V45: { tier: "secondary", cols: 45, kind: "V" },
  H45: { tier: "secondary", cols: 45, kind: "H" },
  V500: { tier: "secondary", cols: 500, kind: "V" },
  H500: { tier: "secondary", cols: 500, kind: "H" },
  D500: { tier: "secondary", cols: 500, kind: "D" },
};
export const LOAD_COLS = [45, 500];

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

/** runs: one {p95, max} per run. p95 = median over runs; max = maximum over all runs. */
export function workGate(runs, gate = GATES.primary) {
  const failures = [];
  const p95 = median(runs.map((run) => run.p95));
  const max = Math.max(...runs.map((run) => run.max));
  if (runs.length === 0) failures.push("no runs");
  else {
    if (!(p95 <= gate.p95AtMostMs)) failures.push(`work p95 ${p95.toFixed(1)} ms > ${gate.p95AtMostMs} ms`);
    if (!(max < gate.maxBelowMs)) failures.push(`work max ${max.toFixed(1)} ms >= ${gate.maxBelowMs} ms`);
  }
  return { pass: failures.length === 0, failures, summary: { p95, max } };
}

/** Movement evidence of a wheel run (work or control) against the lane's constants. */
function movementFailures(lane, runs) {
  const expectedTop = NOTCHES * lane.wheel.dy;
  const expectedLeft = NOTCHES * lane.wheel.dx;
  const out = new Set();
  for (const run of runs) {
    if (run.start === undefined || run.end === undefined || run.wheelEvents === undefined) {
      out.add("no movement evidence (start/end offsets, wheel events)");
      continue;
    }
    const top = run.end.top - run.start.top;
    const left = run.end.left - run.start.left;
    if (!(Math.abs(top - expectedTop) <= MOVE_TOLERANCE_PX)) out.add(`scrolled ${top} px vertically, expected ${expectedTop}`);
    if (!(Math.abs(left - expectedLeft) <= MOVE_TOLERANCE_PX)) out.add(`scrolled ${left} px horizontally, expected ${expectedLeft}`);
    if (run.wheelEvents !== NOTCHES) out.add(`received ${run.wheelEvents} wheel events, expected ${NOTCHES}`);
    if (run.steps !== NOTCHES) out.add(`measured ${run.steps} steps, expected ${NOTCHES}`);
  }
  return [...out];
}

/** [message, isTiming]: timing messages are not reported when the machine load makes the run invalid. */
function laneFailures(id, scenario) {
  const lane = LANES[id];
  if (lane === undefined) return [[`${id}: unknown lane`, false]];
  const out = [];
  const gate = GATES[lane.tier];
  const work = scenario.work ?? [];
  const control = scenario.control ?? [];
  for (const message of scenario.correctness ?? ["no correctness evidence"]) out.push([`${id}: correctness: ${message}`, false]);
  for (const message of workGate(work, gate).failures) out.push([`${id}: ${message}`, true]);
  for (const message of workGate(control, gate).failures) {
    out.push([`${id}: CONTROL lane (empty scroller) ${message}: the measurement is invalid`, true]);
  }
  if (lane.wheel !== undefined) {
    for (const message of movementFailures(lane, work)) out.push([`${id}: correctness: ${message}`, false]);
    for (const message of movementFailures(lane, control)) out.push([`${id}: CONTROL lane: ${message}: the measurement is invalid`, false]);
  }
  return out;
}

const finite = (values) => Array.isArray(values) && values.length > 0 && values.every((value) => Number.isFinite(value));

function loadFailures(side, load, runs) {
  const out = [];
  for (const cols of LOAD_COLS) {
    const entry = load?.[cols];
    if (entry === undefined) {
      out.push(`${side}load@${cols}: missing`);
      continue;
    }
    for (const message of entry.editFailures ?? ["no edit evidence"]) out.push(`${side}edit@${cols}: ${message}`);
    for (const metric of ["firstRowMs", "editMs"]) {
      if (!finite(entry[metric])) out.push(`${side}${metric}@${cols}: missing or non-numeric measurement`);
      else if (runs !== undefined && entry[metric].length < runs) out.push(`${side}${metric}@${cols}: ${entry[metric].length} samples, expected ${runs}`);
    }
  }
  return out;
}

/** Every timed run (lane runs, load probes of both sides) needs finite 1-minute load readings and no loadInvalid flag. */
function loadInvalid(doc) {
  const records = [];
  for (const scenario of Object.values(doc.scenarios ?? {})) {
    for (const run of [...(scenario.work ?? []), ...(scenario.control ?? [])]) records.push({ ...run.loadavg, loadInvalid: run.loadInvalid });
  }
  for (const load of [doc.load, doc.before?.load]) for (const entry of Object.values(load ?? {})) records.push(...(entry.loads ?? [{}]));
  return records.length === 0 || records.some((r) => r.loadInvalid === true || !Number.isFinite(r.before) || !Number.isFinite(r.after));
}

/**
 * doc: { runs, builds: {before, candidate}, order: ("B"|"C")[],
 *        scenarios: {id: {work[], control[], correctness: string[]}},
 *        load: {cols: {firstRowMs[], editMs[], editFailures[]}},
 *        before: { load } }   (before measured in the same session, interleaved)
 * Result: {ok, diagnostic, invalid, failures}. invalid = a qualifying run was not measured on a quiet
 * machine (flagged loadInvalid, or load readings missing): timing messages are then withheld and the
 * verdict is neither pass nor timing FAIL; correctness failures still fail.
 * opts.diagnostic: a partial run (--only / --no-before): absent lanes, load
 *   metrics and before are not failures, and the result is labelled diagnostic.
 */
export function evaluate(doc, opts = {}) {
  const diagnostic = opts.diagnostic === true;
  const all = []; // [message, isTiming]
  const add = (messages, timing = false) => all.push(...messages.map((message) => [message, timing]));
  const scenarios = doc.scenarios ?? {};
  if (!diagnostic) add(Object.keys(LANES).filter((id) => scenarios[id] === undefined).map((id) => `${id}: lane missing`));
  for (const [id, scenario] of Object.entries(scenarios)) all.push(...laneFailures(id, scenario));
  if (!diagnostic || doc.load !== undefined) add(loadFailures("", doc.load, diagnostic ? undefined : doc.runs));

  if (doc.before === undefined) {
    if (!diagnostic) add(["no before measurement"]);
  } else {
    const { before: was, candidate: now } = doc.builds ?? {};
    if (was === undefined || now === undefined || was === now) add(["before and candidate are the same build (or their identity is missing)"]);
    const order = doc.order ?? [];
    if (order.length === 0 || order.some((side, index) => side !== (index % 2 === 0 ? "B" : "C"))) add(["probes were not interleaved B,C,B,C,..."]);
    add(loadFailures("before ", doc.before.load, doc.runs));
    for (const cols of LOAD_COLS) {
      for (const metric of ["firstRowMs", "editMs"]) {
        const head = median(doc.load?.[cols]?.[metric] ?? []);
        const base = median(doc.before.load?.[cols]?.[metric] ?? []);
        if (!withinTolerance(base, head)) add([`${metric}@${cols}: ${head} > max(${base} x 1.10, ${base} + 20)`], true);
      }
    }
  }
  const invalid = !diagnostic && loadInvalid(doc);
  const failures = all.filter(([, timing]) => !(invalid && timing)).map(([message]) => message);
  return { ok: failures.length === 0 && !invalid, diagnostic, invalid, failures };
}
