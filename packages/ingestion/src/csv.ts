import type { InputRow } from "./types";

/** Parses RFC4180-style CSV, including quoted commas and escaped quotes. */
export function parseCsv(input: string): InputRow[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => normalizeHeader(header.replace(/^\uFEFF/, "")));
  return rows.slice(1).filter((values) => values.some((value) => value.trim() !== "")).map((values, index) => ({
    row: index + 2,
    values: Object.fromEntries(headers.map((header, column) => [header, (values[column] ?? "").trim()])),
  }));
}

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
