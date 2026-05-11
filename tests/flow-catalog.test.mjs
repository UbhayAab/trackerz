import assert from "node:assert/strict";
import { getFlowStats, userFlows, validateFlowCatalog } from "../lib/flow-catalog.mjs";

const errors = validateFlowCatalog(userFlows);
assert.deepEqual(errors, []);

const stats = getFlowStats();
assert.ok(stats.total >= 75, `expected a large flow catalog, got ${stats.total}`);

for (const domain of ["capture", "money", "diet", "fitness", "wellness", "dashboard", "ai", "community"]) {
  assert.ok(stats.byDomain[domain] >= 1, `missing ${domain} flows`);
}

assert.ok(userFlows.some((flow) => flow.id === "money-bank-excel"));
assert.ok(userFlows.some((flow) => flow.id === "dashboard-cost-meter"));
assert.ok(userFlows.some((flow) => flow.id === "ai-prompt-injection"));
assert.ok(userFlows.some((flow) => flow.inputs.includes("xlsx")));
assert.ok(userFlows.some((flow) => flow.examples.some((example) => /PhonePe|GPay|Paytm/.test(example))));
assert.ok(userFlows.some((flow) => flow.qualityOfLife.some((item) => /one-tap|single|autosave|offline|reprocess/i.test(item))));

console.log(`flow catalog tests passed: ${stats.total} flows`);
