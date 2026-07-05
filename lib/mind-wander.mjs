// Mind-wandering: the default-mode network of the Jarvis brain. Fires "random"
// associations over the user's own history — random-episode replay, entity
// trajectories, forgotten threads, anomalies, cross-domain what-ifs (dreams),
// and curiosity about data gaps. Deterministic per (seed) so the same day
// produces the same thoughts (testable, resumable) while different days wander
// differently. Pure: rows + now in, candidate thoughts out; no model, no DB.
//
// Every candidate: { kind, text, salience } — kind one of
// wander | dream | question. The caller habituation-filters and picks winners.

// ---- seeded PRNG (mulberry32 over a string hash) ----------------------------

export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- helpers -----------------------------------------------------------------

const DAY_MS = 86_400_000;

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

function daysAgo(iso, now) {
  return Math.floor((now - new Date(iso).getTime()) / DAY_MS);
}

function rupees(n) {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

// ---- lenses ------------------------------------------------------------------
// Each lens looks at the rows through one associative angle and may return one
// candidate. Lenses never throw; missing data returns null.

function lensEpisodeReplay({ ledger, foodLogs, workoutLogs }, now, rand) {
  // Replay a random day 2-8 weeks back and diff it against the recent week.
  const back = 14 + Math.floor(rand() * 42);
  const target = new Date(now - back * DAY_MS);
  const key = dayKey(target);
  const spent = ledger.filter((r) => r.direction === "expense" && dayKey(r.occurred_at) === key)
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const meals = foodLogs.filter((r) => dayKey(r.occurred_at) === key).length;
  const trained = workoutLogs.some((r) => dayKey(r.occurred_at) === key);
  if (!spent && !meals && !trained) return null;
  const weekday = target.toLocaleDateString("en-IN", { weekday: "long" });
  const bits = [];
  if (spent) bits.push(`spent ${rupees(spent)}`);
  if (meals) bits.push(`logged ${meals} meal${meals === 1 ? "" : "s"}`);
  bits.push(trained ? "trained" : "didn't train");
  return {
    kind: "wander",
    text: `${back} days ago (${weekday}) you ${bits.join(", ")} — a random rewind for perspective.`,
    salience: 0.35 + (trained ? 0.05 : 0),
  };
}

function lensEntityTrajectory({ ledger }, now, rand) {
  // Pick a random repeated merchant and show its 30-day shape.
  const cutoff = now - 30 * DAY_MS;
  const byMerchant = new Map();
  for (const r of ledger) {
    if (r.direction !== "expense" || !r.merchant) continue;
    if (new Date(r.occurred_at).getTime() < cutoff) continue;
    const k = String(r.merchant).toLowerCase();
    if (!byMerchant.has(k)) byMerchant.set(k, { name: r.merchant, total: 0, count: 0 });
    const m = byMerchant.get(k);
    m.total += Number(r.amount || 0);
    m.count += 1;
  }
  const repeated = [...byMerchant.values()].filter((m) => m.count >= 3);
  if (!repeated.length) return null;
  const pick = repeated[Math.floor(rand() * repeated.length)];
  return {
    kind: "wander",
    text: `${pick.name}: ${pick.count} visits, ${rupees(pick.total)} in 30 days (~${rupees(pick.total / pick.count)} each). Worth it?`,
    salience: 0.4 + Math.min(0.3, pick.total / 10000 * 0.1),
  };
}

function lensForgottenThread({ notes }, now) {
  // Oldest still-open aspiration/todo that's gone quiet.
  const stale = (notes || [])
    .filter((n) => n.status === "open" && daysAgo(n.occurred_at || n.created_at, now) >= 7)
    .sort((a, b) => new Date(a.occurred_at || a.created_at) - new Date(b.occurred_at || b.created_at));
  if (!stale.length) return null;
  const n = stale[0];
  const age = daysAgo(n.occurred_at || n.created_at, now);
  return {
    kind: "wander",
    text: `Still open after ${age} days: "${String(n.body || "").slice(0, 80)}" — do it, drop it, or reschedule it.`,
    salience: 0.5 + Math.min(0.2, age / 60),
  };
}

function lensAnomaly({ ledger }, now) {
  // The oddest expense of the last month by z-score against the trailing mean.
  const cutoff = now - 30 * DAY_MS;
  const recent = ledger.filter((r) => r.direction === "expense" && new Date(r.occurred_at).getTime() >= cutoff);
  if (recent.length < 8) return null;
  const amounts = recent.map((r) => Number(r.amount || 0));
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const sd = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length) || 1;
  let best = null;
  for (const r of recent) {
    const z = (Number(r.amount || 0) - mean) / sd;
    if (z > 2.2 && (!best || r.amount > best.amount)) best = r;
  }
  if (!best) return null;
  return {
    kind: "wander",
    text: `Outlier: ${rupees(best.amount)} at ${best.merchant || "unknown"} on ${dayKey(best.occurred_at)} — ${Math.round(Number(best.amount) / mean)}x your typical spend. Intentional?`,
    salience: 0.6,
  };
}

// The dream: recombine unrelated fragments (spend pace × training adherence ×
// weight trend) into one synthetic what-if trajectory — REM-style synthesis,
// fully deterministic.
function lensDream({ ledger, workoutLogs, bodyMetrics }, now) {
  const cutoff = now - 28 * DAY_MS;
  const spend28 = ledger.filter((r) => r.direction === "expense" && new Date(r.occurred_at).getTime() >= cutoff)
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const workouts28 = workoutLogs.filter((r) => new Date(r.occurred_at).getTime() >= cutoff).length;
  const weights = (bodyMetrics || []).filter((m) => m.metric_type === "weight")
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  if (!spend28 && !workouts28 && weights.length < 2) return null;
  const parts = [];
  if (spend28) parts.push(`~${rupees((spend28 / 28) * 30)} spend`);
  if (workouts28) parts.push(`${Math.round((workouts28 / 4))} workouts a week`);
  if (weights.length >= 2) {
    const newest = weights[0];
    const older = weights.find((w) => daysAgo(w.occurred_at, now) >= 14) || weights[weights.length - 1];
    const span = Math.max(1, daysAgo(older.occurred_at, now) - daysAgo(newest.occurred_at, now));
    const perDay = (Number(newest.value) - Number(older.value)) / span;
    if (Math.abs(perDay) > 0.005) {
      parts.push(`weight ~${(Number(newest.value) + perDay * 30).toFixed(1)}kg in a month`);
    }
  }
  if (!parts.length) return null;
  return {
    kind: "dream",
    text: `If the last 4 weeks repeat themselves: ${parts.join(", ")}. Change the input, change the ending.`,
    salience: 0.55,
  };
}

// Curiosity: the brain notices what's MISSING and asks one question.
function lensCuriosity({ bodyMetrics, foodLogs, workoutLogs }, now) {
  const latest = (type) => {
    const rows = (bodyMetrics || []).filter((m) => m.metric_type === type);
    return rows.length ? Math.min(...rows.map((m) => daysAgo(m.occurred_at, now))) : Infinity;
  };
  const gaps = [];
  const weightGap = latest("weight");
  if (weightGap >= 7 && weightGap < 365) gaps.push({ q: `No weigh-in for ${weightGap} days — step on the scale tomorrow morning?`, s: 0.5 + weightGap / 100 });
  const sleepGap = latest("sleep_hours");
  if (sleepGap >= 5 && sleepGap < 365) gaps.push({ q: `Sleep hasn't been logged in ${sleepGap} days — how have you been sleeping?`, s: 0.45 });
  const foodGap = foodLogs.length ? Math.min(...foodLogs.map((r) => daysAgo(r.occurred_at, now))) : Infinity;
  if (foodGap >= 2 && foodGap < 365) gaps.push({ q: `${foodGap} days with no meals logged — fell off, or just busy?`, s: 0.55 });
  const gymGap = workoutLogs.length ? Math.min(...workoutLogs.map((r) => daysAgo(r.occurred_at, now))) : Infinity;
  if (gymGap >= 4 && gymGap < 365) gaps.push({ q: `Last workout was ${gymGap} days ago — is the plan too heavy right now?`, s: 0.6 });
  if (!gaps.length) return null;
  gaps.sort((a, b) => b.s - a.s);
  return { kind: "question", text: gaps[0].q, salience: gaps[0].s };
}

const LENSES = [lensEpisodeReplay, lensEntityTrajectory, lensForgottenThread, lensAnomaly, lensDream, lensCuriosity];

// ---- the wander --------------------------------------------------------------
// rows: { ledger, foodLogs, workoutLogs, bodyMetrics, notes } (wall-clock ISO).
// Returns ALL candidates sorted by salience desc — caller applies habituation
// then takes the top thought + question.
export function wander(rows, { seed = "seed", now = 0 } = {}) {
  const rand = mulberry32(hashSeed(seed));
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const safe = {
    ledger: rows?.ledger || [], foodLogs: rows?.foodLogs || [],
    workoutLogs: rows?.workoutLogs || [], bodyMetrics: rows?.bodyMetrics || [],
    notes: rows?.notes || [],
  };
  const candidates = [];
  for (const lens of LENSES) {
    try {
      const c = lens(safe, nowMs, rand);
      if (c && c.text) candidates.push(c);
    } catch { /* a lens never sinks the wander */ }
  }
  // Tiny seeded jitter so equal-salience candidates rotate day to day.
  for (const c of candidates) c.salience += rand() * 0.08;
  return candidates.sort((a, b) => b.salience - a.salience);
}
