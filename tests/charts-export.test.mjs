import assert from "node:assert/strict";
import { toCsv, csvCell } from "../src/utils/csv.js";
import { buildTrendData } from "../src/ui/charts.js";

// --- CSV ---
assert.equal(csvCell("a,b"), '"a,b"');
assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
assert.equal(csvCell(["x", "y"]), "x; y");
assert.equal(csvCell(null), "");
assert.equal(toCsv([{ a: 1, b: "z,1" }], ["a", "b"]), 'a,b\n1,"z,1"');
assert.equal(toCsv([], ["a", "b"]), "a,b");

// --- Charts use real daily series, not fabricated scaling ---
const now = new Date();
const isoDaysAgo = (d) => { const x = new Date(now); x.setDate(x.getDate() - d); x.setHours(12, 0, 0, 0); return x.toISOString(); };
const state = {
  ledger: [
    { direction: "expense", amount: 200, occurred_at: isoDaysAgo(0) },
    { direction: "expense", amount: 100, occurred_at: isoDaysAgo(1) },
    { direction: "income", amount: 5000, occurred_at: isoDaysAgo(0) },
  ],
  foodLogs: [{ protein_g: 30, occurred_at: isoDaysAgo(0) }],
};
const trend = buildTrendData(state);
assert.equal(trend.dod.length, 7);
assert.equal(trend.wow.length, 14);
assert.equal(trend.mom.length, 30);
assert.equal(trend.trajectory.length, 30);
// Today's spend bar (last point) is 200; income is excluded.
assert.equal(trend.dod[trend.dod.length - 1].value, 200);
// Cumulative trajectory is non-decreasing.
for (let i = 1; i < trend.trajectory.length; i++) {
  assert.ok(trend.trajectory[i].value >= trend.trajectory[i - 1].value);
}
// Empty state must not throw.
const empty = buildTrendData({});
assert.equal(empty.dod.length, 7);

console.log("charts+export tests passed");
