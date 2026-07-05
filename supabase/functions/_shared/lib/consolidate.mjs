// Sleep consolidation: compress episodic rows (the day's raw logs) into durable
// semantic memory (memory_facts patterns) — and FORGET on purpose: a pattern
// that stops being reinforced decays nightly and is eventually deleted, so the
// AI's memory tracks who the user is NOW, not who they were in March.
//
// Pure planner: rows + existing facts in → { upserts, decays, deletes } out.
// The nightly function applies the plan with service role; the agent's
// <memory_context> KNOWS section then feeds it back into every future capture.
//
// Only keys MANAGED here (CONSOLIDATED_KEYS) are ever decayed or deleted —
// user-stated facts and model-emitted remember_fact rows are never touched.

const DAY_MS = 86_400_000;

export const CONSOLIDATED_KEYS = Object.freeze([
  "usual_breakfast", "usual_lunch", "usual_dinner", "usual_snack",
  "gym_days_actual", "avg_daily_spend_30d", "top_merchant_30d", "late_night_eater",
]);

const DECAY_STEP = 0.12;      // confidence lost per night without reinforcement
const DELETE_BELOW = 0.35;    // forgotten entirely under this
const MIN_SUPPORT = 3;        // observations needed before a pattern is believed

function dayKeyOf(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mode(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  for (const [k, n] of counts) if (!best || n > best.n) best = { k, n };
  return best;
}

// Confidence grows with support but saturates — 3 sightings ≈ 0.62, 6 ≈ 0.78,
// 10+ ≈ 0.9. Reinforcement is re-upserting at the new confidence.
function confidenceFor(support) {
  return Math.min(0.9, 0.4 + 0.075 * support);
}

// rows: { ledger, foodLogs, workoutLogs } over the trailing ~28 days, ISO in
// the user's wall clock. existingFacts: memory_facts rows (key, value, kind,
// confidence, source). now: Date (wall clock).
export function consolidate(rows, existingFacts = [], now = new Date()) {
  const nowMs = now.getTime();
  const upserts = [];
  const observedKeys = new Set();

  const cutoff = nowMs - 28 * DAY_MS;
  const foods = (rows?.foodLogs || []).filter((r) => new Date(r.occurred_at).getTime() >= cutoff);
  const ledger = (rows?.ledger || []).filter((r) => new Date(r.occurred_at).getTime() >= cutoff);
  const workouts = (rows?.workoutLogs || []).filter((r) => new Date(r.occurred_at).getTime() >= cutoff);

  // Usual meal per slot: the modal meal name, if it repeats enough.
  for (const slot of ["breakfast", "lunch", "dinner", "snack"]) {
    const names = foods
      .filter((r) => r.meal_slot === slot)
      .map((r) => String(r.meal_name || r.description || "").toLowerCase().trim().slice(0, 60))
      .filter(Boolean);
    const m = mode(names);
    if (m && m.n >= MIN_SUPPORT) {
      const key = `usual_${slot}`;
      observedKeys.add(key);
      upserts.push({ key, value: m.k, kind: "pattern", confidence: confidenceFor(m.n), support: m.n });
    }
  }

  // Actual training days (vs the planned ones): weekdays with ≥2 workouts.
  {
    const perDay = new Map();
    for (const w of workouts) {
      const wd = new Date(w.occurred_at).toLocaleDateString("en-IN", { weekday: "short" });
      perDay.set(wd, (perDay.get(wd) || 0) + 1);
    }
    const days = [...perDay.entries()].filter(([, n]) => n >= 2).map(([d]) => d);
    if (days.length) {
      observedKeys.add("gym_days_actual");
      upserts.push({
        key: "gym_days_actual", value: days.join(","), kind: "pattern",
        confidence: confidenceFor(workouts.length), support: workouts.length,
      });
    }
  }

  // Average daily spend, if there's enough signal.
  {
    const expenseDays = new Set(ledger.filter((r) => r.direction === "expense").map((r) => dayKeyOf(r.occurred_at)));
    const total = ledger.filter((r) => r.direction === "expense").reduce((s, r) => s + Number(r.amount || 0), 0);
    if (expenseDays.size >= 7) {
      observedKeys.add("avg_daily_spend_30d");
      upserts.push({
        key: "avg_daily_spend_30d", value: String(Math.round(total / 28)), kind: "pattern",
        confidence: confidenceFor(expenseDays.size), support: expenseDays.size,
      });
    }
  }

  // Top repeated merchant.
  {
    const counts = new Map();
    for (const r of ledger) {
      if (r.direction !== "expense" || !r.merchant) continue;
      const k = String(r.merchant).toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null;
    for (const [k, n] of counts) if (n >= MIN_SUPPORT && (!best || n > best.n)) best = { k, n };
    if (best) {
      observedKeys.add("top_merchant_30d");
      upserts.push({ key: "top_merchant_30d", value: best.k, kind: "pattern", confidence: confidenceFor(best.n), support: best.n });
    }
  }

  // Late-night eating tendency (22:30+ meals on ≥4 of the last 28 days).
  {
    const lateDays = new Set(
      foods.filter((r) => {
        const d = new Date(r.occurred_at);
        return d.getHours() > 22 || (d.getHours() === 22 && d.getMinutes() >= 30);
      }).map((r) => dayKeyOf(r.occurred_at)),
    );
    if (lateDays.size >= 4) {
      observedKeys.add("late_night_eater");
      upserts.push({ key: "late_night_eater", value: `late meals ${lateDays.size}/28 days`, kind: "pattern", confidence: confidenceFor(lateDays.size), support: lateDays.size });
    }
  }

  // Forgetting: managed facts NOT observed tonight decay; below floor, delete.
  const decays = [];
  const deletes = [];
  for (const f of existingFacts) {
    if (!CONSOLIDATED_KEYS.includes(f.key) || observedKeys.has(f.key)) continue;
    if (f.source && f.source !== "ai") continue; // never decay user-stated facts
    const next = Number((Number(f.confidence ?? 0.7) - DECAY_STEP).toFixed(4));
    if (next < DELETE_BELOW) deletes.push({ key: f.key, was: f.confidence });
    else decays.push({ key: f.key, confidence: next });
  }

  return { upserts, decays, deletes };
}
