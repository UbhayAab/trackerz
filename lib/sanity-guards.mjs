// [STAGE 9] sanity [ranges] - pure, dependency-free, browser+Node isomorphic.
//
// sanityCheck(toolName, args, nowIso) -> { ok:boolean, flags:string[] }
//
// This is the SANITY stage: a value-plausibility tagger that the schema/grounding
// stages cannot express. validateToolArguments (src/agent/tool-schemas.js) has a
// FLAT field->[lo,hi] range map and cannot branch on metric_type, so a 50,000-cal
// meal or a year-3025 date passes schema + grounding and auto-commits (the approve
// gate runs at AUTO_APPLY_MIN_CONFIDENCE=0). This stage catches those.
//
// HARD CONTRACT (do not relax):
//   - TAG ONLY. Never throws, never blocks, never rejects, never mutates args.
//     The reject/validate paths are LOSSY (the capture vanishes); this stage runs
//     AFTER validation on already-valid calls and only annotates.
//   - Unknown tool name        -> { ok:true, flags:[] } (pass-through).
//   - Unknown metric_type      -> no body-metric value flag (pass-through branch).
//   - nowIso is PASSED IN. Never call Date.now() internally - the edge passes its
//     own clock and tests pass a fixed "now" for determinism.
//   - NO backticks anywhere in this file. The edge inline-mirrors this body into
//     index.ts, whose SYSTEM_PROMPT is a backtick template literal; a stray
//     backtick boot-crashes the whole Deno function.
//
// Caps are intentionally GENEROUS (a Rs 1.5L rent, an 80k-step trek, a 5500-cal
// feast must NOT flag) - a false positive that rides into the feed's review_reason
// trains the user to ignore the marker, defeating the purpose.

// --- money caps (INR) ---------------------------------------------------------
const EXPENSE_MAX = 200000;       // single discretionary/expense candidate
const BIG_MONEY_MAX = 5000000;    // income / transfer / statement row (salary, large credits)

// set_target_candidate caps, per kind.
const TARGET_CAPS = {
  daily_calories: 6000,
  weekly_calories: 42000,     // 6000 * 7
  daily_protein: 400,
  monthly_spend: 5000000,
  weekly_spend: 5000000,
  food_cap: 5000000,
};

// --- date window --------------------------------------------------------------
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;          // now + 24h
const ANCIENT_MS = 5 * 365 * 24 * 60 * 60 * 1000;     // now - 5y (approx, 365d years)

// --- diet caps ----------------------------------------------------------------
const CAL_MIN = 0;
const CAL_MAX = 6000;
const PROTEIN_MAX = 400;
const CARBS_MAX = 800;
const FAT_MAX = 400;

// --- body-metric caps, branched on metric_type --------------------------------
const METRIC_RULES = {
  weight: { lo: 20, hi: 300, flag: "weight_out_of_range" },
  sleep_hours: { lo: 0, hi: 24, flag: "sleep_hours_impossible" },
  steps: { lo: 0, hi: 100000, flag: "steps_implausible" },
  water_ml: { lo: 0, hi: 15000, flag: "water_implausible" },
};

// --- workout ------------------------------------------------------------------
const DURATION_MIN = 0;
const DURATION_MAX = 600; // >10h is implausible

// Tools whose occurred_at should sit in the plausible date window.
const DATED_TOOLS = new Set([
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_statement_row_candidate",
  "create_food_log_candidate",
  "create_workout_log_candidate",
  "create_body_metric_candidate",
]);

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pushAmountFlag(flags, value, cap) {
  if (isFiniteNum(value) && Math.abs(value) > cap) {
    flags.push("amount_too_large");
  }
}

function checkOccurredAt(flags, occurredAt, nowMs) {
  if (typeof occurredAt !== "string" || occurredAt === "") return;
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return; // unparseable date is the schema stage's job, not ours
  if (t > nowMs + FUTURE_GRACE_MS) flags.push("future_date");
  else if (t < nowMs - ANCIENT_MS) flags.push("ancient_date");
}

export function sanityCheck(toolName, args, nowIso) {
  const flags = [];
  // Never throw: defend every assumption.
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: true, flags: [] };
    }

    let nowMs = Date.parse(typeof nowIso === "string" ? nowIso : "");
    if (Number.isNaN(nowMs)) nowMs = Date.now(); // last-resort only if caller passed garbage

    switch (toolName) {
      case "create_expense_candidate": {
        pushAmountFlag(flags, args.amount, EXPENSE_MAX);
        checkOccurredAt(flags, args.occurred_at, nowMs);
        break;
      }
      case "create_income_candidate":
      case "create_transfer_candidate":
      case "create_statement_row_candidate": {
        pushAmountFlag(flags, args.amount, BIG_MONEY_MAX);
        checkOccurredAt(flags, args.occurred_at, nowMs);
        break;
      }
      case "create_food_log_candidate": {
        const cal = args.calories_estimate;
        if (isFiniteNum(cal) && (cal < CAL_MIN || cal > CAL_MAX)) {
          flags.push("calories_implausible");
        }
        const p = args.protein_g;
        const c = args.carbs_g;
        const f = args.fat_g;
        const proteinBad = isFiniteNum(p) && (p < 0 || p > PROTEIN_MAX);
        const carbsBad = isFiniteNum(c) && (c < 0 || c > CARBS_MAX);
        const fatBad = isFiniteNum(f) && (f < 0 || f > FAT_MAX);
        if (proteinBad || carbsBad || fatBad) flags.push("macros_implausible");
        checkOccurredAt(flags, args.occurred_at, nowMs);
        break;
      }
      case "create_workout_log_candidate": {
        const d = args.duration_min;
        if (isFiniteNum(d) && (d < DURATION_MIN || d > DURATION_MAX)) {
          flags.push("duration_implausible");
        }
        checkOccurredAt(flags, args.occurred_at, nowMs);
        break;
      }
      case "create_body_metric_candidate": {
        const rule = METRIC_RULES[args.metric_type];
        if (rule && isFiniteNum(args.value) && (args.value < rule.lo || args.value > rule.hi)) {
          flags.push(rule.flag);
        }
        // Unknown metric_type -> no value flag (pass-through branch).
        checkOccurredAt(flags, args.occurred_at, nowMs);
        break;
      }
      case "set_target_candidate": {
        const cap = TARGET_CAPS[args.kind];
        if (cap !== undefined && isFiniteNum(args.amount) && args.amount > cap) {
          if (args.kind === "daily_calories" || args.kind === "weekly_calories") {
            flags.push("calories_implausible");
          } else if (args.kind === "daily_protein") {
            flags.push("protein_implausible");
          } else {
            flags.push("amount_too_large");
          }
        }
        break;
      }
      default:
        // Unknown / non-write / review tools: pass-through, never reject.
        return { ok: true, flags: [] };
    }
  } catch (_e) {
    // Absolutely never throw out of the sanity stage.
    return { ok: true, flags: [] };
  }

  return { ok: flags.length === 0, flags };
}
