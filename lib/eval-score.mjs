// SCORING FOR THE CAPTURE EVAL CORPUS.
//
// Every historical capture becomes a test case with an expected tool-call set.
// The scoring has to be partial-credit or the suite is too brittle to keep - a
// fan-out that gets 2 of 3 tools right is not the same failure as one that
// invents a meal - but it also has to be RUTHLESS about the one class of error
// that actually hurt this user:
//
//   A `must_not` hit is a HARD FAIL scoring zero for the case, regardless of
//   everything else it got right.
//
// That asymmetry is the whole design. A phantom meal built from an instruction
// (2026-08-06, 540 kcal) or a note filed as food (2026-08-04, 432 kcal) would
// otherwise be averaged away by 199 passing cases and never fail a build.
//
// Pure: no fs, no network, no clock.

// Tools that put a row in a TRACKER, as opposed to a note or a plan. Mirrors the
// set in lib/fan-out-expander.mjs - kept local so the scorer stays dependency-free.
const LOG_TOOLS = new Set([
  "create_food_log_candidate",
  "create_workout_log_candidate",
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_hydration_candidate",
  "create_body_metric_candidate",
]);

/** Tool names present in an actual result, as a multiset. */
function nameCounts(calls = []) {
  const m = new Map();
  for (const c of calls) {
    const n = c?.name;
    if (!n) continue;
    m.set(n, (m.get(n) || 0) + 1);
  }
  return m;
}

/** Walk a dotted path, tolerating absent intermediate objects. */
export function valueAt(obj, path) {
  return String(path).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Check one argument predicate against a tool call.
 * Supported: exact equality, { contains: [...] }, { matches: "/re/flags" },
 * { atLeast: n }, { absent: true }.
 */
export function checkArg(actualValue, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (expected.absent) return actualValue === undefined || actualValue === null;
    if (expected.contains) {
      const hay = String(actualValue ?? "").toLowerCase();
      return expected.contains.every((needle) => hay.includes(String(needle).toLowerCase()));
    }
    if (expected.matches) {
      const m = /^\/(.*)\/([a-z]*)$/.exec(expected.matches);
      const re = m ? new RegExp(m[1], m[2]) : new RegExp(expected.matches);
      return re.test(String(actualValue ?? ""));
    }
    if (expected.atLeast != null) return Number(actualValue) >= expected.atLeast;
    if (expected.atMost != null) return Number(actualValue) <= expected.atMost;
    if (expected.within != null && expected.of != null) {
      return Math.abs(Number(actualValue) - expected.of) <= expected.within;
    }
  }
  return actualValue === expected;
}

/**
 * Score one case.
 * @returns {{score:number, hard:string[], misses:string[], extras:string[]}}
 */
export function scoreCase(expected = {}, actual = {}) {
  const calls = actual.toolCalls || [];
  const counts = nameCounts(calls);
  const hard = [];
  const misses = [];
  const extras = [];

  // HARD FAILS FIRST. Nothing else can rescue these.
  for (const forbidden of expected.must_not || []) {
    if (counts.get(forbidden)) hard.push(`emitted forbidden tool: ${forbidden}`);
  }
  if (expected.max_rows != null) {
    // Only rows in a TRACKER count. A note is not a logged event - it is the
    // model correctly saying "this is prose", which is exactly the right answer
    // for a capture that talks about food without eating any. Counting every
    // `create_*` would make "wrote a note" indistinguishable from "invented a
    // meal", which is the distinction this whole suite exists to enforce.
    const writes = calls.filter((c) => LOG_TOOLS.has(c?.name)).length;
    if (writes > expected.max_rows) hard.push(`wrote ${writes} tracker rows, max ${expected.max_rows}`);
  }

  // Tool-set recall, with partial credit.
  const must = expected.must || [];
  let toolHits = 0;
  for (const req of must) {
    const name = typeof req === "string" ? req : req.tool;
    const n = counts.get(name) || 0;
    const min = typeof req === "string" ? 1 : (req.min ?? 1);
    const max = typeof req === "string" ? Infinity : (req.max ?? Infinity);
    if (n >= min && n <= max) toolHits += 1;
    else misses.push(n === 0 ? `missing ${name}` : `${name} x${n}, wanted ${min}..${max === Infinity ? "*" : max}`);
  }
  const toolScore = must.length ? toolHits / must.length : 1;

  // Argument checks on the matched tools.
  let argTotal = 0;
  let argHits = 0;
  for (const req of must) {
    if (typeof req === "string" || !req.args) continue;
    const call = calls.find((c) => c?.name === req.tool);
    for (const [path, want] of Object.entries(req.args)) {
      argTotal += 1;
      if (call && checkArg(valueAt(call.arguments || {}, path), want)) argHits += 1;
      else misses.push(`${req.tool}.${path}`);
    }
  }
  const argScore = argTotal ? argHits / argTotal : 1;

  // Anything emitted that was neither required nor explicitly allowed. Recorded
  // but NOT scored: a harmless extra note should not fail a case, or the suite
  // becomes too brittle to keep passing and gets deleted.
  const allowed = new Set([...(expected.allowed || []), ...must.map((r) => (typeof r === "string" ? r : r.tool))]);
  for (const [name] of counts) if (!allowed.has(name)) extras.push(name);

  const score = hard.length ? 0 : 0.7 * toolScore + 0.3 * argScore;
  return { score, hard, misses, extras };
}

/** Aggregate, weighted, with per-tag breakdown so a class of failure is visible. */
export function scoreSuite(cases = []) {
  let weighted = 0;
  let weight = 0;
  const hardFails = [];
  const byTag = new Map();

  for (const c of cases) {
    const w = c.weight ?? 1;
    weighted += c.result.score * w;
    weight += w;
    if (c.result.hard.length) hardFails.push({ id: c.id, why: c.result.hard });
    for (const tag of c.tags || []) {
      const t = byTag.get(tag) || { total: 0, n: 0 };
      t.total += c.result.score;
      t.n += 1;
      byTag.set(tag, t);
    }
  }

  return {
    mean: weight ? weighted / weight : 1,
    hardFails,
    byTag: Object.fromEntries([...byTag].map(([k, v]) => [k, v.total / v.n])),
    count: cases.length,
  };
}
