// Turns a file into an array-of-arrays, and nothing else.
//
// Isolated from the parsing logic for one reason: the sheet library is the only
// part of statement import that is allowed to be wrong about a cell, and it
// has to be told not to be.
//
// SheetJS "helpfully" interprets date-looking text. Given Kotak's `01-04-2026`
// (1 April) it produces a Date of 4 JANUARY - a silent three-month error on
// every unambiguous-looking row in the file, invisible in the preview and
// permanent in the ledger. So every cell is read RAW, as the exact text the
// bank wrote, and `lib/statement-shape.mjs` decides what the date means using
// evidence from the whole file. The library is used only to decode the
// container (BIFF/OOXML/CSV), never to interpret contents.

const VENDORED_XLSX = "../../vendor/xlsx/xlsx@0.18.5/index.mjs";
const CDN_XLSX = "https://esm.sh/xlsx@0.18.5"; // rescue path for a partial deploy

let xlsxPromise = null;

export async function loadSheetLibrary() {
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = (async () => {
    const failures = [];
    for (const specifier of [VENDORED_XLSX, CDN_XLSX]) {
      try {
        return await import(/* @vite-ignore */ specifier);
      } catch (err) {
        failures.push(`${specifier}: ${err?.message || err}`);
      }
    }
    // Name what failed. A parser that could not load must never read as
    // "your file was empty".
    throw new Error(`Could not load the spreadsheet parser. ${failures.join(" | ")}`);
  })();
  return xlsxPromise;
}

const RAW_READ = { raw: true, cellDates: false, cellText: true, cellNF: false };
// `blankrows` matters: a blank line separates the letterhead from the table on
// most exports, and dropping it shifts every row index reported to the user.
const RAW_SHEET = { header: 1, defval: "", raw: true, blankrows: true };

/**
 * @param {ArrayBuffer|Uint8Array|string} data
 * @param {{isCsv: boolean}} opts
 * @returns {{sheets: Array<{name: string, aoa: Array<Array<*>>}>}}
 */
export function readWorkbook(XLSX, data, { isCsv = false } = {}) {
  const workbook = isCsv
    ? XLSX.read(typeof data === "string" ? data : new TextDecoder().decode(data), { type: "string", ...RAW_READ })
    : XLSX.read(data, { type: "array", ...RAW_READ });
  const sheets = (workbook.SheetNames || []).map((name) => ({
    name,
    aoa: XLSX.utils.sheet_to_json(workbook.Sheets[name], RAW_SHEET),
  }));
  return { sheets };
}

export function isCsvName(name) {
  return /\.(csv|txt)$/i.test(String(name || ""));
}

/**
 * Read a browser File into sheets. The largest sheet wins when a workbook has
 * several, because banks put the transactions on the big one and disclaimers on
 * the rest.
 */
export async function readStatementFile(file) {
  const XLSX = await loadSheetLibrary();
  const isCsv = isCsvName(file.name);
  const data = isCsv ? await file.text() : new Uint8Array(await file.arrayBuffer());
  const { sheets } = readWorkbook(XLSX, data, { isCsv });
  if (!sheets.length) throw new Error(`${file.name} has no sheets`);
  const best = [...sheets].sort((a, b) => b.aoa.length - a.aoa.length)[0];
  return { filename: file.name, sheetName: best.name, aoa: best.aoa, sheetCount: sheets.length };
}
