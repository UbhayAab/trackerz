// Pure CSV helpers (no browser/Supabase imports) so they can be unit-tested.

export function csvCell(value) {
  if (value == null) return "";
  const s = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = (rows || []).map((row) => columns.map((c) => csvCell(row[c])).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}
