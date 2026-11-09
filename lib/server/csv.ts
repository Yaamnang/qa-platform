import "server-only";

export type CsvTable = { header: string[]; rows: string[][] };

/** Minimal CSV parser (quoted fields, CRLF). Enough for the stand-in's uploads. */
export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  const [header = [], ...rows] = nonEmpty;
  return { header: header.map((h) => h.trim().toLowerCase()), rows };
}

export function toCsv(rows: (string | number)[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((c) => {
            const s = String(c);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\n") + "\n"
  );
}
