export interface WorkSample {
  p95: number;
  max: number;
  steps?: number;
  start?: { top: number; left: number };
  end?: { top: number; left: number };
  wheelEvents?: number;
}
export interface LoadEntry {
  firstRowMs: number[];
  editMs: number[];
  editFailures: string[];
}
export interface PerfDoc {
  runs?: number;
  builds?: { before?: string; candidate?: string };
  order?: string[];
  scenarios: Record<string, { work: WorkSample[]; control: WorkSample[]; correctness: string[] }>;
  load?: Record<string, LoadEntry>;
  before?: { load?: Record<string, LoadEntry> };
}
export interface Lane {
  tier: "primary" | "secondary";
  cols: number;
  kind?: "V45c" | "V" | "H" | "D";
  wheel?: { dx: number; dy: number };
}
export const NOTCHES: number;
export const START_ROW: number;
export const START_LEFT: number;
export const MOVE_TOLERANCE_PX: number;
export const GATES: { primary: { p95AtMostMs: number; maxBelowMs: number }; secondary: { p95AtMostMs: number; maxBelowMs: number } };
export const LANES: Record<string, Lane>;
export const LOAD_COLS: number[];
export function median(values: number[]): number;
export function percentile95(values: number[]): number;
export function workStats(stepMs: number[]): { p95: number; max: number; mean: number; steps: number };
export function withinTolerance(baseline: number, head: number): boolean;
export function workGate(runs: WorkSample[], gate?: { p95AtMostMs: number; maxBelowMs: number }): { pass: boolean; failures: string[]; summary: { p95: number; max: number } };
export function evaluate(doc: PerfDoc, opts?: { diagnostic?: boolean }): { ok: boolean; diagnostic: boolean; failures: string[] };
