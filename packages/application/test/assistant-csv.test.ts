import { describe, expect, it } from "vitest";
import {
  CsvParseError,
  assistantContextBudget,
  buildCsvMappingPrompt,
  csvColumnSample,
  csvMappingJsonSchema,
  csvRowsToIngestTasks,
  parseCsv,
  parseCsvMapping,
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

describe("CSV mapping schema — the model's whole contribution", () => {
  it("accepts an answer of column indices", () => {
    const parsed = parseCsvMapping({ name: 0, effortHours: 2 });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a field that is not mappable, so a stray key cannot ride along", () => {
    expect(parseCsvMapping({ name: 0, dailyPlan: 1 }).ok).toBe(false);
  });

  it("rejects a non-integer or negative index", () => {
    expect(parseCsvMapping({ name: 1.5 }).ok).toBe(false);
    expect(parseCsvMapping({ name: -1 }).ok).toBe(false);
  });

  it("rejects prose where JSON belongs", () => {
    expect(parseCsvMapping("A 列がタスク名です").ok).toBe(false);
  });

  it("derives its JSON Schema from the same schema, and mentions no forbidden field", () => {
    const schema = JSON.stringify(csvMappingJsonSchema());
    expect(schema).toContain("effortHours");
    for (const word of ["seq", "dailyPlan", "parentId", "delete"]) {
      expect(schema, `schema mentions ${word}`).not.toContain(word);
    }
  });
});

describe("CSV prompt — the file does not go to the model (Design 0005 §4)", () => {
  const budget = assistantContextBudget("ingest", 24_000);

  it("carries the header and the samples, and nothing else from the file", () => {
    const body = Array.from({ length: 400 }, (_u, i) => `秘密のタスク${i},8`).join("\n");
    const table = parseCsv(`作業名,工数\n${body}\n`);
    const prompt = buildCsvMappingPrompt(csvColumnSample(table), budget);
    expect(prompt.system).toContain("作業名");
    expect(prompt.system).toContain("秘密のタスク0");
    expect(prompt.system).toContain("秘密のタスク2");
    // Row 4 onwards never leaves the server, which is what makes the cost of an
    // import independent of its size.
    expect(prompt.system).not.toContain("秘密のタスク3");
    expect(prompt.system).not.toContain("秘密のタスク399");
  });

  it("tells the model the header is a third party's document", () => {
    const table = parseCsv("a,b\n1,2\n");
    const prompt = buildCsvMappingPrompt(csvColumnSample(table), budget);
    expect(prompt.system).toContain("DOCUMENT SOMEBODY ELSE WROTE");
  });

  it("caps the answer low — it is seven integers, not an essay", () => {
    const table = parseCsv("a,b\n1,2\n");
    expect(buildCsvMappingPrompt(csvColumnSample(table), budget).maxOutputTokens).toBeLessThanOrEqual(400);
  });

  it("prefers omitting a field to guessing it", () => {
    const table = parseCsv("a,b\n1,2\n");
    expect(buildCsvMappingPrompt(csvColumnSample(table), budget).system).toContain(
      "Guessing is worse than omitting",
    );
  });
});
