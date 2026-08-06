// DIFF CARD - "here is what this will change", at 320 px, before it changes.
import assert from "node:assert/strict";
import {
  diffRowsFor, renderDiffCard, bindDiffCard, planChangePreview,
} from "../src/ui/diff-card.js";

const base = () => ({
  meals: [
    { name: "Shake", slot: "breakfast", calories: 300, protein_g: 30 },
    { name: "Lunch bowl", slot: "lunch", calories: 500, protein_g: 40 },
    { name: "Banana", slot: "snack", calories: 105, protein_g: 1 },
  ],
  targets: { calories: 2200, protein_g: 150, fiber_g: 47 },
});

// ---- diffRowsFor -----------------------------------------------------------
// LEAD WITH THE AGGREGATE: what matters is that the day went from 905 to 1105
// kcal; the meal-by-meal list is the supporting detail.
{
  const after = { ...base(), meals: [...base().meals, { name: "Salad bowl", slot: "snack", calories: 200, protein_g: 10 }] };
  const rows = diffRowsFor(base(), after);
  assert.equal(rows[0].aggregate, true, "the first row is an aggregate");
  assert.equal(rows[0].label, "Calories (day total)");
  assert.equal(rows[0].from, "905 kcal");
  assert.equal(rows[0].to, "1105 kcal");
  assert.equal(rows[1].label, "Protein (day total)");
  const added = rows.find((r) => r.label === "Salad bowl");
  assert.equal(added.verb, "+");
  assert.match(added.to, /200 kcal/);
  // No unchanged lines anywhere.
  assert.ok(!rows.some((r) => r.label === "Shake"), "an unchanged meal is not a row");
  assert.ok(rows.every((r) => ["+", "-", "~"].includes(r.verb)), "only + - ~");
}

// A removal, and a target that did NOT move with it (targets are goals now).
{
  const after = { ...base(), meals: base().meals.filter((m) => m.name !== "Banana") };
  const rows = diffRowsFor(base(), after);
  const dropped = rows.find((r) => r.label === "Banana");
  assert.equal(dropped.verb, "-");
  assert.ok(!rows.some((r) => r.key === "targets.calories"), "the calorie target did not move");
  assert.equal(rows[0].to, "800 kcal");
}

// A changed meal is `~`, not a remove+add pair - keyed by name so a reordered
// list is not reported as six changes.
{
  const after = { ...base(), meals: base().meals.map((m) => (m.name === "Lunch bowl" ? { ...m, calories: 620 } : m)) };
  const rows = diffRowsFor(base(), after);
  const changed = rows.filter((r) => r.label === "Lunch bowl");
  assert.equal(changed.length, 1);
  assert.equal(changed[0].verb, "~");
  assert.match(changed[0].from, /500 kcal/);
  assert.match(changed[0].to, /620 kcal/);
}
{
  const shuffled = { ...base(), meals: [...base().meals].reverse() };
  assert.deepEqual(diffRowsFor(base(), shuffled), [], "reordering changes nothing");
}

// Scalars: targets, workout fields.
{
  const rows = diffRowsFor(base(), { ...base(), targets: { ...base().targets, calories: 1800 } });
  const target = rows.find((r) => r.key === "targets.calories");
  assert.equal(target.label, "Calorie target");
  assert.equal(target.verb, "~");
  assert.equal(target.from, "2200");
  assert.equal(target.to, "1800");
}
{
  const gymBefore = { name: "Workout A", kind: "gym", duration_min: 50, items: ["Leg press 2×12", "Bench 2×10"] };
  const gymAfter = { name: "Cardio", kind: "cardio", duration_min: 40, items: ["30 min treadmill"] };
  const rows = diffRowsFor(gymBefore, gymAfter);
  assert.ok(rows.some((r) => r.verb === "+" && r.label === "30 min treadmill"));
  assert.ok(rows.some((r) => r.verb === "-" && r.label === "Bench 2×10"));
  assert.ok(rows.some((r) => r.key === "name" && r.to === "Cardio"));
}
assert.deepEqual(diffRowsFor(base(), base()), [], "identical documents produce no rows");
assert.deepEqual(diffRowsFor(null, null), [], "nulls are survivable");

// ---- ONE computation feeds the preview AND the write ------------------------
// planChangePreview folds the delta ONCE and hands the same `after` object to the
// diff and to the caller that writes it, so what was approved and what lands
// cannot disagree. Same discipline as ingestStatements().
{
  const preview = planChangePreview("diet", base(), { op: "add_meal", meal: { name: "Curd", slot: "snack", calories: 120, protein_g: 11 } });
  assert.equal(preview.applied, true);
  assert.equal(preview.after.meals.length, 4);
  assert.deepEqual(preview.rows, diffRowsFor(preview.before, preview.after), "the rows ARE the diff of what will be written");
  assert.equal(preview.rows[0].to, "1025 kcal");
}
{
  // A REFUSED delta previews as no change at all, and says why - the card must
  // never show a change the write is going to decline to make.
  const twoBowls = { ...base(), meals: [...base().meals, { name: "Salad bowl", slot: "snack", calories: 200, protein_g: 10 }] };
  const refused = planChangePreview("diet", twoBowls, { op: "remove_meal", match: "bowl" });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, "ambiguous_match");
  assert.equal(refused.matched_count, 2);
  assert.deepEqual(refused.rows, [], "nothing to show, because nothing will change");
}
{
  // A FULL payload (not a delta) previews as a wholesale replacement.
  const full = planChangePreview("diet", base(), { meals: [{ name: "Only", slot: "lunch", calories: 400 }], targets: { calories: 400 } });
  assert.equal(full.applied, true);
  assert.ok(full.rows.some((r) => r.verb === "-" && r.label === "Shake"));
}

// ---- renderDiffCard --------------------------------------------------------
{
  const many = Array.from({ length: 9 }, (_, i) => ({ verb: "+", key: `m${i}`, label: `Meal ${i}`, from: "", to: `${i * 10} kcal` }));
  const html = renderDiffCard(many, { title: "Update your diet plan", summary: "Permanent change" });

  // NEVER a table. Three columns do not fit at 320 px.
  assert.ok(!/<table/i.test(html), "a diff card is never a table");
  // Five rows visible, the rest behind an expander.
  assert.equal((html.match(/class="settings-row diff-row/g) || []).length, 9, "all rows are rendered");
  assert.ok(html.includes("+4 more"), "the overflow is an expander, not a scroll");
  assert.ok(/<div class="diff-more" hidden/.test(html), "the overflow starts collapsed");
  // Reuses the existing panel/row classes - no new CSS layer needed.
  assert.ok(html.includes("command-panel"));
  assert.ok(html.includes("settings-row"));
  // Sticky footer, both buttons >= 44 px, one tap each.
  assert.ok(html.includes("position:sticky"));
  assert.equal((html.match(/min-height:44px/g) || []).length, 3, "two actions + the expander");
  assert.ok(html.includes('data-diff-act="confirm"'));
  assert.ok(html.includes('data-diff-act="cancel"'));
  assert.ok(!/are you sure/i.test(html), "no second confirmation");
}
{
  // Old value struck through and dimmed; the two-line stack, not a row.
  const html = renderDiffCard([{ verb: "~", key: "targets.calories", label: "Calorie target", from: "2200", to: "1800" }]);
  assert.ok(/<s class="diff-old" style="opacity:\.55">2200<\/s>/.test(html), "old is struck and dimmed");
  assert.ok(html.includes("→"));
  assert.ok(html.includes("flex-direction:column"), "label above the change, not beside it");
}
{
  const empty = renderDiffCard([]);
  assert.ok(empty.includes("Nothing would change."));
  assert.ok(!empty.includes('data-diff-act="confirm"'), "nothing to confirm when nothing changes");
}
// Escaping: a plan can carry anything the user pasted.
{
  const html = renderDiffCard([{ verb: "+", key: "x", label: '<img src=x onerror="alert(1)">', from: "", to: "ok" }]);
  assert.ok(!html.includes("<img"), "labels are escaped");
  assert.ok(html.includes("&lt;img"));
}

// ---- bindDiffCard ----------------------------------------------------------
// A tiny DOM stub - these tests run in Node, and the whole point of the binding
// is that it fires each handler AT MOST ONCE.
{
  function stubCard(actions) {
    let handler = null;
    const buttons = actions.map((act) => ({ act, disabled: false, getAttribute: () => act, remove() { this.removed = true; } }));
    return {
      buttons,
      addEventListener: (_type, fn) => { handler = fn; },
      removeEventListener: () => { handler = null; },
      querySelectorAll: () => buttons,
      querySelector: (sel) => (sel === ".diff-more" ? { hidden: true } : null),
      click(act) {
        const btn = buttons.find((b) => b.act === act);
        handler?.({ target: { closest: (sel) => (sel === "[data-diff-act]" ? btn : null) } });
      },
    };
  }

  let confirms = 0;
  let cancels = 0;
  const card = stubCard(["confirm", "cancel", "expand"]);
  const off = bindDiffCard(card, { onConfirm: () => { confirms += 1; }, onCancel: () => { cancels += 1; } });

  card.click("expand");
  assert.equal(confirms + cancels, 0, "expanding is not a decision");
  assert.equal(card.buttons.find((b) => b.act === "expand").removed, true);

  card.click("confirm");
  assert.equal(confirms, 1);
  // A double tap on confirm is how one plan change becomes two rows.
  card.click("confirm");
  card.click("cancel");
  assert.equal(confirms, 1, "confirm fires at most once");
  assert.equal(cancels, 0, "and cancel cannot follow it");
  assert.ok(card.buttons.every((b) => b.act === "expand" || b.disabled), "buttons disable on the first tap");

  assert.equal(typeof off, "function");
  off();
  assert.doesNotThrow(() => bindDiffCard(null, {}), "a missing root is survivable");
}

console.log("diff-card tests passed");
