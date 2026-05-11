import { classifyImportColumns } from "../../lib/agent-core.mjs";
import { detectBankFormat } from "./bank-format-detector.js";

export function buildStatementPreview({ filename, headers, rows }) {
  const mapping = classifyImportColumns(headers);
  const bank = detectBankFormat({ filename, headers });
  return {
    filename,
    bank,
    mapping,
    rowCount: rows.length,
    mappedFields: Object.values(mapping).filter(Boolean).length,
    needsReview: Object.values(mapping).filter(Boolean).length < 4,
  };
}
