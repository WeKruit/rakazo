export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

/** RFC 4180 parser: quoted fields, "" escapes, embedded newlines, CRLF, leading BOM. */
export function parseCsv(input: string): ParsedCsv {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let truncated = false;
  // ponytail: cut by UTF-16 length ≈ bytes for ASCII; a partial last row is dropped below.
  if (new TextEncoder().encode(text).length > CSV_MAX_BYTES) {
    text = text.slice(0, CSV_MAX_BYTES);
    const cut = Math.max(text.lastIndexOf("\n"), 0);
    text = text.slice(0, cut);
    truncated = true;
  }
  const all: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let pending = false; // row has content (a separator or char was seen)
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") all.push(row);
    row = [];
    field = "";
    pending = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') {
      quoted = true;
      pending = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      pending = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      pending = true;
    }
  }
  if (pending || field !== "" || row.length) endRow();
  const header = all[0] ?? [];
  let rows = all.slice(1);
  if (rows.length > CSV_MAX_ROWS) {
    rows = rows.slice(0, CSV_MAX_ROWS);
    truncated = true;
  }
  return { header, rows, rowCount: rows.length, truncated };
}
