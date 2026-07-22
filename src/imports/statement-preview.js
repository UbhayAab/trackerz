import { classifyImportColumns } from "../../lib/agent-core.mjs";
import { detectBankFormat } from "./bank-format-detector.js";
import { countPromotable, shapeRowForPromotion } from "./row-normalizer.js";

export function buildStatementPreview({ filename, headers, rows }) {
  const mapping = classifyImportColumns(headers);
  const bank = detectBankFormat({ filename, headers });
  // rowCount is how much is in the file; promotableRows is how much will reach
  // the ledger. They are different numbers and the user is shown both — an
  // import that stores 128 rows and moves zero money is the bug this closes.
  const reach = countPromotable(rows.map((row) => shapeRowForPromotion(row, mapping)));
  return {
    filename,
    bank,
    mapping,
    rowCount: rows.length,
    mappedFields: Object.values(mapping).filter(Boolean).length,
    needsReview: Object.values(mapping).filter(Boolean).length < 4,
    promotableRows: reach.promotable,
    blockedRows: reach.blocked,
    blockers: reach.blockers,
  };
}
