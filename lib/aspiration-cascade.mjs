// Pure, isomorphic (no DOM/Supabase) mapping from a free-text aspiration/goal
// note to a set of budget/target changes, plus the undo math for reverting one.
// The mapping is intentionally a thin, testable layer: extract a number, pick a
// target kind. It does NOT know the user's income or current defaults, so it
// emits absolute target amounts and tags each with a `reason`; the caller is
// responsible for filtering kinds it doesn't support and deciding final values.
//
// Chosen constants (defaults aren't passed in here, so these are hard-coded):
//   - bulk:  daily_calories -> 2300 (a raise from the 2000 default)
//            daily_protein  -> 180  (a raise from the 162 default)
//   - cut:   daily_calories -> 1700 (a cut from the 2000 default)

const BULK_CALORIES = 2300;
const BULK_PROTEIN = 180;
const CUT_CALORIES = 1700;

// Parse the first number in the text, supporting "50k", "50,000", "₹50000".
function parseNumber(text) {
  const t = String(text).toLowerCase();
  // Match a number optionally followed by a 'k' suffix, allowing commas/₹/rs.
  const m = t.match(/(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1000; // "50k" -> 50000
  return n;
}

// Map an aspiration string -> array of { kind, amount, reason } target changes.
// Returns [] for text that isn't a recognized financial/fitness goal.
export function mapAspirationToTargets(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return [];
  const changes = [];

  // --- Money: "save N (this month)" -> a monthly_spend cap.
  // We can't know income here, so we interpret the number as the cap value and
  // let the caller refine it. (Documented: "save N a month" => monthly_spend N.)
  if (/\bsave\b/.test(t)) {
    const n = parseNumber(t);
    if (n != null) changes.push({ kind: "monthly_spend", amount: n, reason: "save-goal" });
  }

  // --- Diet: bulk / gain weight -> raise calories + protein.
  if (/\blean bulk\b|\bbulk\b|\bgain weight\b/.test(t)) {
    changes.push({ kind: "daily_calories", amount: BULK_CALORIES, reason: "bulk" });
    changes.push({ kind: "daily_protein", amount: BULK_PROTEIN, reason: "bulk" });
  } else if (/\bcut\b|\blose weight\b|\bshred\b/.test(t)) {
    // --- Diet: cut / lose weight / shred -> lower calories.
    changes.push({ kind: "daily_calories", amount: CUT_CALORIES, reason: "cut" });
  }

  // --- Fitness frequency: "gym Nx", "workout Nx", "N times a week".
  // weekly_workouts may not be a real budget kind yet — emit it; caller filters.
  const freq =
    t.match(/(?:gym|workout|train)\D*?(\d+)\s*x/) ||
    t.match(/(\d+)\s*x\s*(?:a|per|\/)?\s*week/) ||
    t.match(/(\d+)\s*times?\s*(?:a|per|\/)?\s*week/);
  if (freq) {
    const n = Number(freq[1]);
    if (Number.isFinite(n)) changes.push({ kind: "weekly_workouts", amount: n, reason: "frequency" });
  }

  return changes;
}

// Undo math for an audited target change. Given the prior value (number or null):
//   null  -> the target didn't exist before, so delete it.
//   value -> restore it via upsert with the numeric prior amount.
export function revertTarget(before) {
  if (before == null) return { action: "delete" };
  return { action: "upsert", amount: Number(before) };
}
