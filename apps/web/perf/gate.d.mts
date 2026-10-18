export interface SweepSample {
  framesOver50: number;
  p95FrameMs: number;
  worstFrameMs: number;
}
export interface Machine {
  os: string;
  cpu: string;
  chrome: string;
}
export interface PerfDoc {
  machine: Machine;
  scenarios: Record<string, { sweeps: SweepSample[]; correctness: string[] }>;
  load: Record<string, { firstRowMs: number[]; editMs: number[]; editFailures: string[] }>;
}
export const FRAME_GATE: { maxFramesOver50: number; maxP95Ms: number; worstFrameBelowMs: number };
export const SCENARIOS: Record<string, { kind: "V45c" | "V" | "H" | "D"; cols: number }>;
export function median(values: number[]): number;
export function withinTolerance(baseline: number, head: number): boolean;
export function sameMachine(left: Machine | undefined, right: Machine | undefined): boolean;
export function frameGate(sweeps: SweepSample[]): {
  pass: boolean;
  failures: string[];
  summary: { over: number; p95: number; worst: number };
};
export function evaluate(doc: PerfDoc, baseline: PerfDoc | null): { ok: boolean; failures: string[] };
