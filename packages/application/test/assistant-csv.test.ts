import { describe, expect, it } from "vitest";
import {
  CsvParseError,
  csvColumnSample,
  csvRowsToIngestTasks,
  parseCsv,
  sanitiseCsvMapping,
} from "../src/index.js";

/**
 * A4 — the three things a naive split gets wrong are exactly the three a real
 * spreadsheet export produces. All fixtures are synthetic.
 */
describe("CSV reader — RFC 4180 quoting", () => {
  it("keeps a comma inside a quoted field", () => {
    const table = parseCsv('name,note\n"設計, 実装",一括\n');
    expect(table.rows).toEqual([["設計, 実装", "一括"]]);
  });

  it("keeps a newline inside a quoted field", () => {
    const table = parseCsv('name,note\n"一行目\n二行目",x\n');
    expect(table.rows).toEqual([["一行目\n二行目", "x"]]);
  });

  it('reads "" as a literal quote', () => {
    const table = parseCsv('name\n"5"" パイプ"\n');
    expect(table.rows).toEqual([['5" パイプ']]);
  });

  it("accepts CRLF, LF and a trailing newline alike", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a,b\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    expect(parseCsv("﻿name,note\nx,y\n").header).toEqual(["name", "note"]);
  });

  it("pads a ragged row to the header width instead of misaligning it", () => {
    expect(parseCsv("a,b,c\n1,2\n").rows).toEqual([["1", "2", ""]]);
  });

  it("fails loudly on a file that ends inside a quote", () => {
    expect(() => parseCsv('name\n"unterminated\n')).toThrow(CsvParseError);
  });

  it("refuses a file past the row and column caps", () => {
    expect(() => parseCsv("a\n1\n2\n3\n", { maxRows: 2 })).toThrow(CsvParseError);
    expect(() => parseCsv("a,b,c\n", { maxColumns: 2 })).toThrow(CsvParseError);
  });
});

describe("CSV → prompt — cost does not grow with the file (Design 0005 §4)", () => {
  it("sends the header and at most a few rows, whatever the row count", () => {
    const body = Array.from({ length: 500 }, (_unused, index) => `T${index},8`).join("\n");
    const table = parseCsv(`name,hours\n${body}\n`);
    const sample = csvColumnSample(table);
    expect(table.rows).toHaveLength(500);
    expect(sample.sampleRows).toHaveLength(3);
    expect(sample.header).toEqual(["name", "hours"]);
  });
});

describe("CSV mapping — the model proposes indices, we sanitise them", () => {
  it("keeps a valid mapping and drops an out-of-range one", () => {
    const result = sanitiseCsvMapping({ name: 0, effortHours: 9 }, ["name", "hours"]);
    expect(result.mapping).toEqual({ name: 0 });
    expect(result.issues).toEqual([{ field: "effortHours", reason: "out-of-range" }]);
  });

  it("refuses to point two fields at one column", () => {
    const result = sanitiseCsvMapping({ name: 0, note: 0 }, ["name", "hours"]);
    expect(result.mapping).toEqual({ name: 0 });
    expect(result.issues).toEqual([{ field: "note", reason: "duplicate-column" }]);
  });

  it("ignores a field that is not mappable at all", () => {
    const result = sanitiseCsvMapping({ dailyPlan: 1, name: 0 }, ["name", "hours"]);
    expect(result.mapping).toEqual({ name: 0 });
  });
});

describe("CSV → IR — every row is converted in TypeScript", () => {
  it("reads hours written as a spreadsheet writes them", () => {
    const table = parseCsv("name,hours\nA,8\nB,7.5\nC,\"1,200\"\nD,8h\n");
    const tasks = csvRowsToIngestTasks(table, { name: 0, effortHours: 1 });
    expect(tasks.map((task) => task.effortHours)).toEqual([8, 7.5, 1_200, 8]);
  });

  it("drops a row with no task name — a spacer or a subtotal, not a task", () => {
    const table = parseCsv("name,hours\nA,8\n,16\n");
    expect(csvRowsToIngestTasks(table, { name: 0, effortHours: 1 })).toHaveLength(1);
  });

  it("emits only the add vocabulary, so a CSV can never address an existing row", () => {
    const table = parseCsv("name,proc\nA,設計\n");
    const [task] = csvRowsToIngestTasks(table, { name: 0, process: 1 });
    expect(task?.op).toBe("add");
    expect(Object.keys(task ?? {})).not.toContain("seq");
  });
});
