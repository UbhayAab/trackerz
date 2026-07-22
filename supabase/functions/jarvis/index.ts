// deno-lint-ignore-file no-explicit-any
// Trackerz Jarvis edge function - the proactive engine.
//
// pg_cron → jarvis_ping() → pg_net POSTs here three times a day (see
// 20260706000015_jarvis_engine.sql):
//   closeout 00:05 IST - close the just-ended local day into habit_days (+ streaks),
//            write a `closeout` briefing, and on Sundays the weekly_reviews row.
//   morning  07:00 IST - compose the facts JSON, let DeepSeek-chat narrate it
//            (Gemini fallback, deterministic fallback below that), persist the
//            `morning` briefing, deliver via Resend email + Web Push.
//   evening  20:30 IST - nudge on what is still fixable today; push only
//            (email only when actionable).
//
// Auth: `x-jarvis-secret` header matching app_secrets JARVIS_CRON_SECRET runs all
// enabled users (the cron path); a user JWT runs just that user ("Brief me now").
// Deployed with verify_jwt=false - auth is enforced in-function because the
// publishable/new-style API keys are not JWTs.
//
// The voice model NEVER invents figures: it is prompted to copy numbers verbatim
// from the facts JSON, and the deterministic fallback (jbMorningFallback) is the
// contract of record. LLM spend is logged to ai_runs (purpose 'jarvis_voice') so
// the agent's daily cost cap covers Jarvis too.

import { createClient } from "npm:@supabase/supabase-js@2.74.0";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const GEMINI_MODEL = "gemini-2.5-flash";
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Same pricing table as the agent fn (cost meter only).
const GEMINI_IN_USD = 0.075, GEMINI_OUT_USD = 0.3;
const DEEPSEEK_IN_USD = 0.55, DEEPSEEK_OUT_USD = 2.2;
const DAILY_COST_CAP_USD = 2;

// -------- env / clients (mirrors agent/index.ts) --------

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function adminClient() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

const _secretCache = new Map<string, string>();
async function resolveSecret(name: string): Promise<string> {
  const fromEnv = Deno.env.get(name);
  if (fromEnv) return fromEnv;
  if (_secretCache.has(name)) return _secretCache.get(name)!;
  const admin = adminClient();
  const { data, error } = await admin.from("app_secrets").select("value").eq("name", name).maybeSingle();
  if (error) throw new Error(`app_secrets read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Missing secret ${name} (env + app_secrets both empty)`);
  _secretCache.set(name, data.value);
  return data.value;
}

async function resolveSecretOptional(name: string): Promise<string | null> {
  try { return await resolveSecret(name); } catch { return null; }
}
async function resolveAnySecret(names: string[]): Promise<string | null> {
  for (const n of names) { const v = await resolveSecretOptional(n); if (v) return v; }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let out = 0;
  for (let i = 0; i < ea.length; i++) out |= ea[i] ^ eb[i];
  return out === 0;
}

// ==== JARVIS-BRIEF MIRROR START (byte-identical in lib/jarvis-brief.mjs) ====
function jbRound(n) { return Math.round(Number(n) || 0); }

function jbRupees(n) { return "Rs " + jbRound(n).toLocaleString("en-IN"); }

function jbTzOffsetMinutes(instant, timeZone) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var parts = {};
  var ps = dtf.formatToParts(instant);
  for (var i = 0; i < ps.length; i++) parts[ps[i].type] = ps[i].value;
  var asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === "24" ? 0 : parts.hour), Number(parts.minute), Number(parts.second),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

// Civil "YYYY-MM-DD" for an instant in a timezone (en-CA formats ISO-style).
function jbDateKeyInTz(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

// UTC instants [startISO, endISO) covering one civil day in a timezone.
function jbDayWindow(dateKey, timeZone) {
  var guess = new Date(dateKey + "T00:00:00Z");
  var off = jbTzOffsetMinutes(guess, timeZone);
  var start = new Date(guess.getTime() - off * 60000);
  var off2 = jbTzOffsetMinutes(start, timeZone);
  if (off2 !== off) start = new Date(guess.getTime() - off2 * 60000);
  return { startISO: start.toISOString(), endISO: new Date(start.getTime() + 86400000).toISOString() };
}

function jbAddDays(dateKey, delta) {
  var d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ISO weekday 1=Mon … 7=Sun for a civil date key.
function jbWeekdayFromKey(dateKey) {
  var d = new Date(dateKey + "T00:00:00Z");
  return ((d.getUTCDay() + 6) % 7) + 1;
}

// Days left in the key's month, including the key's day itself.
function jbDaysLeftInMonth(dateKey) {
  var y = Number(dateKey.slice(0, 4)), m = Number(dateKey.slice(5, 7)), d = Number(dateKey.slice(8, 10));
  var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.max(1, daysInMonth - d + 1);
}

function jbMinutesOfDay(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Quiet hours in the user's local time; a window may wrap past midnight.
function jbInQuietHours(instant, timeZone, quiet) {
  if (!quiet) return false;
  var s = jbMinutesOfDay(quiet.start), e = jbMinutesOfDay(quiet.end);
  if (s == null || e == null || s === e) return false;
  var hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(instant);
  var mins = jbMinutesOfDay(hm);
  if (mins == null) return false;
  return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

// Standing scaffold names, mirrored from lib/diet-scaffold.mjs (labels only -
// the brief needs the day's headline, not the meal list). Keep in sync by hand.
var JB_WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
var JB_WORKOUT_BY_WEEKDAY = { 1: "A", 2: "cardio", 3: "cardio", 4: "cardio", 5: "B", 6: "A", 7: "B" };
var JB_WORKOUTS = {
  A: { name: "Workout A", kind: "gym" },
  B: { name: "Workout B", kind: "gym" },
  cardio: { name: "Cardio - forgiven day", kind: "cardio" },
};

function jbDietLabelForWeekday(wd) {
  return (wd === 3 || wd === 6) ? "Paneer-Soy day" : "Soybean day";
}

// Resolve the planned workout for a weekday: a permanent user_plans gym payload
// (flat spec or {days:{Mon:…}} map) wins; otherwise the standing scaffold cycle.
function jbPlannedWorkout(wd, gymPayload) {
  if (gymPayload && typeof gymPayload === "object" && !Array.isArray(gymPayload)) {
    var spec = gymPayload;
    if (gymPayload.days && typeof gymPayload.days === "object") {
      var short = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd];
      spec = gymPayload.days[short] || gymPayload.days[JB_WEEKDAY_NAMES[wd]] || null;
    }
    if (spec && (spec.name || spec.kind)) {
      return { name: spec.name || "Custom workout", kind: spec.kind || "gym" };
    }
  }
  return JB_WORKOUTS[JB_WORKOUT_BY_WEEKDAY[wd]];
}

function jbBudgetAmount(budgets, kind) {
  var rows = budgets || [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].kind === kind && rows[i].amount != null) return Number(rows[i].amount);
  }
  return null;
}

// Daily spend cap derived the same way src/services/briefing.js does it.
function jbDailySpendCap(budgets) {
  var monthly = jbBudgetAmount(budgets, "monthly_spend");
  if (monthly != null) return Math.round(monthly / 30);
  var weekly = jbBudgetAmount(budgets, "weekly_spend");
  if (weekly != null) return Math.round(weekly / 7);
  return null;
}

// Close one civil day from its raw rows. plannedKind: "gym" | "cardio" | "rest".
function jbCloseDay(input) {
  var ledger = input.ledger || [], foods = input.foods || [], workouts = input.workouts || [];
  var wellness = input.wellness || [], bodyMetrics = input.bodyMetrics || [], budgets = input.budgets || [];
  var plannedKind = input.plannedKind || "gym";

  var spend = 0, discretionarySpend = 0, income = 0;
  for (var i = 0; i < ledger.length; i++) {
    var e = ledger[i], amt = Number(e.amount) || 0;
    if (e.direction === "expense") { spend += amt; if (e.is_discretionary) discretionarySpend += amt; }
    else if (e.direction === "income") income += amt;
  }

  var protein = 0, calories = 0;
  for (var f = 0; f < foods.length; f++) {
    protein += Number(foods[f].protein_g) || 0;
    calories += Number(foods[f].calories_estimate) || 0;
  }

  // A 'skipped'/'rest' row records that the user answered the day ("no gym
  // today") - it is NOT training. Counting every row is what turned "Did not go
  // to gym bro" into a completed workout and a rolling gym streak. Rows written
  // before the status column existed have no status and stay 'done'.
  var realWorkouts = [];
  for (var rw = 0; rw < workouts.length; rw++) {
    var st = workouts[rw] && workouts[rw].status;
    if (st === "skipped" || st === "rest") continue;
    realWorkouts.push(workouts[rw]);
  }

  var workoutMin = 0;
  for (var w = 0; w < realWorkouts.length; w++) workoutMin += Number(realWorkouts[w].duration_min) || 0;

  // sleepH stays NULL when nothing was measured. It used to default to 0, which
  // the voice model then narrated as the fact "you got zero sleep" every single
  // day - a number the app had never collected.
  var steps = 0, sleepH = null, weightKg = null;
  for (var b = 0; b < bodyMetrics.length; b++) {
    var m = bodyMetrics[b], v = Number(m.value) || 0;
    if (m.metric_type === "steps" && v > steps) steps = v;
    else if (m.metric_type === "sleep_hours" && v > 0 && v > (sleepH || 0)) sleepH = v;
    else if (m.metric_type === "weight" && v > 0) weightKg = v;
  }
  // Completed sleep_sessions are the primary source; body_metrics is the legacy one.
  var sessions = input.sleepSessions || [];
  var sessionH = 0;
  for (var sx = 0; sx < sessions.length; sx++) {
    var s0 = sessions[sx];
    if (!s0 || !s0.started_at || !s0.ended_at) continue;
    var hrs = (new Date(s0.ended_at).getTime() - new Date(s0.started_at).getTime()) / 3600000;
    if (hrs > 0 && hrs < 24) sessionH += hrs;
  }
  if (sessionH > 0) sleepH = sessionH;
  sleepH = sleepH == null ? null : Math.round(sleepH * 10) / 10;

  var moodSum = 0, moodN = 0;
  for (var q = 0; q < wellness.length; q++) {
    var mood = Number(wellness[q].mood_score);
    if (mood > 0) { moodSum += mood; moodN++; }
  }

  var proteinTarget = jbBudgetAmount(budgets, "daily_protein");
  var caloriesTarget = jbBudgetAmount(budgets, "daily_calories");
  var spendCap = jbDailySpendCap(budgets);

  // `logged` counts ALL rows including a skipped workout - declining the gym is
  // still answering the day, and the logging streak should survive it.
  var logged = (ledger.length + foods.length + workouts.length + wellness.length + bodyMetrics.length + sessions.length) > 0;
  // A forgiven-cardio day counts on 10k steps OR any real session; rest days always count.
  var workoutDone = realWorkouts.length > 0 || steps >= 10000;
  var workoutForgiven = !workoutDone && plannedKind === "rest";
  var flags = {
    logged: logged,
    workout: workoutDone,
    workout_forgiven: workoutForgiven,
    workout_ok: workoutDone || workoutForgiven,
    protein_hit: proteinTarget != null && proteinTarget > 0 && protein >= proteinTarget * 0.9,
    // A day with NOTHING logged is not a day under budget. Counting it grew the
    // budget streak on days the user never opened the app.
    under_budget: spendCap != null && logged && spend <= spendCap,
  };

  return {
    spend: Math.round(spend), discretionarySpend: Math.round(discretionarySpend), income: Math.round(income),
    protein: Math.round(protein), calories: Math.round(calories), meals: foods.length,
    workoutDone: workoutDone, workoutMin: Math.round(workoutMin),
    steps: steps, sleepH: sleepH, weightKg: weightKg,
    moodAvg: moodN ? Math.round((moodSum / moodN) * 10) / 10 : null,
    logged: logged,
    caps: { spendCap: spendCap, proteinTarget: proteinTarget, caloriesTarget: caloriesTarget },
    flags: flags,
  };
}

// Streaks roll forward from the previous day's row; a miss resets to 0.
function jbNextStreaks(prev, flags) {
  var p = prev || {};
  var f = flags || {};
  return {
    workout: f.workout_ok ? (Number(p.workout) || 0) + 1 : 0,
    protein: f.protein_hit ? (Number(p.protein) || 0) + 1 : 0,
    budget: f.under_budget ? (Number(p.budget) || 0) + 1 : 0,
    logging: f.logged ? (Number(p.logging) || 0) + 1 : 0,
  };
}

function jbSafeToSpend(o) {
  var cap = Number(o.monthlyCap) || 0;
  if (cap <= 0) return { hasBudget: false };
  var remaining = cap - (Number(o.monthSpend) || 0) - (Number(o.subsDueTotal) || 0);
  var daysLeft = Math.max(1, Number(o.daysLeft) || 1);
  return { hasBudget: true, monthlyCap: cap, remaining: Math.round(remaining), daysLeft: daysLeft, perDay: Math.round(remaining / daysLeft) };
}

// Assemble the morning facts object - the ONLY numbers the voice model may use.
function jbBriefFacts(o) {
  var wd = jbWeekdayFromKey(o.dateKey);
  var workout = jbPlannedWorkout(wd, o.gymPayload);
  var y = o.yesterday || null;
  var subsDue = o.subsDue || [];
  var subsDueTotal = 0;
  for (var i = 0; i < subsDue.length; i++) subsDueTotal += Number(subsDue[i].amount) || 0;
  return {
    for_date: o.dateKey,
    weekday: JB_WEEKDAY_NAMES[wd],
    diet_label: jbDietLabelForWeekday(wd),
    workout: { name: workout.name, kind: workout.kind },
    targets: {
      protein_g: jbBudgetAmount(o.budgets, "daily_protein"),
      calories: jbBudgetAmount(o.budgets, "daily_calories"),
      spend_cap: jbDailySpendCap(o.budgets),
    },
    yesterday: y ? {
      spend: y.spend, protein: y.protein, calories: y.calories,
      // workout_done means a session actually happened. It used to carry
      // workout_ok, so a rest/forgiven day with zero training was narrated as
      // "workout done". Both are exposed now, distinctly.
      workout_done: y.flags ? Boolean(y.flags.workout) : Boolean(y.workoutDone),
      workout_ok: y.flags ? Boolean(y.flags.workout_ok) : Boolean(y.workoutDone),
      // null (not false) when no target/cap exists - "no target" must never be
      // narrated as "missed"/"over".
      protein_hit: (y.caps && y.caps.proteinTarget != null && y.caps.proteinTarget > 0)
        ? Boolean(y.flags && y.flags.protein_hit) : null,
      under_budget: (y.caps && y.caps.spendCap != null)
        ? Boolean(y.flags && y.flags.under_budget) : null,
      sleep_h: y.sleepH, weight_kg: y.weightKg, logged_anything: y.logged,
    } : null,
    streaks: o.streaks || {},
    money: jbSafeToSpend({
      monthlyCap: jbBudgetAmount(o.budgets, "monthly_spend"),
      monthSpend: o.monthSpend, daysLeft: jbDaysLeftInMonth(o.dateKey), subsDueTotal: subsDueTotal,
    }),
    subs_due: subsDue,
    weekly_workouts: { done: Number(o.weeklyWorkouts) || 0, target: jbBudgetAmount(o.budgets, "weekly_workouts") },
  };
}

// Deterministic morning brief - the always-works voice the LLM only embellishes.
function jbMorningFallback(facts) {
  var lines = [];
  lines.push("Good morning - " + facts.weekday + ", " + facts.diet_label + ".");
  var y = facts.yesterday;
  if (y && y.logged_anything) {
    var ybits = [jbRupees(y.spend) + " spent"];
    if (y.protein > 0) ybits.push(y.protein + "g protein" + (y.protein_hit ? " (hit)" : ""));
    ybits.push(y.workout_done ? "workout done" : "no workout");
    if (y.sleep_h > 0) ybits.push("slept " + y.sleep_h + "h");
    lines.push("Yesterday: " + ybits.join(", ") + ".");
  }
  var t = [];
  if (facts.workout && facts.workout.name) t.push(facts.workout.name);
  if (facts.targets.protein_g) t.push(jbRound(facts.targets.protein_g) + "g protein");
  if (facts.targets.calories) t.push(jbRound(facts.targets.calories) + " kcal");
  if (t.length) lines.push("Today: " + t.join(", ") + ".");
  if (facts.money && facts.money.hasBudget) {
    lines.push("Safe to spend: " + jbRupees(facts.money.perDay) + "/day (" + jbRupees(facts.money.remaining) + " left over " + facts.money.daysLeft + "d).");
  }
  for (var i = 0; i < (facts.subs_due || []).length && i < 2; i++) {
    var s = facts.subs_due[i];
    lines.push(s.merchant + " " + jbRupees(s.amount) + " expected in " + s.in_days + "d.");
  }
  var st = facts.streaks || {}, sbits = [];
  if (st.workout > 1) sbits.push("gym " + st.workout + "d");
  if (st.protein > 1) sbits.push("protein " + st.protein + "d");
  if (st.budget > 1) sbits.push("budget " + st.budget + "d");
  if (sbits.length) lines.push("Streaks: " + sbits.join(" · ") + ".");
  return lines.join(" ");
}

// Evening nudge - only what is still fixable today.
function jbEveningBody(s) {
  var nudges = [];
  var pt = jbRound(s.proteinTarget), p = jbRound(s.proteinToday);
  if (pt > 0 && pt - p > 10) nudges.push((pt - p) + "g protein to go");
  var ct = jbRound(s.caloriesTarget), c = jbRound(s.caloriesToday);
  if (ct > 0 && c - ct > 50) nudges.push((c - ct) + " kcal over target");
  if (s.plannedKind && s.plannedKind !== "rest" && !s.workoutLogged) {
    nudges.push("gym not logged yet (" + (s.plannedName || "workout") + ")");
  }
  if (s.spendCap != null && jbRound(s.todaySpend) > jbRound(s.spendCap)) {
    nudges.push("over today's spend by " + jbRupees(jbRound(s.todaySpend) - jbRound(s.spendCap)));
  }
  var headline = nudges.length ? "Evening check-in - still time" : "Evening check-in - on track";
  var body = nudges.length ? headline + ": " + nudges.join(" · ") + "." : headline + ". Nothing left undone.";
  return { headline: headline, nudges: nudges, body: body };
}

// Nightly close-out body (deterministic; no LLM at midnight).
function jbCloseoutBody(day, streaks) {
  var bits = [];
  bits.push(jbRupees(day.spend) + " spent" + (day.caps.spendCap != null ? (day.flags.under_budget ? " (under cap)" : " (over cap)") : ""));
  if (day.caps.proteinTarget != null && day.caps.proteinTarget > 0) {
    bits.push(day.protein + "g protein" + (day.flags.protein_hit ? " (hit)" : " (short)"));
  }
  bits.push(day.workoutDone ? "workout done" : (day.flags.workout_forgiven ? "rest day" : "no workout"));
  if (day.sleepH > 0) bits.push("slept " + day.sleepH + "h");
  var st = streaks || {}, sbits = [];
  if (st.workout > 1) sbits.push("gym " + st.workout + "d");
  if (st.protein > 1) sbits.push("protein " + st.protein + "d");
  if (st.budget > 1) sbits.push("budget " + st.budget + "d");
  return "Day closed: " + bits.join(", ") + "." + (sbits.length ? " Streaks: " + sbits.join(" · ") + "." : "");
}

// Aggregate a week of habit_days rows into weekly_reviews.summary.
function jbWeeklySummary(days) {
  var rows = days || [];
  var t = { spend: 0, protein: 0, calories: 0, sleep: 0, sleepN: 0 };
  var hits = { workout_days: 0, protein_days: 0, budget_days: 0, logged_days: 0 };
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].summary || {}, f = rows[i].flags || {};
    t.spend += Number(s.spend) || 0;
    t.protein += Number(s.protein) || 0;
    t.calories += Number(s.calories) || 0;
    if (Number(s.sleepH) > 0) { t.sleep += Number(s.sleepH); t.sleepN++; }
    if (f.workout_ok) hits.workout_days++;
    if (f.protein_hit) hits.protein_days++;
    if (f.under_budget) hits.budget_days++;
    if (f.logged) hits.logged_days++;
  }
  var n = rows.length;
  return {
    days: n,
    totals: { spend: Math.round(t.spend), workouts: hits.workout_days },
    averages: {
      protein: n ? Math.round(t.protein / n) : 0,
      calories: n ? Math.round(t.calories / n) : 0,
      // null, not 0 - "no sleep was recorded this week" is not "you slept 0h".
      sleep_h: t.sleepN ? Math.round((t.sleep / t.sleepN) * 10) / 10 : null,
    },
    hits: hits,
    end_streaks: n ? (rows[n - 1].streaks || {}) : {},
  };
}

// Voice contract: the model phrases, the facts JSON owns every number.
var JB_VOICE_SYSTEM = "You are Jarvis, the user's personal chief of staff inside their life tracker. Write their morning brief from the facts JSON: 3 to 6 short sentences, direct address, brisk and warm, plain text only (no markdown, no emoji, no headings, no bullet lists). Every figure you mention must be copied verbatim from the facts JSON - never invent, recompute, or extrapolate a number. NULL MEANS NOT MEASURED AND NOT SET: if a value is null, that thing was never recorded or never configured - say NOTHING about it at all. Never render null as zero, and never describe it as missed, over, failed, skipped, or lacking. In particular, if sleep_h is null the app has no sleep data, so do not mention sleep in any form. Only mention a metric when its value is a real number. workout_done=false means no session happened; if workout_ok is true on the same day it was a planned rest or forgiven day, so do not call it a miss. Currency is INR; write amounts as Rs. Cover: how yesterday closed, today's plan (workout and protein/calorie targets), safe-to-spend if present, any subscription due soon, and the strongest streak worth protecting. End with one concrete next move for the morning.";

function jbVoiceUserPrompt(facts) {
  return "FACTS JSON:\n" + JSON.stringify(facts) + "\n\nWrite the morning brief now, plain text only.";
}
// ==== JARVIS-BRIEF MIRROR END ====

// -------- per-user data access (service role; RLS bypassed on purpose - this is
// the scheduled server acting FOR the user; every write is audit-logged) --------

type Profile = {
  id: string; display_name: string; timezone: string; briefing_enabled: boolean;
  push_enabled?: boolean; email_brief?: boolean; quiet_hours?: { start?: string; end?: string } | null;
};

// Test fixtures left behind in production. Matching on the profile alone keeps
// this cheap (no auth lookup per user per slot).
const FIXTURE_NAME_RE = /^(e2e|test|dummy|fixture|smoke)[_-]/i;
function isFixtureProfile(p: Profile & { display_name?: string }): boolean {
  return FIXTURE_NAME_RE.test(String(p?.display_name || "")) || FIXTURE_ID.has(p?.id);
}
// Explicit allow-list of known-abandoned fixture accounts (display_name here is
// "Ubhay", so the pattern above does not catch it).
const FIXTURE_ID = new Set<string>(["b788d68f-aee7-476b-9e50-f2cf9b3804c0"]);

async function fetchDayRows(admin: any, userId: string, startISO: string, endISO: string) {
  const [ledger, foods, workouts, wellness, metrics, sleep] = await Promise.all([
    admin.from("ledger_entries")
      .select("amount, direction, is_discretionary")
      .eq("user_id", userId).is("merged_into", null)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("food_logs")
      .select("protein_g, calories_estimate")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("workout_logs")
      // `status` decides whether this counts as training. Selecting it is what
      // stops a 'skipped' row ("no gym today") from reading as a workout.
      .select("duration_min, status")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("wellness_logs")
      .select("mood_score")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("body_metrics")
      .select("metric_type, value")
      .eq("user_id", userId)
      .gte("occurred_at", startISO).lt("occurred_at", endISO),
    admin.from("sleep_sessions")
      .select("started_at, ended_at")
      .eq("user_id", userId).not("ended_at", "is", null)
      .gte("ended_at", startISO).lt("ended_at", endISO),
  ]);

  // A failed read is NOT an empty day. Returning [] on error is how a transient
  // Supabase blip became "you logged nothing yesterday", got frozen into
  // habit_days, and reset every streak. Fail loudly instead - the caller skips
  // the day rather than recording a fiction.
  const reads = { ledger, foods, workouts, wellness, metrics, sleep };
  for (const [name, res] of Object.entries(reads)) {
    if (res?.error) throw new Error(`fetchDayRows: ${name} read failed - ${res.error.message}`);
  }

  return {
    ledger: ledger.data || [],
    foods: foods.data || [],
    workouts: workouts.data || [],
    wellness: wellness.data || [],
    bodyMetrics: metrics.data || [],
    sleepSessions: sleep.data || [],
  };
}

async function fetchBudgets(admin: any, userId: string) {
  const { data } = await admin.from("budgets").select("kind, amount").eq("user_id", userId).not("kind", "is", null);
  return data || [];
}

async function fetchGymPayload(admin: any, userId: string) {
  const { data } = await admin.from("user_plans")
    .select("payload")
    .eq("user_id", userId).eq("kind", "gym").eq("scope", "permanent").eq("active", true)
    .order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.payload ?? null;
}

async function fetchMonthSpend(admin: any, userId: string, dateKey: string, tz: string) {
  const monthStart = jbDayWindow(dateKey.slice(0, 8) + "01", tz).startISO;
  const end = jbDayWindow(dateKey, tz).endISO;
  const { data } = await admin.from("ledger_entries")
    .select("amount")
    .eq("user_id", userId).eq("direction", "expense").is("merged_into", null)
    .gte("occurred_at", monthStart).lt("occurred_at", end);
  return (data || []).reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0);
}

async function fetchSubsDue(admin: any, userId: string, now: Date) {
  const until = new Date(now.getTime() + 7 * 86400000);
  const { data } = await admin.from("subscriptions")
    .select("merchant, median_amount, next_expected_at")
    .eq("user_id", userId).eq("is_active", true)
    .gte("next_expected_at", now.toISOString()).lte("next_expected_at", until.toISOString())
    .order("next_expected_at", { ascending: true }).limit(4);
  return (data || []).map((s: any) => ({
    merchant: s.merchant,
    amount: Math.round(Number(s.median_amount) || 0),
    in_days: Math.max(0, Math.ceil((new Date(s.next_expected_at).getTime() - now.getTime()) / 86400000)),
  }));
}

async function fetchWeeklyWorkouts(admin: any, userId: string, dateKey: string, tz: string) {
  const start = jbDayWindow(jbAddDays(dateKey, -6), tz).startISO;
  const end = jbDayWindow(dateKey, tz).endISO;
  const { count, error } = await admin.from("workout_logs")
    .select("id", { count: "exact", head: true })
    // Skipped/rest days are answered days, not training - they must not count
    // toward the weekly_workouts goal.
    .eq("user_id", userId).neq("status", "skipped")
    .gte("occurred_at", start).lt("occurred_at", end);
  if (error) throw new Error(`fetchWeeklyWorkouts read failed - ${error.message}`);
  return count ?? 0;
}

async function fetchHabitDay(admin: any, userId: string, dateKey: string) {
  const { data } = await admin.from("habit_days")
    .select("day, flags, streaks, summary")
    .eq("user_id", userId).eq("day", dateKey).maybeSingle();
  return data || null;
}

async function auditLog(admin: any, userId: string, action: string, after: unknown) {
  await admin.from("audit_log").insert({
    user_id: userId, action, target_table: "briefings", after, source: "jarvis",
  }).then(() => null, () => null);
}

async function withinDailyCap(admin: any, userId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await admin.from("ai_runs")
    .select("estimated_cost_usd")
    .eq("user_id", userId).gte("created_at", startOfDay.toISOString());
  if (error) return false; // fail CLOSED, same as the agent fn
  const sum = (data || []).reduce((acc: number, r: any) => acc + Number(r.estimated_cost_usd || 0), 0);
  return sum < DAILY_COST_CAP_USD;
}

function costOf(inUsdPerM: number, outUsdPerM: number, pt = 0, ot = 0) {
  return ((pt || 0) / 1_000_000) * inUsdPerM + ((ot || 0) / 1_000_000) * outUsdPerM;
}

// -------- the voice: DeepSeek-chat prose → Gemini → null (caller falls back) --------

function tidyVoice(raw: string): string {
  const s = String(raw || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 900 ? s.slice(0, 897) + "…" : s;
}

async function voiceBrief(admin: any, userId: string, facts: unknown) {
  if (!(await withinDailyCap(admin, userId))) return null;

  const deepseekKey = await resolveAnySecret(["DEEPSEEK_API_KEY", "NVIDIA_API_KEY"]);
  if (deepseekKey) {
    try {
      const url = (await resolveSecretOptional("DEEPSEEK_BASE_URL")) || DEEPSEEK_URL;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0.4,
          max_tokens: 400,
          messages: [
            { role: "system", content: JB_VOICE_SYSTEM },
            { role: "user", content: jbVoiceUserPrompt(facts) },
          ],
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const body = tidyVoice(json.choices?.[0]?.message?.content ?? "");
        const usage = json.usage || {};
        if (body.length > 40) {
          await logVoiceRun(admin, userId, "deepseek", DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens,
            costOf(DEEPSEEK_IN_USD, DEEPSEEK_OUT_USD, usage.prompt_tokens, usage.completion_tokens));
          return { body, provider: "deepseek", model: DEEPSEEK_MODEL };
        }
      }
    } catch { /* fall through to Gemini */ }
  }

  try {
    const apiKey = await resolveSecret("GEMINI_API_KEY");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const res = await fetch(`${url}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JB_VOICE_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: jbVoiceUserPrompt(facts) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    });
    if (res.ok) {
      const json = await res.json();
      const body = tidyVoice(json.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
      const usage = json.usageMetadata || {};
      if (body.length > 40) {
        await logVoiceRun(admin, userId, "gemini", GEMINI_MODEL, usage.promptTokenCount, usage.candidatesTokenCount,
          costOf(GEMINI_IN_USD, GEMINI_OUT_USD, usage.promptTokenCount, usage.candidatesTokenCount));
        return { body, provider: "gemini", model: GEMINI_MODEL };
      }
    }
  } catch { /* deterministic fallback in the caller */ }
  return null;
}

async function logVoiceRun(admin: any, userId: string, provider: string, model: string, pt = 0, ot = 0, cost = 0) {
  await admin.from("ai_runs").insert({
    user_id: userId, provider, model, purpose: "jarvis_voice",
    prompt_tokens: pt || 0, output_tokens: ot || 0,
    estimated_cost_usd: cost, status: "succeeded",
  }).then(() => null, () => null);
}

// -------- delivery: Resend email + Web Push --------

// ==== EMAIL-TEMPLATE MIRROR START (byte-identical in lib/email-template.mjs) ====
var ET_APP_URL = "https://ubhayaab.github.io/trackerz/";
var ET_INK = "#17211c";
var ET_MUTED = "#7c8a82";
var ET_ACCENT = "#138a5b";
var ET_LINE = "#e3e9e5";
var ET_BG = "#f6f8f7";

function etEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function etRupees(n) {
  return "Rs " + (Math.round(Number(n) || 0)).toLocaleString("en-IN");
}

// A stat is worth showing only when it is a real number. null/undefined/NaN mean
// "not measured" and must vanish entirely rather than becoming a zero.
function etHasValue(v) {
  return v !== null && v !== undefined && !(typeof v === "number" && !isFinite(v));
}

// Build the stat rows for a brief from its facts JSON. Order is fixed so the
// email reads the same every day.
function etStatsFromFacts(facts) {
  var out = [];
  if (!facts) return out;
  var y = facts.yesterday;
  if (y) {
    if (etHasValue(y.calories) && y.calories > 0) out.push({ label: "Calories yesterday", value: String(Math.round(y.calories)) + " kcal" });
    if (etHasValue(y.protein) && y.protein > 0) out.push({ label: "Protein yesterday", value: String(Math.round(y.protein)) + " g" });
    if (etHasValue(y.spend)) out.push({ label: "Spent yesterday", value: etRupees(y.spend) });
    // sleep_h is null whenever no sleep was recorded - omit, never render 0.
    if (etHasValue(y.sleep_h) && y.sleep_h > 0) out.push({ label: "Slept", value: String(y.sleep_h) + " h" });
    if (etHasValue(y.weight_kg)) out.push({ label: "Weight", value: String(y.weight_kg) + " kg" });
    out.push({ label: "Workout yesterday", value: y.workout_done ? "done" : (y.workout_ok ? "rest day" : "not logged") });
  }
  if (facts.workout && facts.workout.name) out.push({ label: "Today's workout", value: facts.workout.name });
  if (facts.diet_label) out.push({ label: "Today's diet", value: facts.diet_label });
  var t = facts.targets || {};
  if (etHasValue(t.protein_g)) out.push({ label: "Protein target", value: String(Math.round(t.protein_g)) + " g" });
  if (etHasValue(t.calories)) out.push({ label: "Calorie target", value: String(Math.round(t.calories)) + " kcal" });
  if (facts.money && facts.money.hasBudget) {
    out.push({ label: "Safe to spend today", value: etRupees(facts.money.perDay) });
  }
  var st = facts.streaks || {};
  var streaks = [];
  if (st.workout > 1) streaks.push("gym " + st.workout + "d");
  if (st.protein > 1) streaks.push("protein " + st.protein + "d");
  if (st.budget > 1) streaks.push("budget " + st.budget + "d");
  if (st.logging > 1) streaks.push("logging " + st.logging + "d");
  if (streaks.length) out.push({ label: "Streaks", value: streaks.join(" · ") });
  return out;
}

function etStatRows(stats) {
  var rows = "";
  for (var i = 0; i < (stats || []).length; i++) {
    var s = stats[i];
    var border = i === 0 ? "none" : "1px solid " + ET_LINE;
    rows += '<tr>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_MUTED + '">' + etEscape(s.label) + '</td>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_INK + ';font-weight:600;text-align:right;white-space:nowrap">' + etEscape(s.value) + '</td>'
      + '</tr>';
  }
  return rows;
}

function etBulletList(items) {
  if (!items || !items.length) return "";
  var lis = "";
  for (var i = 0; i < items.length; i++) {
    lis += '<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:' + ET_INK + '">' + etEscape(items[i]) + "</li>";
  }
  return '<ul style="margin:14px 0 0;padding-left:20px">' + lis + "</ul>";
}

// The one email shell. `kind` only changes the eyebrow and the accent word.
function etRenderEmail(o) {
  var opts = o || {};
  var title = opts.title || "Trackerz";
  var eyebrow = opts.eyebrow || "Trackerz · Jarvis";
  var body = opts.body || "";
  var stats = opts.stats || [];
  var bullets = opts.bullets || [];
  var ctaLabel = opts.ctaLabel || "Open Trackerz";
  var footerNote = opts.footerNote || "";

  var statsBlock = stats.length
    ? '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;border-collapse:collapse">' + etStatRows(stats) + "</table>"
    : "";

  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light">'
    + "<title>" + etEscape(title) + "</title></head>"
    + '<body style="margin:0;padding:0;background:' + ET_BG + '">'
    // Preheader: the grey preview line in the inbox list. Without it, clients
    // show the eyebrow text, which is identical every day and tells you nothing.
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + etEscape(String(body).slice(0, 140)) + "</div>"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' + ET_BG + ';padding:24px 12px">'
    + "<tr><td align=\"center\">"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ' + ET_LINE + ';border-radius:14px;overflow:hidden">'
    + '<tr><td style="padding:22px 24px 0">'
    + '<p style="margin:0 0 10px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:' + ET_ACCENT + ';font-weight:700">' + etEscape(eyebrow) + "</p>"
    + '<p style="margin:0;font-size:16px;line-height:1.6;color:' + ET_INK + '">' + etEscape(body) + "</p>"
    + etBulletList(bullets)
    + statsBlock
    + "</td></tr>"
    + '<tr><td style="padding:20px 24px 24px">'
    + '<a href="' + ET_APP_URL + '" style="display:inline-block;background:' + ET_ACCENT + ';color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:999px">' + etEscape(ctaLabel) + "</a>"
    + "</td></tr>"
    + '<tr><td style="padding:14px 24px 20px;border-top:1px solid ' + ET_LINE + ';background:#fbfcfb">'
    + (footerNote ? '<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">' + etEscape(footerNote) + "</p>" : "")
    + '<p style="margin:0;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">'
    + 'Every number here comes from what you logged. Turn these off any time in '
    + '<a href="' + ET_APP_URL + 'pages/settings.html" style="color:' + ET_ACCENT + '">Settings &rarr; Jarvis</a>.'
    + "</p></td></tr>"
    + "</table></td></tr></table></body></html>";
}

// text/plain alternative. Spam filters penalise HTML-only mail, and it is what
// a watch or a screen reader actually reads out.
function etRenderText(o) {
  var opts = o || {};
  var lines = [String(opts.body || "").trim()];
  var bullets = opts.bullets || [];
  for (var i = 0; i < bullets.length; i++) lines.push("- " + bullets[i]);
  var stats = opts.stats || [];
  if (stats.length) {
    lines.push("");
    for (var j = 0; j < stats.length; j++) lines.push(stats[j].label + ": " + stats[j].value);
  }
  lines.push("");
  lines.push(ET_APP_URL);
  lines.push("Manage these emails: " + ET_APP_URL + "pages/settings.html");
  return lines.join("\n");
}

// Subject lines carry the headline number so the inbox list is useful without
// opening anything. Never invent one - fall back to a plain subject.
function etSubjectFor(kind, facts, dateLabel) {
  var y = facts && facts.yesterday;
  if (kind === "morning") {
    if (y && y.logged_anything && etHasValue(y.calories) && y.calories > 0) {
      return "Morning brief - " + Math.round(y.calories) + " kcal yesterday";
    }
    return "Morning brief" + (dateLabel ? " - " + dateLabel : "");
  }
  if (kind === "evening") return "Evening check-in - still time";
  if (kind === "closeout") return "Day closed" + (dateLabel ? " - " + dateLabel : "");
  if (kind === "weekly") return "Your week in review";
  return "Trackerz";
}

var ET_EYEBROWS = {
  morning: "Trackerz · Morning brief",
  evening: "Trackerz · Evening check-in",
  closeout: "Trackerz · Day closed",
  weekly: "Trackerz · Weekly review",
  alert: "Trackerz · Alert",
  test: "Trackerz · Test",
};

// One call site for the whole service: kind + body + facts -> {subject, html, text}.
function etBuildMessage(o) {
  var opts = o || {};
  var kind = opts.kind || "morning";
  var facts = opts.facts || null;
  var stats = opts.stats || (facts ? etStatsFromFacts(facts) : []);
  var payload = {
    title: opts.subject || etSubjectFor(kind, facts, opts.dateLabel),
    eyebrow: ET_EYEBROWS[kind] || ET_EYEBROWS.morning,
    body: opts.body || "",
    stats: stats,
    bullets: opts.bullets || [],
    ctaLabel: opts.ctaLabel || (kind === "evening" ? "Log the rest of today" : "Open Trackerz"),
    footerNote: opts.footerNote || "",
  };
  return {
    subject: payload.title,
    html: etRenderEmail(payload),
    text: etRenderText(payload),
  };
}
// ==== EMAIL-TEMPLATE MIRROR END ====

async function userEmail(admin: any, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch { return null; }
}

// Per-kind opt-outs. One master switch used to gate every message, so silencing
// the 20:30 nudge also silenced the morning brief.
const EMAIL_PREF_COLUMN: Record<string, string> = {
  morning: "email_morning",
  evening: "email_evening",
  closeout: "email_closeout",
  weekly: "email_weekly",
  alert: "email_alerts",
};

function emailEnabledFor(profile: any, kind: string): boolean {
  if (profile?.email_brief === false) return false; // master switch still wins
  const col = EMAIL_PREF_COLUMN[kind];
  if (!col) return true;
  return profile?.[col] !== false;
}

// Retryable: a network blip or a Resend 429/5xx. A 4xx is a real rejection
// (bad address, unverified sender) and retrying it just burns quota.
function isRetryableEmailStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Send one Jarvis email and RECORD the attempt.
 *
 * Every send writes an email_deliveries row, so a bounce or a rejected sender
 * is inspectable in the app afterwards instead of vanishing into a function
 * log. A partial unique index on (user, kind, for_date) where status='sent'
 * makes a re-fired cron slot collide rather than send a duplicate.
 */
async function sendEmail(
  admin: any,
  userId: string,
  kind: string,
  opts: { body: string; facts?: any; bullets?: string[]; subject?: string; forDate?: string | null; dateLabel?: string; profile?: any },
) {
  if (opts.profile && !emailEnabledFor(opts.profile, kind)) {
    return { sent: false, reason: "disabled_by_preference" };
  }
  const key = await resolveSecretOptional("RESEND_API_KEY");
  if (!key) return { sent: false, reason: "no_resend_key" };
  const to = await userEmail(admin, userId);
  if (!to) return { sent: false, reason: "no_email" };

  const from = (await resolveSecretOptional("JARVIS_EMAIL_FROM")) || "Jarvis <onboarding@resend.dev>";
  const message = etBuildMessage({
    kind,
    body: opts.body,
    facts: opts.facts || null,
    bullets: opts.bullets || [],
    subject: opts.subject,
    dateLabel: opts.dateLabel,
  });
  const forDate = opts.forDate ?? null;

  // Claim the slot first. A unique-violation here means this exact message was
  // already delivered - that is a successful no-op, not an error.
  const { data: claim, error: claimErr } = await admin.from("email_deliveries").insert({
    user_id: userId, kind, for_date: forDate, to_email: to, subject: message.subject, status: "queued",
  }).select("id").single();
  if (claimErr && /duplicate key|unique/i.test(claimErr.message || "")) {
    return { sent: false, reason: "already_sent" };
  }
  const deliveryId = claim?.id ?? null;

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ from, to, subject: message.subject, html: message.html, text: message.text }),
      });
      const raw = await res.text();
      if (res.ok) {
        let providerId: string | null = null;
        try { providerId = JSON.parse(raw)?.id ?? null; } catch { /* id is a nicety */ }
        if (deliveryId) {
          await admin.from("email_deliveries").update({
            status: "sent", provider_message_id: providerId, attempts: attempt, sent_at: new Date().toISOString(),
          }).eq("id", deliveryId);
        }
        return { sent: true, id: providerId, attempts: attempt };
      }
      lastError = `resend_${res.status}: ${raw.slice(0, 200)}`;
      if (!isRetryableEmailStatus(res.status)) break;
    } catch (err) {
      lastError = String(err).slice(0, 200);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 700));
  }

  if (deliveryId) {
    await admin.from("email_deliveries").update({ status: "failed", error: lastError, attempts: 3 }).eq("id", deliveryId);
  }
  return { sent: false, reason: lastError || "unknown" };
}

let _appServer: any = null;
async function pushServer() {
  if (_appServer) return _appServer;
  const jwkJson = await resolveSecretOptional("JARVIS_VAPID_JWK");
  if (!jwkJson) return null;
  try {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(jwkJson), { extractable: false });
    const contact = (await resolveSecretOptional("JARVIS_VAPID_CONTACT")) || "mailto:ubhayvatsaanand@gmail.com";
    _appServer = await webpush.ApplicationServer.new({ contactInformation: contact, vapidKeys });
    return _appServer;
  } catch {
    return null;
  }
}

async function sendPush(admin: any, profile: Profile, title: string, body: string, now: Date) {
  if (profile.push_enabled === false) return { sent: 0, reason: "push_disabled" };
  if (jbInQuietHours(now, profile.timezone || "Asia/Kolkata", profile.quiet_hours)) {
    return { sent: 0, reason: "quiet_hours" };
  }
  const server = await pushServer();
  if (!server) return { sent: 0, reason: "no_vapid" };
  const { data: subs } = await admin.from("push_subscriptions")
    .select("id, endpoint, keys").eq("user_id", profile.id);
  if (!subs?.length) return { sent: 0, reason: "no_subscriptions" };

  let sent = 0;
  for (const sub of subs) {
    try {
      const subscriber = server.subscribe({ endpoint: sub.endpoint, keys: sub.keys });
      await subscriber.pushTextMessage(
        JSON.stringify({ title, body, url: "https://ubhayaab.github.io/trackerz/" }),
        { ttl: 3600 },
      );
      sent++;
      await admin.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", sub.id);
    } catch (err: any) {
      const status = err?.response?.status ?? 0;
      if (status === 404 || status === 410) {
        // Endpoint expired/unsubscribed - prune it.
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
      }
    }
  }
  return { sent };
}

// -------- briefings persistence --------

async function upsertBriefing(admin: any, userId: string, kind: string, forDate: string, body: string, payload: unknown) {
  const { data, error } = await admin.from("briefings")
    .upsert(
      { user_id: userId, kind, for_date: forDate, body, payload, seen: false, created_at: new Date().toISOString() },
      { onConflict: "user_id,kind,for_date" },
    )
    .select("id").single();
  if (error) throw new Error(`briefings upsert failed: ${error.message}`);
  return data?.id ?? null;
}

// -------- actions --------

// Close one civil day: habit_days (+streak roll), closeout briefing, and on
// Sundays the weekly_reviews row + weekly briefing.
async function runCloseout(admin: any, profile: Profile, dateKey: string, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const existing = await fetchHabitDay(admin, profile.id, dateKey);
  if (existing && !force) return { userId: profile.id, action: "closeout", forDate: dateKey, skipped: "exists" };

  const win = jbDayWindow(dateKey, tz);
  const [rows, budgets, gymPayload] = await Promise.all([
    fetchDayRows(admin, profile.id, win.startISO, win.endISO),
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
  ]);
  const plannedKind = jbPlannedWorkout(jbWeekdayFromKey(dateKey), gymPayload).kind;
  const day = jbCloseDay({ ...rows, budgets, plannedKind });
  const prev = await fetchHabitDay(admin, profile.id, jbAddDays(dateKey, -1));
  const streaks = jbNextStreaks(prev?.streaks, day.flags);

  const { error: hdErr } = await admin.from("habit_days").upsert(
    { user_id: profile.id, day: dateKey, flags: day.flags, streaks, summary: day },
    { onConflict: "user_id,day" },
  );
  if (hdErr) throw new Error(`habit_days upsert failed: ${hdErr.message}`);

  const body = jbCloseoutBody(day, streaks);
  const briefingId = await upsertBriefing(admin, profile.id, "closeout", dateKey, body, { summary: day, streaks });

  const delivery: Record<string, unknown> = {};
  let weekly = null;
  if (jbWeekdayFromKey(dateKey) === 7) {
    const weekStart = jbAddDays(dateKey, -6);
    const { data: weekRows } = await admin.from("habit_days")
      .select("day, flags, streaks, summary")
      .eq("user_id", profile.id).gte("day", weekStart).lte("day", dateKey)
      .order("day", { ascending: true });
    weekly = jbWeeklySummary(weekRows || []);
    const { error: wrErr } = await admin.from("weekly_reviews").upsert(
      { user_id: profile.id, week_start: weekStart, summary: weekly },
      { onConflict: "user_id,week_start" },
    );
    if (wrErr) throw new Error(`weekly_reviews upsert failed: ${wrErr.message}`);
    const wBody = `Week closed: ${weekly.totals.workouts} workouts, protein hit ${weekly.hits.protein_days}/${weekly.days} days, `
      + `under budget ${weekly.hits.budget_days}/${weekly.days}, ${jbRupees(weekly.totals.spend)} spent.`;
    await upsertBriefing(admin, profile.id, "weekly", dateKey, wBody, { weekly, week_start: weekStart });

    // The weekly review is the one message worth reading in full, and it was
    // never emailed - it only ever existed as a row nobody opened.
    delivery.weeklyEmail = await sendEmail(admin, profile.id, "weekly", {
      body: wBody,
      forDate: dateKey,
      profile,
      stats: [
        { label: "Workouts", value: `${weekly.totals.workouts} / ${weekly.days} days` },
        { label: "Protein hit", value: `${weekly.hits.protein_days} / ${weekly.days} days` },
        { label: "Under budget", value: `${weekly.hits.budget_days} / ${weekly.days} days` },
        { label: "Days logged", value: `${weekly.hits.logged_days} / ${weekly.days}` },
        { label: "Spent", value: jbRupees(weekly.totals.spend) },
        { label: "Avg protein", value: `${weekly.averages.protein} g` },
        { label: "Avg calories", value: `${weekly.averages.calories} kcal` },
      ].concat(
        // sleep_h is null when the week has no sleep data at all - omit the row
        // rather than reporting an average of zero.
        weekly.averages.sleep_h != null ? [{ label: "Avg sleep", value: `${weekly.averages.sleep_h} h` }] : [],
      ),
    });
  }

  // Off by default: this fires at 00:05 and is the least useful thing to be
  // emailed at midnight. Opt in per-kind in Settings.
  delivery.email = await sendEmail(admin, profile.id, "closeout", {
    body, forDate: dateKey, dateLabel: dateKey, profile,
    stats: [
      { label: "Spent", value: jbRupees(day.spend) },
      { label: "Calories", value: `${day.calories} kcal` },
      { label: "Protein", value: `${day.protein} g` },
      { label: "Workout", value: day.workoutDone ? "done" : (day.flags.workout_forgiven ? "rest day" : "not logged") },
    ],
  });

  await auditLog(admin, profile.id, "jarvis.closeout", { forDate: dateKey, briefingId, flags: day.flags, streaks, weekly: Boolean(weekly), delivery });
  return { userId: profile.id, action: "closeout", forDate: dateKey, briefingId, flags: day.flags, streaks, weekly: Boolean(weekly), delivery };
}

// Morning brief: self-heal yesterday's closeout, build facts, narrate, deliver.
async function runMorning(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const todayKey = jbDateKeyInTz(now, tz);
  const ydayKey = jbAddDays(todayKey, -1);

  const { data: existingRow } = await admin.from("briefings")
    .select("id").eq("user_id", profile.id).eq("kind", "morning").eq("for_date", todayKey).maybeSingle();
  if (existingRow && !force) return { userId: profile.id, action: "morning", forDate: todayKey, skipped: "exists" };

  let yday = await fetchHabitDay(admin, profile.id, ydayKey);
  if (!yday) {
    await runCloseout(admin, profile, ydayKey, false);
    yday = await fetchHabitDay(admin, profile.id, ydayKey);
  }

  const [budgets, gymPayload, monthSpend, subsDue, weeklyWorkouts] = await Promise.all([
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
    fetchMonthSpend(admin, profile.id, todayKey, tz),
    fetchSubsDue(admin, profile.id, now),
    fetchWeeklyWorkouts(admin, profile.id, todayKey, tz),
  ]);

  const facts = jbBriefFacts({
    dateKey: todayKey, budgets, gymPayload,
    yesterday: yday ? { ...(yday.summary || {}), flags: yday.flags } : null,
    streaks: yday?.streaks || {},
    monthSpend, subsDue, weeklyWorkouts,
  });

  const voice = await voiceBrief(admin, profile.id, facts);
  const body = voice?.body || jbMorningFallback(facts);
  const briefingId = await upsertBriefing(admin, profile.id, "morning", todayKey, body, {
    facts, voice: voice ? { provider: voice.provider, model: voice.model } : "fallback",
  });

  const delivery: Record<string, unknown> = {};
  if (profile.email_brief !== false) {
    delivery.email = await sendEmail(admin, profile.id, "morning", {
      body, facts, forDate: todayKey, dateLabel: facts.weekday, profile,
    });
  }
  delivery.push = await sendPush(admin, profile, "Morning brief", body.slice(0, 160), now);

  await auditLog(admin, profile.id, "jarvis.morning", { forDate: todayKey, briefingId, voice: voice?.provider || "fallback", delivery });
  return { userId: profile.id, action: "morning", forDate: todayKey, briefingId, voice: voice?.provider || "fallback", delivery };
}

// Evening nudge: what is still fixable today. Push always (outside quiet hours);
// email only when there is something actionable.
async function runEvening(admin: any, profile: Profile, now: Date, force: boolean) {
  const tz = profile.timezone || "Asia/Kolkata";
  const todayKey = jbDateKeyInTz(now, tz);

  const { data: existingRow } = await admin.from("briefings")
    .select("id").eq("user_id", profile.id).eq("kind", "evening").eq("for_date", todayKey).maybeSingle();
  if (existingRow && !force) return { userId: profile.id, action: "evening", forDate: todayKey, skipped: "exists" };

  const win = jbDayWindow(todayKey, tz);
  const [rows, budgets, gymPayload] = await Promise.all([
    fetchDayRows(admin, profile.id, win.startISO, now.toISOString()),
    fetchBudgets(admin, profile.id),
    fetchGymPayload(admin, profile.id),
  ]);
  const planned = jbPlannedWorkout(jbWeekdayFromKey(todayKey), gymPayload);
  const sofar = jbCloseDay({ ...rows, budgets, plannedKind: planned.kind });
  const evening = jbEveningBody({
    proteinTarget: sofar.caps.proteinTarget, proteinToday: sofar.protein,
    caloriesTarget: sofar.caps.caloriesTarget, caloriesToday: sofar.calories,
    plannedKind: planned.kind, plannedName: planned.name, workoutLogged: sofar.workoutDone,
    spendCap: sofar.caps.spendCap, todaySpend: sofar.spend,
  });

  const briefingId = await upsertBriefing(admin, profile.id, "evening", todayKey, evening.body, {
    headline: evening.headline, nudges: evening.nudges, snapshot: sofar,
  });

  const delivery: Record<string, unknown> = {};
  delivery.push = await sendPush(admin, profile, evening.headline, evening.nudges.join(" · ") || evening.body, now);
  // Only email when something is still fixable - an "all clear" at 20:30 is not
  // worth an inbox interruption, and unread mail is how people learn to ignore
  // the ones that matter.
  if (evening.nudges.length) {
    delivery.email = await sendEmail(admin, profile.id, "evening", {
      body: evening.body, bullets: evening.nudges, forDate: todayKey, profile,
      subject: `Evening check-in - ${evening.nudges.length} thing${evening.nudges.length === 1 ? "" : "s"} still open`,
    });
  }

  await auditLog(admin, profile.id, "jarvis.evening", { forDate: todayKey, briefingId, nudges: evening.nudges.length, delivery });
  return { userId: profile.id, action: "evening", forDate: todayKey, briefingId, nudges: evening.nudges, delivery };
}

async function runStatus(admin: any, profile: Profile) {
  const { data: latest } = await admin.from("briefings")
    .select("kind, for_date, created_at, seen")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false }).limit(6);
  const { count: pushCount } = await admin.from("push_subscriptions")
    .select("id", { count: "exact", head: true }).eq("user_id", profile.id);
  return {
    userId: profile.id,
    action: "status",
    latest: latest || [],
    pushSubscriptions: pushCount ?? 0,
    config: {
      resend: Boolean(await resolveSecretOptional("RESEND_API_KEY")),
      vapid: Boolean(await resolveSecretOptional("JARVIS_VAPID_JWK")),
      cronSecret: Boolean(await resolveSecretOptional("JARVIS_CRON_SECRET")),
      deepseek: Boolean(await resolveAnySecret(["DEEPSEEK_API_KEY", "NVIDIA_API_KEY"])),
      gemini: Boolean(await resolveSecretOptional("GEMINI_API_KEY")),
    },
  };
}

// -------- handler --------

Deno.serve(async (req) => {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-jarvis-secret",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const payload = await req.json().catch(() => ({}));
    const action = String(payload?.action || "");
    const force = Boolean(payload?.force);
    if (!["closeout", "morning", "evening", "status"].includes(action)) {
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400, headers: corsHeaders });
    }

    const admin = adminClient();
    const now = new Date();

    // Auth: cron secret runs every enabled user; a user JWT runs only itself.
    let profiles: Profile[] = [];
    const cronSecret = await resolveSecretOptional("JARVIS_CRON_SECRET");
    const headerSecret = req.headers.get("x-jarvis-secret") || "";
    if (cronSecret && headerSecret && safeEqual(headerSecret, cronSecret)) {
      const { data, error } = await admin.from("profiles").select("*").eq("briefing_enabled", true);
      if (error) return Response.json({ ok: false, error: `profiles read failed: ${error.message}` }, { status: 500, headers: corsHeaders });
      // Skip fixture accounts. An abandoned E2E signup (e2e_*@test.local) was
      // still a live profile row, so every slot ran the whole brief pipeline
      // twice - doubling LLM spend and firing Resend at an address that cannot
      // exist, which risks the sender reputation the real brief depends on.
      profiles = (data || []).filter((p: Profile) => !isFixtureProfile(p));
    } else {
      const auth = req.headers.get("authorization") || "";
      const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!jwt) return Response.json({ ok: false, error: "missing_auth" }, { status: 401, headers: corsHeaders });
      const { data: userResp, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userResp?.user?.id) {
        return Response.json({ ok: false, error: "invalid_auth" }, { status: 401, headers: corsHeaders });
      }
      const { data: prof } = await admin.from("profiles").select("*").eq("id", userResp.user.id).maybeSingle();
      if (prof) profiles = [prof];
    }

    const results: unknown[] = [];
    for (const profile of profiles) {
      try {
        if (action === "status") { results.push(await runStatus(admin, profile)); continue; }
        if (action === "morning") { results.push(await runMorning(admin, profile, now, force)); continue; }
        if (action === "evening") { results.push(await runEvening(admin, profile, now, force)); continue; }
        // closeout: close the most recently ENDED local day (at 00:05 IST that is
        // yesterday); an explicit payload.date closes that civil day instead.
        const tz = profile.timezone || "Asia/Kolkata";
        const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date || ""))
          ? String(payload.date)
          : jbAddDays(jbDateKeyInTz(now, tz), -1);
        results.push(await runCloseout(admin, profile, dateKey, force));
      } catch (err) {
        results.push({ userId: profile.id, action, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return Response.json({ ok: true, action, users: profiles.length, results }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
