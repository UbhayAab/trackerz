import assert from "node:assert/strict";
import { parseCapture } from "../src/ai/capture-parser.js";
import { createDemoState, createEmptyState } from "../src/state/app-state.js";
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

const complex = parseCapture({
  text: "weekly log: paid 240 zomato, spent 500 fuel, amazon refund 1299, breakfast poha, lunch dal rice curd, dinner chicken rice, slept 5 hours and walked 8500 steps",
  files: [{ name: "voice-note.webm", type: "audio/webm", kind: "audio" }, { name: "phonepe.png", type: "image/png", kind: "image" }],
  captureType: "money",
});

assert.ok(complex.ledgerRows.length >= 3, "complex money input should create multiple ledger rows");
assert.ok(complex.macroRows.length >= 3, "complex diet input should split meals");
assert.ok(complex.reviewRows.some((row) => /audio/i.test(row.item)), "audio file should create a review row");
assert.ok(complex.reviewRows.some((row) => /image/i.test(row.item)), "image file should create a review row");
assert.ok(complex.reviewRows.some((row) => /duplicate/i.test(row.risk)), "multi-source upload should flag duplicates");

const table = renderTable(
  [{ key: "item", label: "Item" }, { key: "ops", label: "Ops", actions: [{ label: "Approve", action: "approve" }] }],
  [{ id: "row_1", item: "<script>bad</script>" }],
  { table: "review" },
);

assert.ok(table.includes("&lt;script&gt;bad&lt;/script&gt;"));
assert.ok(table.includes('data-action="approve"'));

const emptyTable = renderTable([{ key: "item", label: "Item" }], [], { emptyMessage: "Clean database" });
assert.ok(emptyTable.includes("Clean database"));

const emptyState = createEmptyState();
assert.equal(emptyState.ledgerRows.length, 0);
assert.equal(emptyState.reviewRows.length, 0);
assert.equal(emptyState.metrics.todaySpend, 0);

const demoState = createDemoState();
assert.ok(demoState.ledgerRows.length > 0);
assert.ok(demoState.insights.length > 0);

console.log("interaction contract tests passed");
