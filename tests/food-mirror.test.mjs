// FOOD-NUTRITION MIRROR PARITY.
//
// supabase/functions/agent/index.ts hand-copies the whole nutrition engine
// (table + phrase parser + estimateNutrition) because Deno cannot import repo
// lib/. Unlike the sleep-window mirror it is NOT byte-identical - the edge copy
// carries TypeScript annotations, different function names and no `unit` field -
// so text comparison cannot guard it and it drifted unnoticed.
//
// Instead: extract the edge's food block, let Node strip the types, and assert
// it returns THE SAME NUMBERS as lib/food-nutrition.mjs across a corpus. A macro
// that differs between the browser and the server is a silent data bug - the
// server auto-applies its own totals, so the user sees the edge's answer.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateNutrition as libEstimate } from "../lib/food-nutrition.mjs";

const EDGE = "supabase/functions/agent/index.ts";
const src = readFileSync(EDGE, "utf8");

// The block runs from the table to the end of estimateNutrition, which is
// immediately followed by recomputeFoodMacros.
const start = src.indexOf("const FOOD_TABLE");
const end = src.indexOf("function recomputeFoodMacros");
assert.ok(start !== -1, "FOOD_TABLE not found in the edge function");
assert.ok(end > start, "recomputeFoodMacros not found after FOOD_TABLE");
const block = src.slice(start, src.lastIndexOf("\n", end) + 1);

// Self-containment check: the block must not reach for anything outside itself.
assert.ok(!/\bDeno\b|\bsupabase\b/i.test(block), "food block must stay pure");

const dir = mkdtempSync(join(tmpdir(), "trackerz-food-mirror-"));
const file = join(dir, "edge-food.ts");
writeFileSync(file, `${block}\nexport { estimateNutrition };\n`);

let edgeEstimate;
try {
  ({ estimateNutrition: edgeEstimate } = await import(pathToFileURL(file).href));
} catch (err) {
  rmSync(dir, { recursive: true, force: true });
  throw new Error(
    `could not load the edge food block (needs a Node with type stripping, 22.18+): ${err.message}`,
  );
}

const CORPUS = [
  // the 2026-07-28 order manifest, the capture that exposed the drift
  "Coca Cola Zero Sugar Soft Drink Can (300 ml) × 3\nEat Better Co Ragi Chips, Achari Masti (55 g) × 1\nEat Better Co Ragi Chips, Thai Chilli Tadka (55 g) × 1",
  "Coca Cola Zero Sugar Soft Drink Can (300 ml) × 3",
  "Eat Better Co Ragi Chips, Achari Masti (55 g) × 1",
  // the sugar-free reroute and its negative cases
  "coke", "2 coke", "coke zero", "diet coke", "3 coke zero", "diet pepsi",
  "2 cans of diet pepsi", "sprite", "sprite zero", "thums up", "soda",
  // quantities, weights and the 100x blow-up guard
  "250 g rice", "500ml curd", "2 scoops whey", "cookies x5", "box 8",
  "1 litre curd and 2 scoops whey protein", "6 boiled eggs and 500ml curd",
  // The three 2026-08-06 logic changes, each of which lived in lib alone for a
  // while. A corpus that does not name them lets the edge keep the old answer.
  "200-300 g curd",                       // a RANGE collapses to its midpoint
  "100-200 ml milk", "3-4 rotis",
  "one tomato", "two tomatoes",           // a spelled-out number is not a food
  "1 small bowl Haldiram Aloo Bhujia (30 g)",  // a trailing weight beats a vague count
  "50 g aloo bhujia and 2 soup sachets",  // the owner's snack, priced by the table
  "30 g aloo bhujia", "6 whole boiled eggs", "70 g soya chunks soaked and drained",
  "3 rotis dal sabzi", "two boiled eggs", "coffee and 5 cookies",
  "egg curry and 2 eggs", "100g paneer", "1.5 cups rice",
  // things that are not food at all
  "", "fuel", "call the bank tomorrow", "walked 10000 steps", "spent 250 on lunch",
  // multi-line and punctuation shapes
  "maggi\ncurd\n2 eggs", "chips, namkeen and a coke", "bread + butter + jam",
];

for (const text of CORPUS) {
  const a = libEstimate(text);
  const b = edgeEstimate(text);
  const label = JSON.stringify(text);
  assert.deepEqual(b.totals, a.totals, `MACRO DRIFT on ${label}: edge=${JSON.stringify(b.totals)} lib=${JSON.stringify(a.totals)}`);
  assert.equal(b.recognized, a.recognized, `RECOGNIZED DRIFT on ${label}: edge=${b.recognized} lib=${a.recognized}`);
  assert.deepEqual(
    b.items.map((i) => [i.key, i.qty]).sort(),
    a.items.map((i) => [i.key, i.qty]).sort(),
    `ITEM DRIFT on ${label}`,
  );
  assert.deepEqual([...b.unknown].sort(), [...a.unknown].sort(), `UNKNOWN DRIFT on ${label}`);
  // recognized is what decides whether the table OVERRIDES the model, so the
  // two copies disagreeing on it is as bad as disagreeing on a number.
  assert.equal(b.recognized, a.recognized, `RECOGNIZED DRIFT on ${label}`);
  assert.deepEqual([...(b.unscaled || [])].sort(), [...(a.unscaled || [])].sort(),
    `UNSCALED DRIFT on ${label}`);
}

// Every alias in one table must exist in the other - a food added to lib but not
// mirrored would otherwise only surface on a phrase that happens to name it.
{
  const aliasesOf = (text) => new Set([...text.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])));
  const libAliases = aliasesOf(readFileSync("lib/food-nutrition.mjs", "utf8"));
  const edgeAliases = aliasesOf(block);
  const missing = [...libAliases].filter((x) => !edgeAliases.has(x));
  const extra = [...edgeAliases].filter((x) => !libAliases.has(x));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    "FOOD_TABLE alias drift between lib/food-nutrition.mjs and the agent edge fn");
}

// Serving sizes must be mirrored too. gramsPerUnit/mlPerUnit is what turns
// "500ml curd" into 300 kcal instead of a single 150g katori; a value present in
// lib but missing from the edge would price the same meal two different ways
// depending on whether the browser or the server did the arithmetic.
{
  const servingsOf = (text) => {
    const out = {};
    for (const m of text.matchAll(/\{ key: "([^"]+)",[^}]*?\}/g)) {
      const g = /gramsPerUnit:\s*(\d+)/.exec(m[0]);
      const ml = /mlPerUnit:\s*(\d+)/.exec(m[0]);
      if (g || ml) out[m[1]] = `${g ? g[1] : "-"}/${ml ? ml[1] : "-"}`;
    }
    return out;
  };
  const libServ = servingsOf(readFileSync("lib/food-nutrition.mjs", "utf8"));
  const edgeServ = servingsOf(block);
  assert.deepEqual(edgeServ, libServ,
    "gramsPerUnit/mlPerUnit drift between lib/food-nutrition.mjs and the agent edge fn");
  assert.ok(libServ.curd, "curd must carry a serving size - a stated volume was being dropped");
}

rmSync(dir, { recursive: true, force: true });
console.log(`food-nutrition mirror parity passed: ${CORPUS.length} captures agree lib↔edge`);
