// Deterministic everyday-food nutrition: the lookup table must give realistic
// macros for common foods (no more "coffee + 5 cookies = 10g protein") and must
// punt unusual foods to the model instead of inventing numbers.

import assert from "node:assert";
import { estimateNutrition, FOOD_TABLE } from "../lib/food-nutrition.mjs";

function approx(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual}, expected ~${expected} (±${tol})`);
}

// --- the exact case the user hit ---
{
  const r = estimateNutrition("coffee and 5 cookies");
  assert.ok(r.recognized, "coffee + cookies should be fully recognized by the table");
  // 1 milk coffee (~2g) + 5 cookies (~0.7g each = 3.5g) -> ~5.5g protein, NOT 10g.
  approx(r.totals.protein_g, 5.5, 2.5, "coffee+5 cookies protein");
  assert.ok(r.totals.protein_g < 9, "coffee + 5 cookies must be well under 10g protein");
  approx(r.totals.calories, 335, 60, "coffee+5 cookies calories");
  const cookie = r.items.find((i) => i.key === "cookie");
  assert.equal(cookie.qty, 5, "must count 5 cookies");
}

// "5 choc chip cookies" — number separated from the food by modifier words.
{
  const r = estimateNutrition("5 choc chip cookies");
  const cookie = r.items.find((i) => i.key === "cookie");
  assert.ok(cookie, "choc chip cookies must map to the cookie entry");
  assert.equal(cookie.qty, 5, "5 choc chip cookies -> qty 5");
  assert.ok(r.recognized, "should be recognized");
}

// 2 eggs + 2 rotis
{
  const r = estimateNutrition("2 eggs and 2 rotis");
  assert.ok(r.recognized, "eggs + rotis recognized");
  const egg = r.items.find((i) => i.key === "egg");
  const roti = r.items.find((i) => i.key === "roti");
  assert.equal(egg.qty, 2, "2 eggs");
  assert.equal(roti.qty, 2, "2 rotis");
  // 2*72 + 2*110 = 364
  approx(r.totals.calories, 364, 20, "2 eggs 2 rotis calories");
  // 2*6.3 + 2*3.5 = 19.6
  approx(r.totals.protein_g, 19.6, 1, "2 eggs 2 rotis protein");
}

// "egg curry, just ate 2 eggs and 2 rotis" — the dish name mentions "egg" too,
// but the explicit "2 eggs" must win (no double counting to 3 eggs).
{
  const r = estimateNutrition("egg curry, just ate 2 eggs and 2 rotis");
  const egg = r.items.find((i) => i.key === "egg" || i.key === "egg curry");
  assert.ok(egg, "should match an egg dish");
  // Whatever egg entry is chosen, eggs must be counted as 2 (explicit), not inflated.
  const eggCount = r.items.find((i) => i.key === "egg");
  if (eggCount) assert.equal(eggCount.qty, 2, "explicit 2 eggs must win over bare 'egg curry'");
  // Filler words (just, ate, today, curry) must NOT become unknown foods.
  assert.deepEqual(r.unknown, [], `no unknown foods expected, got ${JSON.stringify(r.unknown)}`);
}

// "3 rotis dal sabzi" — number binds to the nearest following food only.
{
  const r = estimateNutrition("3 rotis dal sabzi");
  const roti = r.items.find((i) => i.key === "roti");
  const dal = r.items.find((i) => i.key === "dal");
  const sabzi = r.items.find((i) => i.key === "sabzi");
  assert.equal(roti.qty, 3, "3 rotis");
  assert.equal(dal.qty, 1, "dal qty defaults to 1");
  assert.equal(sabzi.qty, 1, "sabzi qty defaults to 1");
}

// gram-based food scales by grams
{
  const r = estimateNutrition("100g paneer");
  const paneer = r.items.find((i) => i.key === "paneer");
  assert.ok(paneer, "paneer recognized");
  approx(paneer.protein_g, 18, 1, "100g paneer ~18g protein");
  const r2 = estimateNutrition("200g paneer");
  const paneer2 = r2.items.find((i) => i.key === "paneer");
  approx(paneer2.protein_g, 36, 2, "200g paneer ~36g protein");
}

// ml-based food scales by ml
{
  const r = estimateNutrition("500 ml milk");
  const milk = r.items.find((i) => i.key === "milk");
  assert.ok(milk, "milk recognized");
  approx(milk.protein_g, 16, 2, "500ml milk ~16g protein (2 glasses)");
}

// unusual / non-everyday food -> NOT recognized -> caller uses the model
{
  const r = estimateNutrition("dragon fruit poke bowl with quinoa");
  assert.equal(r.recognized, false, "exotic food must NOT be recognized (model handles it)");
  assert.ok(r.unknown.length > 0, "unknown foods must be surfaced for the model");
}

// mixed: a known food + an unknown food -> not fully recognized
{
  const r = estimateNutrition("2 rotis and some kimchi");
  assert.ok(r.items.find((i) => i.key === "roti"), "roti still parsed");
  assert.equal(r.recognized, false, "presence of unknown 'kimchi' blocks table-authoritative");
  assert.ok(r.unknown.includes("kimchi"), "kimchi surfaced as unknown");
}

// empty / non-food input
{
  const r = estimateNutrition("");
  assert.equal(r.recognized, false);
  assert.equal(r.items.length, 0);
  assert.equal(r.totals.calories, 0);
}

// number words
{
  const r = estimateNutrition("two boiled eggs");
  const egg = r.items.find((i) => i.key === "egg");
  assert.equal(egg.qty, 2, "'two' -> 2 eggs");
}

// table sanity: no entry has absurd macros
{
  for (const e of FOOD_TABLE) {
    assert.ok(e.calories >= 0 && e.calories <= 700, `${e.key} calories in range`);
    assert.ok(e.protein_g >= 0 && e.protein_g <= 35, `${e.key} protein in range`);
    assert.ok(Array.isArray(e.aliases) && e.aliases.length >= 1, `${e.key} has aliases`);
    assert.ok(["count", "gram", "ml"].includes(e.kind), `${e.key} has a valid kind`);
  }
}

console.log("food-nutrition.test.mjs: all assertions passed");
