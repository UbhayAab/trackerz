// The prep card may only ever say things that are on tomorrow's actual plan.
//
// The bug this locks shut: `prepForTomorrow()` was a hardcoded template that
// asked the owner to chill hung curd every night for months after they stopped
// eating it. It survived the phantom-meal fix because it lived one section
// further down the page and nobody looked at it.

import assert from "node:assert/strict";
import { prepFromMeals } from "../lib/diet-prep.mjs";

// ---- the headline rule: nothing appears that is not in the meals ----
{
  const meals = [
    { name: "Whey protein with curd", slot: "breakfast" },
    { name: "Grilled chicken and salad", slot: "lunch" },
  ];
  const prep = prepFromMeals(meals);
  const text = prep.map((p) => p.text).join(" ").toLowerCase();
  // The five sentences the old hardcoded list produced, none of which are in
  // these meals. Every one of them must be absent.
  for (const ghost of ["soybean", "hung curd", "guava", "banana", "paneer", "egg white"]) {
    assert.ok(!text.includes(ghost), `prep invented "${ghost}" from meals that never mention it`);
  }
  // And what IS in the meals may legitimately appear.
  assert.ok(text.includes("curd"), "curd is on the plan and needs setting overnight, so it should appear");
}

// ---- an empty plan produces an empty list, never a default one ----
assert.deepEqual(prepFromMeals([]), []);
assert.deepEqual(prepFromMeals(null), []);
assert.deepEqual(prepFromMeals(undefined), []);
assert.deepEqual(prepFromMeals([{ name: "" }, { name: "   " }]), []);

// ---- a plan of things that need no prep says nothing ----
{
  const prep = prepFromMeals([
    { name: "Apple" }, { name: "Black coffee" }, { name: "Grilled paneer wrap" },
  ]);
  assert.equal(prep.length, 0, `expected silence, got: ${JSON.stringify(prep)}`);
}

// ---- real prep is found, and traced back to its meal ----
{
  const prep = prepFromMeals([
    { name: "Soybean curry with rice", slot: "lunch" },
    { name: "Chia pudding", slot: "snack" },
  ]);
  const ids = prep.map((p) => p.id);
  assert.equal(prep.length, 2, JSON.stringify(prep));
  assert.ok(ids.some((i) => i.includes("soak-legumes")));
  assert.ok(ids.some((i) => i.includes("soak-chia")));
  // Every line names the meal it came from, so an instruction whose origin the
  // owner cannot see is impossible by construction.
  for (const p of prep) assert.ok(p.from && p.from.length, `no provenance on ${p.text}`);
  assert.equal(prep.find((p) => p.id.includes("chia")).from, "Chia pudding");
}

// ---- the same job across two meals is ONE line ----
{
  const prep = prepFromMeals([
    { name: "Soybean curry", slot: "lunch" },
    { name: "Soybean salad", slot: "dinner" },
  ]);
  assert.equal(prep.length, 1, "soybeans at lunch and dinner is one soaking job, not two");
}

// ---- plain strings work too, since plan rows are not always objects ----
{
  const prep = prepFromMeals(["4 boiled eggs", "Rajma chawal"]);
  assert.equal(prep.length, 2);
  assert.ok(prep.some((p) => /boil/i.test(p.text)));
  assert.ok(prep.some((p) => /soak/i.test(p.text) && /rajma/i.test(p.text)));
}

// ---- the deleted template must not come back ----
{
  const src = await import("node:fs").then((fs) => fs.readFileSync("lib/diet-scaffold.mjs", "utf8"));
  assert.ok(!/export function prepForTomorrow/.test(src),
    "the hardcoded prep template is back in lib/diet-scaffold.mjs");
  // The specific food that made the owner notice. A comment explaining the
  // deletion is fine; an exported list containing it is not.
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/hung curd/i.test(code), "hung curd is back in scaffold CODE, not just in a comment");
}

console.log("diet-prep tests passed: prep is derived from real meals, invents nothing, and stays silent when there is nothing to do");
