import { z } from "zod";

/**
 * The assistant's CSV import (Design 0005 §4, ADR 0013 Decision 10).
 *
 * A CSV is already structured, so feeding its rows to a model would buy nothing
 * and cost neurons per row. The model's entire job is mapping the HEADER names to
 * IR fields — a fixed-size question, no matter how many rows follow — and the
 * parser does the rest. Neuron cost therefore does not grow with the file.
 */

// RFC 4180 parsing moved to `../csv.ts` when the timesheet import (Design 0011)
// became its second caller. Re-exported here so the assistant's own callers and
// tests are unchanged, and so there is exactly one implementation of the quoting
// rules. What remains below is the part that really is assistant-specific: the
// vocabulary the model maps header names onto.
import type { CsvTable } from "../csv.js";

export {
  CsvParseError,
  parseCsv,
  type CsvParseOptions,
  type CsvTable,
} from "../csv.js";

/**
 * The whole prompt payload for a CSV import: the header names and at most a few
 * sample rows. Design 0005 §4-2 — nothing else from the file reaches the model,
 * so a 5,000-row estimate costs the same as a 5-row one.
 */
export interface CsvColumnSample {
  readonly header: readonly string[];
  readonly sampleRows: readonly (readonly string[])[];
}

export function csvColumnSample(table: CsvTable, sampleSize = 3): CsvColumnSample {
  return { header: table.header, sampleRows: table.rows.slice(0, Math.max(0, sampleSize)) };
}

/**
 * The IR task fields a CSV column may feed. Deliberately the ADD vocabulary only:
 * a CSV is a third-party document, so it runs in ingest mode and cannot address
 * an existing row (ADR 0013 Decision 3).
 */
export const CSV_MAPPABLE_FIELDS = [
  "name",
  "parent",
  "process",
  "product",
  "assignee",
  "effortHours",
  "note",
] as const;

export type CsvMappableField = (typeof CSV_MAPPABLE_FIELDS)[number];

/** Column index per IR field; a field the model could not find is simply absent. */
export type CsvColumnMapping = Partial<Record<CsvMappableField, number>>;

/**
 * The model's entire contribution to a CSV import: which column feeds which field.
 * A fixed-size answer — seven optional integers — no matter how many rows follow,
 * which is what makes the neuron cost independent of the file (Design 0005 §4).
 *
 * Indices, not names, because a name would have to be matched back against the
 * header anyway and a model paraphrases ("工数(h)" → "工数"). An index either
 * exists in the header or does not, and {@link sanitiseCsvMapping} decides which.
 */
export const CsvMappingSchema = z
  .object(
    Object.fromEntries(
      CSV_MAPPABLE_FIELDS.map((field) => [
        field,
        z.number().int().min(0).max(200).nullable().optional(),
      ]),
    ) as Record<CsvMappableField, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
  )
  .strict();

export function csvMappingJsonSchema(): unknown {
  return z.toJSONSchema(CsvMappingSchema, { target: "draft-7", io: "input" });
}

export type CsvMappingResponse = z.infer<typeof CsvMappingSchema>;

/** Validate raw model output as a column mapping. Same posture as the IR: a miss is normal. */
export function parseCsvMapping(
  raw: unknown,
): { readonly ok: true; readonly mapping: CsvMappingResponse } | { readonly ok: false } {
  const parsed = CsvMappingSchema.safeParse(raw);
  return parsed.success ? { ok: true, mapping: parsed.data } : { ok: false };
}

export interface CsvMappingIssue {
  readonly field: CsvMappableField;
  readonly reason: "out-of-range" | "duplicate-column";
}

export interface CsvMappingResult {
  readonly mapping: CsvColumnMapping;
  readonly issues: readonly CsvMappingIssue[];
}

/**
 * Sanitise the model's column mapping against the real header. The model only
 * ever proposes indices; a stray index would otherwise read a column that is not
 * there, or silently duplicate one field onto two.
 */
export function sanitiseCsvMapping(
  proposed: Readonly<Record<string, unknown>>,
  header: readonly string[],
): CsvMappingResult {
  const mapping: CsvColumnMapping = {};
  const issues: CsvMappingIssue[] = [];
  const usedColumns = new Set<number>();

  for (const field of CSV_MAPPABLE_FIELDS) {
    const raw = proposed[field];
    if (raw === undefined || raw === null) continue;
    const column = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isInteger(column) || column < 0 || column >= header.length) {
      issues.push({ field, reason: "out-of-range" });
      continue;
    }
    if (usedColumns.has(column)) {
      issues.push({ field, reason: "duplicate-column" });
      continue;
    }
    usedColumns.add(column);
    mapping[field] = column;
  }
  return { mapping, issues };
}

/** Numbers in an estimate arrive as "12", "12.5", "1,200" or "8h"; take the leading number. */
function toHours(cell: string): number | undefined {
  // Scanned by hand rather than matched by a regex. Every regex shape tried here
  // was flagged as potentially backtracking, and this reads a document SOMEBODY ELSE
  // wrote while Workers Free allows the whole request 10 ms of CPU — so a slow match
  // is a denial of service, not a slow import. A linear scan cannot backtrack at all.
  let start = -1;
  for (let index = 0; index < cell.length; index += 1) {
    const code = cell.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      start = index;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = start;
  while (end < cell.length) {
    const char = cell[end]!;
    if ((char >= "0" && char <= "9") || char === "," || char === ".") end += 1;
    else break;
  }
  const value = Number.parseFloat(cell.slice(start, end).replace(/,/gu, ""));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Apply the mapping to EVERY row, in TypeScript. This is the step that makes the
 * neuron cost independent of the row count (Design 0005 §4-4): the model saw the
 * header, this function sees the file.
 */
export function csvRowsToIngestTasks(
  table: CsvTable,
  mapping: CsvColumnMapping,
): readonly {
  readonly op: "add";
  readonly name: string;
  readonly parent?: string | null;
  readonly process?: string | null;
  readonly product?: string | null;
  readonly assignee?: string | null;
  readonly effortHours?: number;
  readonly note?: string;
}[] {
  const cell = (row: readonly string[], field: CsvMappableField): string => {
    const column = mapping[field];
    return column === undefined ? "" : (row[column] ?? "").trim();
  };

  return table.rows.flatMap((row) => {
    const name = cell(row, "name");
    // A row with no task name is a spacer or a subtotal, not a task. Dropping it
    // is safe here because ingest mode only ever ADDS.
    if (name.length === 0) return [];
    const parent = cell(row, "parent");
    const process = cell(row, "process");
    const product = cell(row, "product");
    const assignee = cell(row, "assignee");
    const note = cell(row, "note");
    const hours = toHours(cell(row, "effortHours"));
    return [
      {
        op: "add" as const,
        name,
        ...(parent.length > 0 ? { parent } : {}),
        ...(process.length > 0 ? { process } : {}),
        ...(product.length > 0 ? { product } : {}),
        ...(assignee.length > 0 ? { assignee } : {}),
        ...(hours === undefined ? {} : { effortHours: hours }),
        ...(note.length > 0 ? { note } : {}),
      },
    ];
  });
}
