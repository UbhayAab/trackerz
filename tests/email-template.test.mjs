// Email rendering. The assertions that matter are the ABSENCE ones: a metric
// the app never measured must not appear at all. Reporting "you slept 0h" every
// morning off a nonexistent sleep source is the bug that started this work.
import assert from "node:assert/strict";
import {
  etEscape, etHasValue, etStatsFromFacts, etRenderEmail, etRenderText,
  etSubjectFor, etBuildMessage,
} from "../lib/email-template.mjs";

// ---- absence is not zero -----------------------------------------------------
const factsNoSleep = {
  for_date: "2026-07-23",
  weekday: "Thursday",
  diet_label: "Soybean day",
  workout: { name: "Workout A", kind: "gym" },
  targets: { protein_g: null, calories: null, spend_cap: null },
  yesterday: {
    spend: 0, protein: 92, calories: 1335, sleep_h: null, weight_kg: null,
    workout_done: false, workout_ok: false, logged_anything: true,
  },
  streaks: { workout: 0, protein: 0, budget: 0, logging: 3 },
  money: { hasBudget: false },
  subs_due: [],
};

const stats = etStatsFromFacts(factsNoSleep);
const labels = stats.map((s) => s.label);
assert.ok(!labels.includes("Slept"), "sleep must be absent when sleep_h is null");
assert.ok(!labels.includes("Weight"), "weight must be absent when null");
assert.ok(!labels.includes("Protein target"), "a null target must not be shown");
assert.ok(!labels.includes("Calorie target"), "a null target must not be shown");
assert.ok(!labels.includes("Safe to spend today"), "no budget => no safe-to-spend row");
assert.ok(labels.includes("Calories yesterday"));
assert.ok(labels.includes("Protein yesterday"));

const rendered = etRenderEmail({ body: "Good morning.", stats });
assert.ok(!/Slept/.test(rendered), "rendered HTML must not mention sleep");
assert.ok(!/0\s*h\b/.test(rendered), "must never render a zero-hour sleep figure");
assert.ok(!/undefined|NaN|null/.test(rendered), "no placeholder leakage into the HTML");

// A real sleep figure DOES appear.
const withSleep = etStatsFromFacts({
  ...factsNoSleep,
  yesterday: { ...factsNoSleep.yesterday, sleep_h: 7.5 },
});
assert.ok(withSleep.some((s) => s.label === "Slept" && s.value === "7.5 h"));

// ---- workout wording ---------------------------------------------------------
const restDay = etStatsFromFacts({
  ...factsNoSleep,
  yesterday: { ...factsNoSleep.yesterday, workout_done: false, workout_ok: true },
});
assert.equal(restDay.find((s) => s.label === "Workout yesterday").value, "rest day",
  "a forgiven/rest day must not read as a missed workout");
const trained = etStatsFromFacts({
  ...factsNoSleep,
  yesterday: { ...factsNoSleep.yesterday, workout_done: true, workout_ok: true },
});
assert.equal(trained.find((s) => s.label === "Workout yesterday").value, "done");

// ---- escaping ----------------------------------------------------------------
assert.equal(etEscape('<b>&"x\'</b>'), "&lt;b&gt;&amp;&quot;x&#39;&lt;/b&gt;");
const evil = etRenderEmail({ body: '<script>alert(1)</script>', stats: [] });
assert.ok(!/<script>/.test(evil), "body must be escaped");
const evilStat = etRenderEmail({ body: "hi", stats: [{ label: "<img onerror=x>", value: "<b>1</b>" }] });
assert.ok(!/<img|<b>/.test(evilStat), "stat label and value must be escaped");

// ---- structure ---------------------------------------------------------------
assert.ok(rendered.startsWith("<!doctype html>"), "must be a full document");
assert.ok(/max-width:560px/.test(rendered), "must be width-constrained for mobile");
assert.ok(/ubhayaab\.github\.io\/trackerz/.test(rendered), "must link back to the app");
assert.ok(/pages\/settings\.html/.test(rendered), "must offer a way to turn these off");
assert.ok(!/<style/.test(rendered), "inline styles only — <style> blocks get stripped");

// ---- text alternative --------------------------------------------------------
const text = etRenderText({ body: "Good morning.", stats, bullets: ["drink water"] });
assert.ok(/Good morning\./.test(text));
assert.ok(/- drink water/.test(text));
assert.ok(/Calories yesterday: 1335 kcal/.test(text));
assert.ok(!/Slept/.test(text), "text alternative must omit sleep too");
assert.ok(!/<[a-z]/i.test(text), "text alternative must contain no markup");

// ---- subjects ----------------------------------------------------------------
assert.equal(etSubjectFor("morning", factsNoSleep), "Morning brief — 1335 kcal yesterday");
assert.equal(
  etSubjectFor("morning", { yesterday: { logged_anything: false, calories: 0 } }, "Thu 23 Jul"),
  "Morning brief — Thu 23 Jul",
  "a day with nothing logged must not claim 0 kcal in the subject",
);
assert.equal(etSubjectFor("evening", null), "Evening check-in — still time");
assert.equal(etSubjectFor("weekly", null), "Your week in review");

// ---- one-call builder --------------------------------------------------------
const msg = etBuildMessage({ kind: "morning", body: "Good morning.", facts: factsNoSleep });
assert.equal(msg.subject, "Morning brief — 1335 kcal yesterday");
assert.ok(msg.html.includes("Morning brief"));
assert.ok(msg.text.length > 20);
assert.ok(!/Slept/.test(msg.html) && !/Slept/.test(msg.text));

const evening = etBuildMessage({ kind: "evening", body: "Still time.", bullets: ["gym not logged yet"] });
assert.ok(/Log the rest of today/.test(evening.html), "evening CTA differs from morning");
assert.ok(/gym not logged yet/.test(evening.html));

// An email with no facts at all still renders (test sends, alerts).
const bare = etBuildMessage({ kind: "test", body: "Delivery works." });
assert.ok(bare.html.includes("Delivery works."));
assert.ok(!/undefined/.test(bare.html));

console.log("email-template.test.mjs OK");
