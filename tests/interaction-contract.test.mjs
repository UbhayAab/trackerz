import assert from "node:assert/strict";
import { parseCapture } from "../src/ai/capture-parser.js";
import { aiStages } from "../src/ai/job-runner.js";
import { renderTable } from "../src/ui/table-renderer.js";

assert.deepEqual(
  aiStages.map((stage) => stage.key),
  ["queued", "extracting", "reasoning", "validating", "writing"],
);

const mixed = parseCapture({
  text: "paid 500 fuel on gpay, lunch was dal rice curd, slept 6 hours and walked 7000 steps",
  files: [],
  captureType: "money",
});

assert.ok(mixed.reviewRows.length >= 3, "mixed input should produce several review actions");
assert.ok(mixed.ledgerRows.length >= 1, "money input should update ledger rows");
assert.ok(mixed.macroRows.length >= 1, "food terms should update macro rows");
assert.ok(mixed.insights.length >= 3, "visible AI summary should update");

const statement = parseCapture({
  text: "uploading bank excel for May",
  files: [{ name: "may-hdfc.xlsx" }],
  captureType: "file_import",
});

assert.equal(statement.importRows.length, 1);
assert.equal(statement.importRows[0].status, "AI previewing");

const table = renderTable(
  [{ key: "item", label: "Item" }, { key: "ops", label: "Ops", actions: [{ label: "Approve", action: "approve" }] }],
  [{ id: "row_1", item: "<script>bad</script>" }],
  { table: "review" },
);

assert.ok(table.includes("&lt;script&gt;bad&lt;/script&gt;"));
assert.ok(table.includes('data-action="approve"'));

console.log("interaction contract tests passed");
