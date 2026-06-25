// Pure, isomorphic (no DOM/Supabase) assembly of the Jarvis "memory context"
// block that gets injected into every AI reasoning call, plus a deterministic
// "did my usual" expander. Sections are emitted in a fixed PRIORITY order and
// accumulated under a hard char cap — earlier sections survive, later ones get
// dropped cleanly at a line boundary. LAST7 is O(1) in history size (sums only,
// never lists rows). The edge function keeps an inline mirror of this prompt
// shaping; keep this the source of truth for tests.

function clean(v) {
  // Render a scalar safely: never let undefined/null/NaN leak into the prompt.
  if (v === undefined || v === null) return "";
  if (typeof v === "number" && !Number.isFinite(v)) return "";
  const s = String(v).trim();
  if (s === "undefined" || s === "null" || s === "NaN") return "";
  return s;
}

function rupees(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return `₹${n.toLocaleString("en-IN")}`;
}

function profileLine(profile) {
  if (!profile) return "";
  const parts = [
    clean(profile.display_name),
    clean(profile.timezone),
    clean(profile.currency),
  ].filter(Boolean);
  if (!parts.length) return "";
  return `PROFILE: ${parts.join(" · ")}`;
}

function targetsLine(budgets) {
  if (!Array.isArray(budgets) || !budgets.length) return "";
  const parts = [];
  for (const b of budgets) {
    if (!b) continue;
    const kind = clean(b.kind);
    if (!kind) continue;
    const amt = Number(b.amount);
    if (!Number.isFinite(amt)) continue;
    // Money-ish kinds render with the rupee glyph; others render the bare number.
    const money = /spend|budget|income|sav/i.test(kind);
    parts.push(`${kind} ${money ? rupees(amt) : amt}`);
  }
  if (!parts.length) return "";
  return `TARGETS: ${parts.join(", ")}`;
}

function openLines(notes) {
  if (!Array.isArray(notes) || !notes.length) return "";
  const open = notes
    .filter((n) => n && clean(n.body || n.text || n.summary))
    .slice(0, 8)
    .map((n) => {
      const kind = clean(n.kind) || "note";
      const domain = clean(n.domain) || "general";
      const body = clean(n.body || n.text || n.summary);
      const due = clean(n.due_date || n.due);
      return `[${kind} ${domain}] ${body}${due ? ` (due ${due})` : ""}`;
    });
  if (!open.length) return "";
  return `OPEN:\n${open.map((l) => `  ${l}`).join("\n")}`;
}

function knowsLines(memoryFacts) {
  if (!Array.isArray(memoryFacts) || !memoryFacts.length) return "";
  // Caller is assumed to sort by confidence desc; sort defensively anyway.
  const sorted = [...memoryFacts]
    .filter((f) => f && clean(f.key))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 12)
    .map((f) => `${clean(f.key)}="${clean(f.value)}"`);
  if (!sorted.length) return "";
  return `KNOWS: ${sorted.join(", ")}`;
}

function last7Line({ recentLedger, recentFoodLogs, recentWorkouts }) {
  // Aggregate-only: O(1) in history size, never lists individual rows.
  let spent = 0;
  let txns = 0;
  if (Array.isArray(recentLedger)) {
    for (const r of recentLedger) {
      if (!r) continue;
      const dir = clean(r.direction);
      const amt = Number(r.amount);
      if (dir === "income") continue; // only sum spend
      if (Number.isFinite(amt)) {
        spent += Math.abs(amt);
        txns += 1;
      }
    }
  }
  let meals = 0;
  let cal = 0;
  let protein = 0;
  if (Array.isArray(recentFoodLogs)) {
    for (const f of recentFoodLogs) {
      if (!f) continue;
      meals += 1;
      const c = Number(f.calories_estimate ?? f.calories);
      const p = Number(f.protein_g ?? f.protein);
      if (Number.isFinite(c)) cal += c;
      if (Number.isFinite(p)) protein += p;
    }
  }
  const workouts = Array.isArray(recentWorkouts) ? recentWorkouts.length : 0;

  if (!txns && !meals && !workouts) return "";
  const avgCal = meals ? Math.round(cal / meals) : 0;
  const avgP = meals ? Math.round(protein / meals) : 0;
  return `LAST7: spent ${rupees(spent)} (${txns} txns) · ${meals} meals avg ${avgCal} cal/${avgP} P · ${workouts} workouts`;
}

function planTodayLine(planToday) {
  if (!planToday) return "";
  if (typeof planToday === "string") {
    const s = clean(planToday);
    return s ? `PLAN_TODAY: ${s}` : "";
  }
  const summary = clean(planToday.summary);
  if (summary) return `PLAN_TODAY: ${summary}`;
  const bits = [];
  if (Array.isArray(planToday.meals)) {
    for (const m of planToday.meals) {
      const name = clean(m?.name || m?.detail || m?.slot);
      if (name) bits.push(name);
    }
  }
  const workout = clean(planToday.workout?.name || planToday.workout?.description || planToday.workout);
  if (workout) bits.push(`workout: ${workout}`);
  if (!bits.length) return "";
  return `PLAN_TODAY: ${bits.join(", ")}`;
}

// Assemble the labelled context block. Sections are produced in priority order
// and packed under maxChars; a section that would overflow is included only as
// far as it fits (cut at a line boundary), then accumulation stops.
export function buildContextBlock(inputs = {}, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 1800;
  const {
    profile,
    budgets,
    notes,
    memoryFacts,
    recentLedger,
    recentFoodLogs,
    recentWorkouts,
    planToday,
  } = inputs;

  // Priority order: PROFILE, TARGETS, OPEN, KNOWS, LAST7, PLAN_TODAY.
  const sections = [
    profileLine(profile),
    targetsLine(budgets),
    openLines(notes),
    knowsLines(memoryFacts),
    last7Line({ recentLedger, recentFoodLogs, recentWorkouts }),
    planTodayLine(planToday),
  ].filter(Boolean);

  let out = "";
  for (const section of sections) {
    const candidate = out ? `${out}\n${section}` : section;
    if (candidate.length <= maxChars) {
      out = candidate;
      continue;
    }
    // The section would overflow. Pack whole lines of it that still fit, then
    // stop entirely (later sections are lower priority and also dropped).
    const lines = section.split("\n");
    for (const line of lines) {
      const piece = out ? `${out}\n${line}` : line;
      if (piece.length <= maxChars) out = piece;
      else break;
    }
    break;
  }
  return out;
}

// "Did my usual": turn a resolved plan-for-a-date into synthetic tool calls so a
// one-tap "log my usual" lands every meal + the day's workout. Pure & defensive
// (planForDateResult shape may vary; guard with optional chaining). Every emitted
// argument object carries event_group_id + _auto_expanded + occurred_at.
export function expandUsualForDate({
  planForDateResult,
  mealTemplates = [],
  occurredAt,
  eventGroupId,
} = {}) {
  if (!planForDateResult) return [];
  const out = [];
  const meals = Array.isArray(planForDateResult.meals) ? planForDateResult.meals : [];
  for (const meal of meals) {
    if (!meal) continue;
    const description = clean(meal.name || meal.detail || meal.description);
    if (!description) continue;
    out.push({
      name: "create_food_log_candidate",
      arguments: {
        description,
        meal_slot: clean(meal.slot || meal.meal_slot) || undefined,
        occurred_at: occurredAt,
        event_group_id: eventGroupId,
        _auto_expanded: true,
      },
      confidence: 0.6,
    });
  }
  const workout = planForDateResult.workout;
  if (workout) {
    const description =
      clean(workout.description || workout.name || workout.detail) ||
      (typeof workout === "string" ? clean(workout) : "");
    if (description) {
      out.push({
        name: "create_workout_log_candidate",
        arguments: {
          description,
          occurred_at: occurredAt,
          event_group_id: eventGroupId,
          _auto_expanded: true,
        },
        confidence: 0.6,
      });
    }
  }
  return out;
}
