// Jarvis brief brain - pure day-close, streaks, brief facts, and deterministic
// voice for the proactive engine. Browser/Node-isomorphic, dependency-free.
// The block between the MIRROR markers is byte-identical inside
// supabase/functions/jarvis/index.ts (Deno can't import repo lib/);
// tests/mirror-parity.test.mjs fails the build if the two copies diverge.
// Timezone math uses Intl only (no DST in Asia/Kolkata, handled generally anyway).

// ==== JARVIS-BRIEF MIRROR START (byte-identical in supabase/functions/jarvis/index.ts) ====
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

export {
  jbRound, jbRupees, jbTzOffsetMinutes, jbDateKeyInTz, jbDayWindow, jbAddDays,
  jbWeekdayFromKey, jbDaysLeftInMonth, jbMinutesOfDay, jbInQuietHours,
  JB_WEEKDAY_NAMES, JB_WORKOUT_BY_WEEKDAY, JB_WORKOUTS,
  jbDietLabelForWeekday, jbPlannedWorkout, jbBudgetAmount, jbDailySpendCap,
  jbCloseDay, jbNextStreaks, jbSafeToSpend, jbBriefFacts,
  jbMorningFallback, jbEveningBody, jbCloseoutBody, jbWeeklySummary,
  JB_VOICE_SYSTEM, jbVoiceUserPrompt,
};
