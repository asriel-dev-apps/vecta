/**
 * RFC 4180 CSV reader.
 *
 * Written here rather than taken from npm on purpose: the Worker bundle has a
 * 3 MB ceiling on the free plan, and the dependency-maturity policy
 * (`verify-release-age-policy.mjs`) means a new transitive dependency is a cost
 * paid again at install time. RFC 4180 quoting is a page of code.
 *
 * It began under `assistant/` for the LLM CSV import (Design 0005 §4) and moved
 * here when the timesheet import (Design 0011 §5.4) became its second caller —
 * the parser was never assistant-specific, and a second RFC 4180 implementation
 * is a second place for the quoting rules to drift. `assistant/csv.ts` re-exports
 * it, so the assistant's own imports are unchanged; what stays there is the
 * model-facing column-mapping vocabulary, which really is assistant-only.
 */

export interface CsvParseOptions {
  /** Reject files that would blow the context budget before we build a prompt. */
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

const DEFAULT_MAX_ROWS = 5_000;
const DEFAULT_MAX_COLUMNS = 60;

/**
 * Split CSV text into records. Handles the three things a naive `split(",")`
 * gets wrong and that real spreadsheets emit constantly: quoted fields
 * containing commas, quoted fields containing newlines, and the doubled `""`
 * escape for a literal quote. CRLF, LF and a lone CR all terminate a record; a
 * UTF-8 BOM is stripped.
 */
function splitRecords(text: string, maxColumns: number): string[][] {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    record.push(field);
    field = "";
    if (record.length > maxColumns) {
      throw new CsvParseError(`CSV has more than ${maxColumns} columns`);
    }
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      // A quote only opens a field at its start; elsewhere it is literal text,
      // which is what spreadsheets produce for values like 5" pipe.
      if (field.length === 0) quoted = true;
      else field += char;
      index += 1;
      continue;
    }
    if (char === ",") {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRecord();
      index += char === "\r" && source[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) throw new CsvParseError("CSV ends inside a quoted field");
  // A trailing newline closes the last record; anything else still in hand is one.
  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

/** Parse CSV text into a header and data rows, padding short rows to the header width. */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvTable {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const records = splitRecords(text, maxColumns);
  const nonEmpty = records.filter(
    (record) => !(record.length === 1 && record[0]!.trim().length === 0),
  );
  if (nonEmpty.length === 0) throw new CsvParseError("CSV is empty");

  const header = nonEmpty[0]!.map((cell) => cell.trim());
  const dataRecords = nonEmpty.slice(1);
  if (dataRecords.length > maxRows) {
    throw new CsvParseError(`CSV has more than ${maxRows} data rows`);
  }
  // Ragged rows are normal in exported files; widen or truncate to the header so
  // downstream column indexing is total.
  const rows = dataRecords.map((record) =>
    Array.from({ length: header.length }, (_unused, column) => record[column] ?? ""),
  );
  return { header, rows };
}

