import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES, CSV_MAX_ROWS, parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses quoted fields, commas, escaped quotes and embedded newlines", () => {
    const r = parseCsv('name,note\n"Doe, Jane","says ""hi""\nline2"\nBob,\n');
    expect(r.header).toEqual(["name", "note"]);
    expect(r.rows).toEqual([
      ["Doe, Jane", 'says "hi"\nline2'],
      ["Bob", ""],
    ]);
    expect(r.truncated).toBe(false);
  });
  it("strips a UTF-8 BOM and handles CRLF", () => {
    const r = parseCsv("﻿a,b\r\n1,2\r\n3,4");
    expect(r.header).toEqual(["a", "b"]);
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
  it("skips blank lines and returns empty for empty input", () => {
    expect(parseCsv("a\n\n1\n").rows).toEqual([["1"]]);
    expect(parseCsv("")).toEqual({ header: [], rows: [], rowCount: 0, truncated: false });
  });
  it("truncates at the row cap and reports it", () => {
    const text = `h\n${Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => i).join("\n")}`;
    const r = parseCsv(text);
    expect(r.rows).toHaveLength(CSV_MAX_ROWS);
    expect(r.truncated).toBe(true);
  });
  it("truncates oversize text at the byte cap", () => {
    const row = `${"x".repeat(999)}\n`;
    const r = parseCsv(`h\n${row.repeat(CSV_MAX_BYTES / 1000 + 100)}`);
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeLessThan(CSV_MAX_BYTES / 1000 + 100);
  });
});
