import type { DependencyType } from "@vecta/domain";

/**
 * Subtask templates (ADR 0011 Decision 5; Design 0003 §E-1). A template prorates
 * the parent task's planned effort (L) across named subtasks by basis-point
 * weight, and chains consecutive subtasks with a dependency/lag. Templates are a
 * project-scoped master (see {@link ProjectState.templates}); generation resolves
 * them from project state, not from a built-in catalog. All names are generic PM
 * terms; no client, vendor, product, or contract names appear here.
 */
export interface SubtaskTemplateStep {
  /** Generic subtask name (worksheet column F). */
  readonly name: string;
  /** Basis-point share of the parent's planned effort (0–10000). */
  readonly weightBp: number;
  /**
   * Dependency on the immediately-preceding subtask in the template, or absent
   * for the first subtask. The scheduler (step ④) places the subtask relative to
   * its predecessor using this relationship and working-day lag.
   */
  readonly dependsOnPrev?: {
    readonly type: DependencyType;
    readonly lagWorkingDays: number;
  };
}

/** A project-scoped subtask template master (Design 0003 §E-1). */
export interface SubtaskTemplate {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtasks: readonly SubtaskTemplateStep[];
}

/**
 * Largest-remainder (Hamilton) apportionment. Distributes the whole integer
 * `total` across the given integer `weights` so the result sums to exactly
 * `total`. Each entry receives floor(total × weight / Σweight); the leftover
 * units (< number of entries) go to the entries with the largest integer
 * remainder, breaking ties by ascending index — a fully deterministic rule.
 *
 * If Σweight is 0, `total` is split as evenly as possible with the remainder
 * assigned to the earliest entries. All arithmetic is exact-integer (numbers
 * stay below 2^53), so there is no floating-point rounding.
 */
export function prorateLargestRemainder(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    const base = Math.floor(total / count);
    const leftover = total - base * count;
    return weights.map((_weight, index) => base + (index < leftover ? 1 : 0));
  }

  const quotients: number[] = [];
  const remainders: number[] = [];
  let allocated = 0;
  for (const weight of weights) {
    const numerator = total * weight;
    let quotient = Math.floor(numerator / weightSum);
    let remainder = numerator - quotient * weightSum;
    // Correct any floating-point drift in the division so (quotient, remainder)
    // satisfy numerator = quotient × weightSum + remainder exactly.
    if (remainder < 0) {
      quotient -= 1;
      remainder += weightSum;
    } else if (remainder >= weightSum) {
      quotient += 1;
      remainder -= weightSum;
    }
    quotients.push(quotient);
    remainders.push(remainder);
    allocated += quotient;
  }

  const leftover = total - allocated; // integer in [0, count)
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let placed = 0; placed < leftover; placed += 1) {
    const target = order[placed]!.index;
    quotients[target] = quotients[target]! + 1;
  }
  return quotients;
}

// --- Deterministic UUIDv5 (RFC 4122 §4.3) for generated subtask ids ---------
//
// Child ids must be reproducible from the parent id (no Math.random / crypto),
// so the same generation always yields the same ids and re-running is idempotent
// at the id level. UUIDv5 hashes a fixed namespace + a name string with SHA-1; a
// self-contained SHA-1 keeps the application layer portable (browser / Worker /
// Node) and free of platform crypto.

const SUBTASK_NAMESPACE = "6ba7b8f0-9dad-11d1-80b4-00c04fd430c8";

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sha1(bytes: readonly number[]): number[] {
  const message = bytes.slice();
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  for (let shift = 7; shift >= 0; shift -= 1) {
    message.push(Math.floor(bitLength / 2 ** (8 * shift)) & 0xff);
  }

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Array<number>(80);

  for (let chunk = 0; chunk < message.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] =
        ((message[chunk + i * 4]! << 24) |
          (message[chunk + i * 4 + 1]! << 16) |
          (message[chunk + i * 4 + 2]! << 8) |
          message[chunk + i * 4 + 3]!) >>>
        0;
    }
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotateLeft(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotateLeft(a, 5) + f + e + k + words[i]!) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest: number[] = [];
  for (const word of [h0, h1, h2, h3, h4]) {
    digest.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return digest;
}

function uuidToBytes(uuid: string): number[] {
  const hex = uuid.replace(/-/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    bytes.push(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return bytes;
}

function formatUuid(bytes: readonly number[]): string {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidV5(namespace: string, name: string): string {
  const nameBytes = [...name].map((char) => char.charCodeAt(0) & 0xff);
  const digest = sha1([...uuidToBytes(namespace), ...nameBytes]);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

/** Deterministic child task id for the `index`-th subtask under `parentTaskId`. */
export function deriveSubtaskId(parentTaskId: string, index: number): string {
  return uuidV5(SUBTASK_NAMESPACE, `${parentTaskId}:${index}`);
}
