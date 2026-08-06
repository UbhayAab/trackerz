// AMENDING A LOG THAT ALREADY EXISTS.
//
// The owner's case, in his words: "in the afternoon I said that I ate thirty
// grams of aloo bhujia, but then I remember later on that actually it was fifty
// grams. So I just type it in the text... update the thirty gram to fifty gram."
//
// Four things are under test, and each of them is a way this feature destroys
// data if it is wrong:
//
//   1. THE DATE. An undated amendment means TODAY and can never reach further
//      back; a dated one resolves in the user's zone, not UTC.
//   2. THE ROW. One row inside that window, a question, or nothing - never a
//      nearest-neighbour guess and never a row on another day.
//   3. THE WRITE. Only allowed columns, only changed ones, with the before-image
//      recorded so the undo can put it back.
//   4. THE CONTROLS. An ordinary new food log must still be an INSERT. A feature
//      that quietly converts new logs into edits is far worse than not having it,
//      so those cases are the last section and they are not optional.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AMEND_CUE, DELETE_CUE, AMENDABLE_COLUMNS, AMEND_WINDOW_MAX_DAYS, MAX_DELETES_PER_DAY,
  looksLikeAmendment, looksLikeDeletion,
  amendKindOf, amendTableFor, amendValues,
  parseWhenPhrase, resolveAmendWindow, amendInWindow,
  resolveAmendTarget, describeAmendCandidate, amendWritePlan,
  deleteBudget, AMBIGUITY_MARGIN,
} from "../lib/amend-target.mjs";
import { buildWindowWorld, resolveReferent } from "../lib/referent-resolver.mjs";
import { saDayKey, SA_DEFAULT_TZ } from "../lib/schedule-args.mjs";
import { dayKeyInTz, addDays } from "../lib/tz.mjs";
import { estimateNutrition } from "../lib/food-nutrition.mjs";
import { mutationTier, mutationGate, mutationRisk } from "../lib/mutation-risk.mjs";
import { invert, normalizeUndoPayload, isUndoable } from "../lib/undo-ledger.mjs";
import { buildRowForTool } from "../src/services/action-applier.js";
import { amendDiffRows, renderAmendCard, renderAmendChooser } from "../src/ui/diff-card.js";
import { expandToolCalls } from "../lib/fan-out-expander.mjs";

// 2026-08-06 is a THURSDAY. Every expectation below is anchored to that.
const TODAY = "2026-08-06";
const TZ = SA_DEFAULT_TZ;
const at = (day, h, m = 0) => `${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`;

// ---------------------------------------------------------------------------
// 0. THE MIRROR. The edge function resolves amendments, so a drifted copy there
//    means the server edits a different row than the card the user approved.
// ---------------------------------------------------------------------------
{
  const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
  const sync = readFileSync("scripts/sync-mirror.mjs", "utf8");
  const block = (src, file, startMark, endMark) => {
    const start = src.indexOf(startMark);
    const end = src.indexOf(endMark);
    assert.ok(start !== -1 && end !== -1 && end > start, `${startMark} markers missing in ${file}`);
    return src.slice(src.indexOf("\n", start) + 1, src.lastIndexOf("\n", end) + 1).replace(/\r\n/g, "\n");
  };
  for (const [lib, name] of [
    ["lib/referent-resolver.mjs", "REFERENT-RESOLVER"],
    ["lib/amend-target.mjs", "AMEND-TARGET"],
  ]) {
    assert.equal(
      block(edge, "supabase/functions/agent/index.ts", `${name} MIRROR START`, `${name} MIRROR END`),
      block(readFileSync(lib, "utf8"), lib, `${name} MIRROR START`, `${name} MIRROR END`),
      `DRIFT in the ${name} mirror block: run \`node scripts/sync-mirror.mjs\``,
    );
    assert.ok(sync.includes(`${name} MIRROR START`), `${lib} must be registered in scripts/sync-mirror.mjs`);
  }
  // The edge resolves against ITS OWN zone helpers. tests/schedule-args.test.mjs
  // proves saDayKey agrees with lib/tz.mjs; restate it here because every window
  // in this file is built on that equality, and a silent divergence would move
  // every amendment by up to 5.5 hours.
  for (let h = 0; h < 24; h += 1) {
    const iso = new Date(Date.UTC(2026, 7, 6, h, 30)).toISOString();
    assert.equal(saDayKey(iso, TZ), dayKeyInTz(iso, TZ), `saDayKey vs dayKeyInTz at ${iso}`);
  }
  // The 18:30 UTC boundary is the whole reason lib/tz.mjs exists: an amendment
  // typed at 00:30 IST is the previous UTC day, and a UTC-sliced key would send
  // "today" to yesterday's rows.
  assert.equal(dayKeyInTz("2026-08-06T19:00:00Z", TZ), "2026-08-07");
  assert.equal(saDayKey("2026-08-06T19:00:00Z", TZ), "2026-08-07");
}

// ---------------------------------------------------------------------------
// 1. THE DATE. The hard half.
// ---------------------------------------------------------------------------
{
  const w = (phrase) => parseWhenPhrase(phrase, TODAY);
  const span = (phrase) => { const r = w(phrase); return r ? `${r.fromKey}..${r.toKey}` : null; };

  assert.equal(span("yesterday"), "2026-08-05..2026-08-05");
  assert.equal(span("last night"), "2026-08-05..2026-08-05");
  assert.equal(span("the day before yesterday"), "2026-08-04..2026-08-04");
  assert.equal(span("this morning"), "2026-08-06..2026-08-06");
  assert.equal(span("this afternoon"), "2026-08-06..2026-08-06");
  assert.equal(span("tonight"), "2026-08-06..2026-08-06");
  assert.equal(span("3 days ago"), "2026-08-03..2026-08-03");

  // A weekday resolves BACKWARDS. "on Monday" said on a Thursday is 3 days ago,
  // never the Monday coming - an amendment is always about the past.
  assert.equal(span("on Monday"), "2026-08-03..2026-08-03");
  assert.equal(span("monday"), "2026-08-03..2026-08-03");
  assert.equal(span("last Tuesday"), "2026-08-04..2026-08-04");
  assert.equal(span("saturday"), "2026-08-01..2026-08-01");
  // "on Thursday" said ON a Thursday is today, which is what a person means.
  assert.equal(span("on thursday"), "2026-08-06..2026-08-06");
  // ...but "last Thursday" is strictly before today, so it is a week back.
  assert.equal(span("last thursday"), "2026-07-30..2026-07-30");

  assert.equal(span("on the 3rd"), "2026-08-03..2026-08-03");
  assert.equal(span("2 Aug"), "2026-08-02..2026-08-02");
  assert.equal(span("august 2"), "2026-08-02..2026-08-02");
  assert.equal(span("2nd of August"), "2026-08-02..2026-08-02");
  assert.equal(span("2026-08-02"), "2026-08-02..2026-08-02");
  assert.equal(span("02/08"), "2026-08-02..2026-08-02", "India writes the day first");
  assert.equal(span("02-08-2026"), "2026-08-02..2026-08-02");
  assert.equal(span("last week"), "2026-07-31..2026-08-06");

  // A month/day later in the calendar than today belongs to LAST year.
  assert.equal(parseWhenPhrase("25 December", TODAY).fromKey, "2025-12-25");

  // --- the phrases that must NOT parse as a date -----------------------------
  // Each of these produced a wrong window in an earlier draft, and a wrong
  // window is an amendment applied to a day nobody named.
  assert.equal(w("I sat down and ate"), null, '"sat" is not Saturday');
  assert.equal(w("3-4 rotis"), null, "a range of rotis is not the 3rd of April");
  assert.equal(w("200-300 g curd"), null);
  assert.equal(w("bench 3x10"), null);
  assert.equal(w("actually it was 50g of aloo bhujia not 30g"), null, "no day named at all");
  assert.equal(w(""), null);
}

// ---- the window an amendment actually gets --------------------------------
{
  const win = (args, text = "") => resolveAmendWindow(args, { today: TODAY, tz: TZ, text });

  // AN UNDATED AMENDMENT IS TODAY, AND ONLY TODAY. This is the whole safety
  // story: it can never silently reach into last week because nothing matched.
  const undated = win({ target_ref: "30g aloo bhujia" });
  assert.equal(undated.fromKey, TODAY);
  assert.equal(undated.toKey, TODAY);
  assert.equal(undated.explicit, false);
  assert.equal(undated.via, "default_today");

  // The model's own words win when it gave them.
  assert.equal(win({ when: "yesterday" }).fromKey, "2026-08-05");
  assert.equal(win({ on_date: "2026-07-29" }).fromKey, "2026-07-29");
  // A range, and the cap that stops "last month" from becoming a fishing net.
  const range = win({ date_from: "2026-08-01", date_to: "2026-08-04" });
  assert.equal(`${range.fromKey}..${range.toKey}`, "2026-08-01..2026-08-04");
  assert.equal(win({ date_from: "2026-01-01", date_to: "2026-08-06" }).error, "window_too_wide");
  assert.ok(AMEND_WINDOW_MAX_DAYS <= 31);
  // Reversed dates are a typo, not a reason to search nothing.
  assert.equal(win({ date_from: "2026-08-04", date_to: "2026-08-01" }).fromKey, "2026-08-01");
  // The raw capture text is the LAST fallback, after the model's fields.
  assert.equal(win({ target_ref: "dinner" }, "change yesterday's dinner to 2 rotis").fromKey, "2026-08-05");

  assert.equal(amendInWindow("2026-08-05", { fromKey: "2026-08-05", toKey: "2026-08-05" }), true);
  assert.equal(amendInWindow("2026-08-06", { fromKey: "2026-08-05", toKey: "2026-08-05" }), false);
  assert.equal(amendInWindow(null, { fromKey: "2026-08-05", toKey: "2026-08-05" }), false);
}

// ---------------------------------------------------------------------------
// 2. THE ROW. Resolution over the closed candidate world.
// ---------------------------------------------------------------------------

// The owner's real rows, from the live DB on 2026-08-06.
const bhujia = { id: "f-bhujia", table: "food_logs", description: "30g aloo bhujia and 2 soup sachets", meal_slot: "snack", calories_estimate: 205, protein_g: 4, occurred_at: at(TODAY, 15, 14) };
const eggs = { id: "f-eggs", table: "food_logs", description: "6 whole boiled eggs", meal_slot: "lunch", calories_estimate: 450, protein_g: 36, occurred_at: at(TODAY, 14, 44) };
const coke = { id: "f-coke", table: "food_logs", description: "Coke 0 (Coca-Cola Zero)", meal_slot: "lunch", calories_estimate: 0, protein_g: 0, occurred_at: at(TODAY, 9, 25) };
const yesterdayDinner = { id: "f-dinner", table: "food_logs", description: "70 g soya chunks and 50 g oats", meal_slot: "dinner", calories_estimate: 552, protein_g: 46, occurred_at: at("2026-08-05", 23, 0) };
const mondayGym = { id: "w-mon", table: "workout_logs", description: "gym session, chest and back", duration_min: 40, status: "done", occurred_at: at("2026-08-03", 19, 0) };

const resolve = (targetRef, rows, args = {}, opts = {}) => resolveAmendTarget({
  targetRef,
  rows,
  window: resolveAmendWindow(args, { today: TODAY, tz: TZ, text: opts.text || "" }),
  tz: TZ, today: TODAY,
});

// ---- THE OWNER'S CASE ------------------------------------------------------
{
  const out = resolve("30 g aloo bhujia", [bhujia, eggs, coke], { when: "this afternoon" });
  assert.equal(out.status, "resolved");
  assert.equal(out.row.id, "f-bhujia");
  assert.equal(out.window.fromKey, TODAY);

  // ...and undated, which is what he would actually type.
  const undated = resolve("30 g aloo bhujia", [bhujia, eggs, coke]);
  assert.equal(undated.status, "resolved");
  assert.equal(undated.row.id, "f-bhujia");
}

// ---- an amendment naming a PAST DATE ---------------------------------------
{
  const out = resolve("yesterday's dinner", [yesterdayDinner, bhujia, eggs], { when: "yesterday" });
  assert.equal(out.status, "resolved");
  assert.equal(out.row.id, "f-dinner");

  const gym = resolve("gym session, 40 minutes", [mondayGym], { when: "on Monday" });
  assert.equal(gym.status, "resolved");
  assert.equal(gym.row.id, "w-mon");
  assert.equal(gym.window.fromKey, "2026-08-03");
}

// ---- AN AMENDMENT MUST NOT MATCH A ROW ON A DIFFERENT DAY -------------------
// The single most important case in this file. The row exists, the words match
// perfectly, and it is not in the window - so the answer is "I could not find
// it", never "here is one that looks like it".
{
  const out = resolve("30 g aloo bhujia", [bhujia], { when: "yesterday" });
  assert.equal(out.status, "not_found");
  assert.equal(out.reason, "no_rows_in_window");
  assert.equal(out.window.fromKey, "2026-08-05");

  // The same in the other direction: an UNDATED amendment cannot reach back to
  // a row from three days ago, however well it matches.
  const backwards = resolve("gym session, 40 minutes", [mondayGym]);
  assert.equal(backwards.status, "not_found", "an undated amendment may not reach into Monday");

  // A row inside the window and a row outside it: only the inside one is even a
  // candidate, so the outside one cannot win and cannot make it ambiguous.
  const twinOnAnotherDay = { ...bhujia, id: "f-bhujia-old", occurred_at: at("2026-08-04", 15, 14) };
  const mixed = resolve("30 g aloo bhujia", [bhujia, twinOnAnotherDay], { when: "today" });
  assert.equal(mixed.status, "resolved");
  assert.equal(mixed.row.id, "f-bhujia");
}

// ---- AMBIGUITY: two similar rows on the SAME day ---------------------------
{
  const twin = { ...bhujia, id: "f-bhujia-2", occurred_at: at(TODAY, 18, 40) };
  const out = resolve("aloo bhujia", [bhujia, twin]);
  assert.equal(out.status, "ambiguous", "two rows this similar always ask");
  assert.equal(out.candidates.length, 2);
  assert.equal(out.scores[0], out.scores[1], "an exact tie, and recency did not break it");
  assert.equal(AMBIGUITY_MARGIN, 0.05, "two candidates within 5% is always ambiguous");

  // The chooser names the ROW, with the clock in the user's zone.
  const labels = out.candidates.map((c) => describeAmendCandidate(c, { today: TODAY, tz: TZ }));
  assert.match(labels[0], /aloo bhujia/);
  assert.match(labels.join(" | "), /15:14 today/);
  assert.match(labels.join(" | "), /18:40 today/);
  assert.notEqual(labels[0], labels[1], "two buttons that read identically are not a choice");

  // A candidate on another day is labelled with that day, not "today".
  assert.match(
    describeAmendCandidate(buildWindowWorld([yesterdayDinner], (s) => saDayKey(s, TZ))[0], { today: TODAY, tz: TZ }),
    /yesterday$/,
  );

  const html = renderAmendChooser(labels);
  assert.match(html, /data-amend-choices="2"/);
  assert.equal((html.match(/data-amend-choice=/g) || []).length, 2);
  // Three buttons maximum, whatever arrives.
  assert.equal(
    (renderAmendChooser(["a", "b", "c", "d", "e"]).match(/data-amend-choice=/g) || []).length,
    3,
  );
}

// ---- NOT FOUND is not_found, never a nearest neighbour ---------------------
{
  const out = resolve("the paneer tikka", [bhujia, eggs, coke]);
  assert.equal(out.status, "not_found");
  assert.equal(out.reason, "no_match");
  assert.equal(out.candidates.length, 0, "a not_found offers no consolation guess");

  // An empty day.
  assert.equal(resolve("anything", []).reason, "no_rows_in_window");
  // A window that could not be built at all.
  assert.equal(
    resolveAmendTarget({ targetRef: "x", rows: [bhujia], window: { error: "window_too_wide" }, tz: TZ }).reason,
    "window_too_wide",
  );
}

// ---- the window is enforced HERE too, not only in the query ---------------
// A caller that forgets to filter must not be able to widen the world. The
// closed world is closed by this module, not by the SQL that fed it.
{
  const out = resolveAmendTarget({
    targetRef: "30 g aloo bhujia",
    rows: [bhujia],
    window: { fromKey: "2026-07-01", toKey: "2026-07-02", label: "x", via: "range", explicit: true },
    tz: TZ, today: TODAY,
  });
  assert.equal(out.status, "not_found");
}

// ---------------------------------------------------------------------------
// 3. THE WRITE PLAN.
// ---------------------------------------------------------------------------
{
  const found = resolve("30 g aloo bhujia", [bhujia, eggs, coke]);
  const plan = amendWritePlan({
    name: "amend_log_candidate",
    args: { target_kind: "food", set: { description: "50 g aloo bhujia and 2 soup sachets" } },
    row: found.row,
    estimate: estimateNutrition,
  });
  assert.equal(plan.op, "update");
  assert.equal(plan.table, "food_logs");
  assert.equal(plan.id, "f-bhujia");
  assert.match(plan.values.description, /50 g aloo bhujia/);
  // THE NUTRITION TABLE STILL WINS. A corrected meal is priced exactly as it
  // would have been had the user typed it right the first time.
  const priced = estimateNutrition("50 g aloo bhujia and 2 soup sachets");
  if (priced.recognized) {
    assert.equal(plan.values.calories_estimate, priced.totals.calories);
    assert.equal(plan.values.protein_g, priced.totals.protein_g);
    assert.ok(plan.values.calories_estimate > bhujia.calories_estimate, "50 g is more than 30 g");
  }
  // The before-image covers exactly the columns the write touches.
  assert.deepEqual(Object.keys(plan.before).sort(), [...plan.columns].sort());
  assert.equal(plan.before.description, bhujia.description);

  // The diff card leads with the aggregate that matters.
  const rows = amendDiffRows(plan);
  assert.ok(rows.length);
  assert.equal(rows[0].aggregate, true, "calories lead, the description is supporting evidence");
  assert.equal(rows[0].label, "Calories");
  assert.ok(rows.some((r) => r.label === "Protein"));
  assert.ok(rows.some((r) => r.label === "What" && /30g aloo bhujia/.test(r.from)));
  const card = renderAmendCard(plan);
  assert.match(card, /Change this entry\?/);
  assert.match(card, /diff-old/, "the old value is struck through");
  assert.match(card, /diff-new/);

  // THE SAME OBJECT FEEDS THE PREVIEW AND THE WRITE. Not an equal one - the
  // same one, so they cannot disagree.
  const built = buildRowForTool({ tool_name: "amend_log_candidate", arguments: { _amend: plan } }, "user-1");
  assert.equal(built.row, plan.values);
  assert.equal(built.table, plan.table);
  assert.equal(built.id, plan.id);
  assert.deepEqual(built.columns, plan.columns);
}

// ---- only allowed columns, only changed ones ------------------------------
{
  const v = amendValues("food", {
    description: "2 rotis",
    calories_estimate: "220",
    meal_slot: "DINNER",
    // Everything below must be refused.
    user_id: "someone-else",
    id: "another-row",
    deleted_at: "2026-08-06T00:00:00Z",
    ingestion_id: "x",
    amount: 500,
    protein_g: -5,
    _provenance: "ocr",
  });
  assert.deepEqual(v.values, { description: "2 rotis", calories_estimate: 220, meal_slot: "dinner" });
  // Nothing is discarded silently - the caller can say which field was dropped.
  assert.ok(v.dropped.includes("user_id:not_amendable"));
  assert.ok(v.dropped.includes("id:not_amendable"));
  assert.ok(v.dropped.includes("deleted_at:not_amendable"));
  assert.ok(v.dropped.includes("amount:not_amendable"), "amount is not a food column");
  assert.ok(v.dropped.includes("protein_g:bad_value"), "a negative protein is refused, not clamped");
  assert.ok(!v.dropped.some((d) => d.startsWith("_provenance")), "pipeline metadata is not a field the user asked for");

  // A value out of range is REFUSED rather than clamped: a clamped 50,000-cal
  // meal is a 20,000-cal meal nobody asked for.
  assert.deepEqual(amendValues("food", { calories_estimate: 999999 }).values, {});
  assert.deepEqual(amendValues("money", { amount: 0 }).values, {}, "a zero-rupee expense is not a correction");
  assert.deepEqual(amendValues("workout", { status: "cancelled" }).values, {}, "outside the enum");
  assert.deepEqual(amendValues("workout", { status: "SKIPPED" }).values, { status: "skipped" });
  assert.equal(amendValues("nonsense", { x: 1 }).error, "unknown_kind");

  // Every kind maps to a real soft-deletable table.
  for (const kind of Object.keys(AMENDABLE_COLUMNS)) {
    assert.ok(amendTableFor(kind), `${kind} has no table`);
    for (const col of Object.keys(AMENDABLE_COLUMNS[kind])) {
      assert.ok(!["id", "user_id", "deleted_at", "ingestion_id", "created_at"].includes(col),
        `${kind}.${col} must never be amendable`);
    }
  }
  assert.equal(amendKindOf("diet"), "food");
  assert.equal(amendKindOf("food_logs"), "food");
  assert.equal(amendKindOf("whatever"), null, "an unrecognised kind is null, never a guess at food");
}

// ---- a no-op amendment is not a write --------------------------------------
{
  const plan = amendWritePlan({
    name: "amend_log_candidate",
    args: { target_kind: "food", set: { meal_slot: "snack" } },
    row: bhujia,
  });
  assert.equal(plan.op, "none");
  assert.equal(plan.reason, "no_change");
  // Numerics arrive as strings from node-postgres; "4.00" is not a change to 4.
  assert.equal(
    amendWritePlan({ name: "amend_log_candidate", args: { target_kind: "food", set: { protein_g: 4 } }, row: { ...bhujia, protein_g: "4.00" } }).op,
    "none",
  );
  // No target at all.
  assert.equal(amendWritePlan({ name: "amend_log_candidate", args: { target_kind: "food", set: { description: "x" } }, row: null }).reason, "no_target_row");
}

// ---- DELETE ----------------------------------------------------------------
{
  const found = resolve("coke", [bhujia, eggs, coke]);
  assert.equal(found.status, "resolved");
  assert.equal(found.row.id, "f-coke");

  const plan = amendWritePlan({ name: "delete_log_candidate", args: { target_kind: "food" }, row: found.row });
  assert.equal(plan.op, "soft_delete", "a tombstone, never a removal");
  assert.deepEqual(plan.columns, ["deleted_at"]);
  assert.deepEqual(plan.values, {}, "the timestamp is stamped at write time, not planned");

  const built = buildRowForTool({ tool_name: "delete_log_candidate", arguments: { _amend: plan } }, "user-1");
  assert.equal(built.op, "soft_delete");
  assert.ok(built.row.deleted_at, "the applier stamps the tombstone");

  const card = renderAmendCard(plan);
  assert.match(card, /Delete this entry\?/);
  assert.match(card, /Delete it/);
}

// ---- the per-day delete budget --------------------------------------------
{
  assert.equal(deleteBudget(0).allowed, true);
  assert.equal(deleteBudget(0).remaining, MAX_DELETES_PER_DAY);
  assert.equal(deleteBudget(MAX_DELETES_PER_DAY - 1).allowed, true);
  assert.equal(deleteBudget(MAX_DELETES_PER_DAY).allowed, false);
  assert.equal(deleteBudget(MAX_DELETES_PER_DAY).remaining, 0);
  assert.equal(deleteBudget(999).allowed, false);
  // Fail closed: an unreadable counter is not permission for unlimited deletes.
  assert.equal(deleteBudget(Number.POSITIVE_INFINITY).allowed, false);
  assert.equal(deleteBudget(-5).allowed, true, "a nonsense count does not lock the user out either");
  assert.ok(MAX_DELETES_PER_DAY >= 1 && MAX_DELETES_PER_DAY <= 50);

  // The edge function must actually consult it before resolving a delete.
  const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
  assert.match(edge, /deletesUsedToday\(/, "the edge must count today's deletes");
  assert.match(edge, /budget_exhausted/, "and refuse once the budget is spent");
  assert.match(edge, /if \(error\) return Number\.POSITIVE_INFINITY;/, "an unreadable budget must fail CLOSED");
}

// ---------------------------------------------------------------------------
// 4. UNDO ROUND-TRIP. An amendment that cannot be reversed is a worse app than
//    one that cannot amend.
// ---------------------------------------------------------------------------
{
  const plan = amendWritePlan({
    name: "amend_log_candidate",
    args: { target_kind: "food", set: { calories_estimate: 430, protein_g: 7 } },
    row: bhujia,
  });
  const payload = { v: 2, op: "update", table: plan.table, id: plan.id, before: plan.before, after: plan.values, columns: plan.columns };
  assert.equal(isUndoable(payload), true);
  const step = invert(payload);
  assert.equal(step.op, "update");
  assert.deepEqual(step.values, { calories_estimate: 205, protein_g: 4 });

  // A LATER LEGITIMATE EDIT SURVIVES THE UNDO. This is why an update undo
  // restores only the named columns.
  const rowAfterAmend = { ...bhujia, ...plan.values };
  const rowAfterSomethingElse = { ...rowAfterAmend, description: "50 g aloo bhujia, Haldiram" };
  const restored = { ...rowAfterSomethingElse, ...step.values };
  assert.equal(restored.calories_estimate, 205, "the amendment is reversed");
  assert.equal(restored.description, "50 g aloo bhujia, Haldiram", "and the later edit is NOT clobbered");

  // A delete inverts to a RESTORE, never to a re-insert.
  const delPlan = amendWritePlan({ name: "delete_log_candidate", args: { target_kind: "food" }, row: coke });
  const delPayload = { v: 2, op: "delete", table: delPlan.table, id: delPlan.id, before: delPlan.before, after: null, columns: [] };
  assert.equal(invert(delPayload).op, "restore");
  assert.deepEqual(invert(delPayload).values, { deleted_at: null });
  assert.equal(normalizeUndoPayload(delPayload).op, "delete");
}

// ---------------------------------------------------------------------------
// 5. RISK. Both tools are destructive, gated hard, soft-delete only.
// ---------------------------------------------------------------------------
for (const name of ["amend_log_candidate", "delete_log_candidate"]) {
  assert.equal(mutationTier({ name }), "destructive");
  assert.equal(mutationGate({ name }), "hard", `${name} must never auto-apply`);
  assert.equal(mutationRisk({ name }).softDeleteOnly, true);
  assert.equal(mutationRisk({ name }).undoToastMs, 0, "a hard gate has no undo toast - it has a card");
}

// ---------------------------------------------------------------------------
// 6. THE CUES. Positives, and then the controls.
// ---------------------------------------------------------------------------
{
  const AMENDMENTS = [
    "actually it was 50g of aloo bhujia not 30g",
    "no wait, the aloo bhujia was 50 g not 30 g",
    "change yesterday's dinner to 2 rotis",
    "update the gym session on Monday, it was 60 minutes not 40",
    "the gym session on Monday was 60 minutes not 40",
    "delete the coke I logged this morning",
    "remove that lunch entry",
    "correct my breakfast log - it was 2 eggs",
  ];
  for (const text of AMENDMENTS) {
    assert.equal(looksLikeAmendment(text), true, `should read as an amendment: ${JSON.stringify(text)}`);
  }
  assert.equal(looksLikeDeletion("delete the coke I logged this morning"), true);
  assert.equal(looksLikeDeletion("remove that lunch entry"), true);
  assert.equal(looksLikeDeletion("actually it was 50g not 30g"), false, "a correction is not a deletion");

  // The grounding cues the confirm gate leans on.
  assert.equal(AMEND_CUE.test("actually it was 50g of aloo bhujia not 30g"), true);
  assert.equal(DELETE_CUE.test("delete the coke I logged this morning"), true);
  assert.equal(DELETE_CUE.test("actually it was 50g not 30g"), false);
}

// ---------------------------------------------------------------------------
// 7. THE CONTROLS. NOT OPTIONAL.
//
// A feature that quietly converts new logs into edits is far worse than not
// having it: an amendment that should have been an insert is a meal that never
// gets logged, and nothing anywhere says so. Every line below is an ordinary
// capture from this app's own corpus.
// ---------------------------------------------------------------------------
{
  const CONTROLS = [
    "2 scoops whey and 500g curd",
    "6 boiled eggs and 500ml curd",
    "spent 120 on rose milk and sandwich",
    "bought paneer and curd 640",
    "no gym but ate 6 eggs",
    "no gym today",
    "had popcorn today, already logged that, then had a burrito",
    "drank 500 g curd, with 2 scoops of protein powder. and no gym today",
    "I I went I went to the gym today",
    "drop set on bench 3x10",
    "walked 10000 steps",
    "70g soya bean, 50g oats",
    "slept 7h",
    "I dropped my phone in the gym",
    "actually I am starving, had 6 eggs",
    "paid 250 for lunch at rolls corner",
  ];
  for (const text of CONTROLS) {
    assert.equal(looksLikeAmendment(text), false, `must NOT read as an amendment: ${JSON.stringify(text)}`);
  }

  // ...and through the real salvage layer: an ordinary food log is still an
  // INSERT, and the amendment does not become one.
  const names = (text, model = []) => expandToolCalls(model, { evidence: text, now: at(TODAY, 12) }).map((t) => t.name);
  assert.deepEqual(names("2 scoops whey and 500g curd"), ["create_food_log_candidate"]);
  assert.deepEqual(names("6 boiled eggs and 500ml curd"), ["create_food_log_candidate"]);
  assert.ok(names("spent 120 on rose milk and sandwich").includes("create_expense_candidate"));
  assert.ok(names("no gym but ate 6 eggs").includes("create_workout_log_candidate"));

  // The amendment itself synthesizes NOTHING - no phantom 50 g snack.
  assert.deepEqual(names("actually it was 50g of aloo bhujia not 30g"), []);
  assert.deepEqual(names("delete the coke I logged this morning"), []);
  // ...and when the model routes it as an amendment, the amendment survives and
  // no log rides along with it.
  assert.deepEqual(
    names("actually it was 50g of aloo bhujia not 30g", [
      { name: "amend_log_candidate", arguments: { target_ref: "30g aloo bhujia", target_kind: "food", set: { description: "50g aloo bhujia" } }, confidence: 0.9 },
      { name: "create_food_log_candidate", arguments: { description: "50g aloo bhujia", occurred_at: at(TODAY, 12) }, confidence: 0.6 },
    ]),
    ["amend_log_candidate"],
    "a log alongside an amendment is the duplicate this feature exists to remove",
  );
}

// ---------------------------------------------------------------------------
// 8. THE MODEL NEVER NAMES A ROW. Structural, because a schema that accepts an
//    `id` is one hallucinated uuid away from writing to a row nobody named.
// ---------------------------------------------------------------------------
{
  const edge = readFileSync("supabase/functions/agent/index.ts", "utf8");
  for (const tool of ["amend_log_candidate", "delete_log_candidate"]) {
    const m = edge.match(new RegExp(`${tool}: \\{ required: \\[([^\\]]*)\\][^\\n]*`));
    assert.ok(m, `${tool} has no TOOL_SCHEMAS entry`);
    assert.ok(!/\bid:\s*"/.test(m[0]), `${tool}'s schema accepts an id - the model must never name a row`);
    assert.ok(m[1].includes("target_ref"), `${tool} must require target_ref`);
  }
  // The prompt has to teach it in the owner's own phrasing, or the model will
  // never emit the tool for the sentence he actually types.
  assert.match(edge, /thirty grams of aloo bhujia/, "the worked example is the owner's own case");
  assert.match(edge, /NEVER emit a row id/);
  assert.match(edge, /searches TODAY ONLY/);
}

console.log("amend-target tests passed");
