export interface WorkSample {
  p95: number;
  max: number;
}
export interface Machine {
  os: string;
  cpu: string;
  chrome: string;
}
export interface PerfDoc {
  machine: Machine;
  scenarios: Record<string, { work: WorkSample[]; control: WorkSample[]; correctness: string[] }>;
  load: Record<string, { firstRowMs: number[]; editMs: number[]; editFailures: string[] }>;
}
export const WORK_GATE: { p95AtMostMs: number; maxBelowMs: number };
export const SCENARIOS: Record<string, { kind: "V45c" | "V" | "H" | "D"; cols: number }>;
export function median(values: number[]): number;
export function percentile95(values: number[]): number;
export function workStats(stepMs: number[]): { p95: number; max: number; mean: number; steps: number };
export function withinTolerance(baseline: number, head: number): boolean;
export function sameMachine(left: Machine | undefined, right: Machine | undefined): boolean;
export function workGate(runs: WorkSample[]): { pass: boolean; failures: string[]; summary: { p95: number; max: number } };
export function evaluate(doc: PerfDoc, baseline: PerfDoc | null): { ok: boolean; failures: string[] };
