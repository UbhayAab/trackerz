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

// "5 choc chip cookies" - number separated from the food by modifier words.
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

// "egg curry, just ate 2 eggs and 2 rotis" - the dish name mentions "egg" too,
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

// "3 rotis dal sabzi" - number binds to the nearest following food only.
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

// Table sanity: catch a misplaced digit, not a big meal.
//
// The ceiling was 700, which a real single-item restaurant dish clears without
// help - a burrito is 900. Raised to 1000, which still catches the failure this
// guard exists for (265 typed as 2650, the class behind the 100x calorie bug)
// while letting an honest large dish be honest. Anything above 1000 for ONE
// serving is a data-entry error, not a meal.
{
  for (const e of FOOD_TABLE) {
    assert.ok(e.calories >= 0 && e.calories <= 1000, `${e.key} calories in range (${e.calories})`);
    // The ceiling is per UNIT, and the unit differs by kind. A "count" entry is
    // one serving, where 35 g of protein is already a large plate. A "gram" entry
    // is priced per 100 g of the raw food, and dry high-protein staples genuinely
    // exceed 35: soya chunks are 52 g per 100 g, which is the real number and the
    // reason this assertion first fired. Capping both at 35 would force a
    // knowingly wrong figure into the table to keep a test quiet.
    const ceiling = e.kind === "gram" ? 90 : 35;
    assert.ok(e.protein_g >= 0 && e.protein_g <= ceiling,
      `${e.key} protein in range (${e.protein_g} g per ${e.unit}, ceiling ${ceiling})`);
    assert.ok(Array.isArray(e.aliases) && e.aliases.length >= 1, `${e.key} has aliases`);
    assert.ok(["count", "gram", "ml"].includes(e.kind), `${e.key} has a valid kind`);
  }
}

// ORDER MANIFEST (regression, 2026-07-28). This exact capture was filed as a
// diet NOTE and logged zero calories. All three failure modes are asserted here:
// the sugar-free reroute, the trailing "x N" count, and the bracketed pack size.
{
  const order = [
    "Coca Cola Zero Sugar Soft Drink Can (300 ml) × 3",
    "Eat Better Co Ragi Chips, Achari Masti (55 g) × 1",
    "Eat Better Co Ragi Chips, Thai Chilli Tadka (55 g) × 1",
  ].join("\n");
  const r = estimateNutrition(order);
  assert.equal(r.recognized, true, "a brand/pack/x-N order manifest is fully priceable");
  assert.deepEqual(r.unknown, [], "a bracketed pack size is not an unknown food");

  const drink = r.items.find((i) => i.key === "diet soft drink");
  assert.ok(drink, "zero-sugar cola routes to the diet row, not the 140 kcal one");
  assert.equal(drink.qty, 3, "the trailing 'x 3' is the can count");
  assert.ok(drink.calories < 20, `3 zero-sugar cans must not cost 420 kcal (got ${drink.calories})`);
  assert.equal(r.items.find((i) => i.key === "soft drink"), undefined, "no full-sugar row double-counted");

  const chips = r.items.find((i) => i.key === "millet chips");
  assert.ok(chips, "ragi chips are priced as millet chips, not fried potato chips");
  assert.equal(chips.qty, 2, "two separate 'x 1' lines are two packs, not one");
}

// The reroute must not fire on a genuinely sugared drink.
{
  assert.equal(estimateNutrition("coke").totals.calories, 140, "plain coke keeps its sugar");
  assert.equal(estimateNutrition("2 coke").totals.calories, 280);
  assert.ok(estimateNutrition("coke zero").totals.calories < 10, "coke zero does not");
  assert.ok(estimateNutrition("diet pepsi").totals.calories < 10);
}

// Measure-word plurals are not foods ("2 scoops whey" lost its macros to "scoops").
{
  const r = estimateNutrition("2 scoops whey");
  assert.equal(r.recognized, true, "'scoops' is a measure word, not an unknown food");
  assert.equal(r.totals.protein_g, 48, "2 scoops of whey is 48 g protein");
}

// A standalone "x N" must not swallow a word that merely ends in x.
{
  const r = estimateNutrition("box 8");
  assert.equal(r.items.length, 0, "'box 8' names no food and invents no count");
}

console.log("food-nutrition.test.mjs: all assertions passed");

// ---------------------------------------------------------------------------
// A stated weight or volume must not be silently swallowed.
//
// `curd` is kind:"count" with a katori serving, and it carried no gramsPerUnit,
// so multiplier() fell back to ONE serving no matter what quantity was said.
// The table's totals then OVERRIDE the model (CLAUDE.md), so the fallback won.
// Measured on the owner's real 2026-07-25 row:
//
//   "6 boiled eggs and 500ml curd" -> 522 kcal / 42.8g protein
//
// which is 6 eggs plus a single 150g katori - half a litre of curd charged as
// one small bowl, costing ~12g of protein on the exact metric he is short on.
// ---------------------------------------------------------------------------
{
  const curd = estimateNutrition("500ml curd");
  assert.equal(curd.recognized, true, "500ml curd is fully known");
  assert.ok(curd.totals.protein_g > 15,
    `500ml curd must scale past one katori, got ${curd.totals.protein_g}g protein`);
  assert.ok(curd.totals.calories > 250 && curd.totals.calories < 350,
    `500ml curd should be ~300 kcal, got ${curd.totals.calories}`);

  // A plain mention still means one serving - scaling must not invent quantity.
  const plain = estimateNutrition("curd");
  assert.equal(plain.totals.calories, 90, "a bare mention is still one katori");

  // The real row.
  const real = estimateNutrition("6 boiled eggs and 500ml curd");
  assert.ok(real.totals.protein_g > 50,
    `the 2026-07-25 capture should price above 50g protein, got ${real.totals.protein_g}`);

  // The 100x guard this must NOT reopen: a weighed count food never multiplies
  // servings by the raw gram number.
  const rice = estimateNutrition("250 g rice");
  assert.ok(rice.totals.calories < 600,
    `250g rice must not become 250 katoris, got ${rice.totals.calories} kcal`);

  // And where the table still cannot convert a stated weight, it must SAY so
  // rather than assert one serving - recognized:false hands pricing to the model.
  const momos = estimateNutrition("120g momos");
  assert.deepEqual(momos.unscaled, ["momo"], "an unconvertible weight is reported");
  assert.equal(momos.recognized, false,
    "an unconvertible weight must not let the table override the model");
}

// --- the roll shop, and the composite that reported false confidence ---------
//
// Locks the 2026-08-23 backfill. Three days of the owner's meals were rolls, and
// the table knew neither the word "roll" nor the fried paratha every roll is
// wrapped in, so a dictated meal priced at less than half of itself.
{
  // The exact sentence, in the exact words voice capture produces. "pani roll"
  // has to reach paneer: "pani" alone is the STOPWORD for water, so without the
  // alias the paneer vanished silently and only a bare "roll" was left unknown.
  for (const said of ["2 pani rolls and 1 double egg roll", "2 paneer rolls and 1 double egg roll"]) {
    const r = estimateNutrition(said);
    assert.equal(r.recognized, true, `"${said}" must be fully priced by the table`);
    assert.deepEqual(
      r.items.map((i) => `${i.key} x${i.qty}`).sort(),
      ["double egg roll x1", "paneer roll x2"],
      `"${said}" is two paneer rolls and ONE double-egg roll`,
    );
    // The regression in one number: this meal used to price at 602 kcal, because
    // both wraps were missing and the filling was read as 200 g of loose paneer.
    assert.ok(r.totals.calories > 1200,
      `"${said}" must count both wraps, got ${r.totals.calories} kcal`);
    assert.ok(r.totals.protein_g < 60,
      `a roll holds ~60g paneer, not 200g - got ${r.totals.protein_g}g protein`);
  }

  // "double" and "triple" count the EGGS, not the rolls. One double egg roll is
  // ONE wrap, so it must not price as two whole rolls.
  const single = estimateNutrition("1 egg roll").totals.calories;
  const dbl = estimateNutrition("1 double egg roll").totals.calories;
  assert.ok(dbl > single && dbl < single * 2,
    `a double egg roll is one wrap with an extra egg, got ${dbl} vs ${single}`);
  assert.ok(estimateNutrition("1 triple egg roll").totals.calories > dbl,
    "a triple egg roll carries more than a double");

  // The one that matched nothing at all and priced at zero.
  const aloo = estimateNutrition("1 potato roll");
  assert.equal(aloo.recognized, true, "a potato roll is an aloo roll");
  assert.ok(aloo.totals.calories > 300, `an aloo roll is not free, got ${aloo.totals.calories}`);

  // TOMATO RICE - the worst shape of gap, because it reported full confidence.
  // "tomato" + "rice" matched as two foods, so recognized came back TRUE and an
  // authoritative 228 kcal overrode the model: plain boiled rice with a raw
  // tomato beside it, every gram of the tempering's fat missing.
  const tr = estimateNutrition("tomato rice");
  assert.deepEqual(tr.items.map((i) => i.key), ["tomato rice"],
    "tomato rice is one dish, not a tomato next to some rice");
  assert.ok(tr.totals.fat_g >= 8,
    `tomato rice is fried in oil, got ${tr.totals.fat_g}g fat`);

  // No bare "roll": an unqualified roll is genuinely ambiguous, and the table's
  // totals OVERRIDE the model, so guessing here would beat the model's guess.
  assert.equal(estimateNutrition("1 roll").recognized, false,
    "a roll with no filling named must be handed to the model, not priced");
}

// --- no two foods may claim the same alias -----------------------------------
//
// Two entries sharing an alias is decided by TABLE ORDER: ALIAS_INDEX sorts by
// word count then length, and V8's sort is stable, so the entry written earlier
// in the file silently wins. Reordering the file would then move a meal's macros
// without anyone touching a number.
//
// This was not hypothetical. The 2026-08-14 Burger King entry claimed "paneer
// roll" and "paneer kathi roll", and the 2026-08-23 roll shop claimed them too;
// git merged the two additions cleanly because they are in different parts of the
// file, and nothing at all would have reported the clash.
{
  // KNOWN, PRE-EXISTING, and deliberately not fixed here: `aloo bhujia` (gram-
  // kind, 570 kcal/100 g) and `namkeen` (count-kind, 150 kcal/30 g serving) both
  // claim these four. `aloo bhujia` is written first, so it wins, and a bare
  // "namkeen" prices at 570 rather than 150 - a ~4x error. Deciding which of the
  // two is the right reading changes how rows already in the DB were priced, so
  // it needs an owner's call, not a silent edit inside an unrelated change.
  const KNOWN = new Set(["namkeen", "mixture", "sev", "bhujia"]);

  const owner = new Map();
  const clashes = [];
  for (const entry of FOOD_TABLE) {
    for (const alias of entry.aliases) {
      const key = String(alias).toLowerCase().trim();
      if (owner.has(key)) clashes.push(`"${key}" claimed by both ${owner.get(key)} and ${entry.key}`);
      else owner.set(key, entry.key);
    }
  }
  const fresh = clashes.filter((c) => !KNOWN.has(c.split('"')[1]));
  assert.deepEqual(fresh, [],
    `two foods may not claim the same alias - table order would decide it silently:\n  ${fresh.join("\n  ")}`);

  // The specific one this change resolved: the roll shop owns the roll names, the
  // Burger King entry owns the wrap names.
  assert.equal(owner.get("paneer roll"), "paneer roll", "a paneer roll is the street roll");
  assert.equal(owner.get("paneer wrap"), "paneer wrap", "a paneer wrap is the BK wrap");
  // And they really are different foods, so the distinction has to survive.
  assert.notEqual(
    estimateNutrition("1 paneer roll").totals.calories,
    estimateNutrition("1 paneer wrap").totals.calories,
    "the wrap and the roll must not collapse into one number",
  );
}
