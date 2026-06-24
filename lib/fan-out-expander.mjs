// Deterministic fan-out: guarantees a single real event lands in every tracker
// it belongs to, even when the model under-emits. The headline case: a food
// PURCHASE is both a money event AND a diet event, so an expense at a food
// merchant (with no matching food_log already) gets a food_log synthesized at
// the same time. Pure (no DOM/Supabase) so it's tested; the edge function keeps
// an inline mirror of this logic.

const FOOD_MERCHANTS = [
  "zomato", "swiggy", "blinkit", "zepto", "instamart", "dominos", "domino", "mcdonald", "kfc",
  "starbucks", "subway", "pizza", "burger", "cafe", "coffee", "restaurant", "dhaba", "bakery",
  "biryani", "faasos", "eatfit", "box8", "behrouz", "wow momo", "chaayos", "haldiram", "barbeque",
];
const FOOD_WORDS = [
  "lunch", "dinner", "breakfast", "snack", "meal", "thali", "biryani", "roti", "dal", "sabzi",
  "rice", "paneer", "egg", "chicken", "mutton", "dosa", "idli", "poha", "sandwich", "salad",
  "shake", "smoothie", "fruit", "curd", "yogurt", "momo", "noodles", "pasta", "ate", "eaten", "food",
];

export function looksLikeFood(text = "") {
  const t = String(text).toLowerCase();
  if (FOOD_MERCHANTS.some((m) => t.includes(m))) return true;
  return FOOD_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

export function mealSlotFromTime(iso) {
  const m = String(iso).match(/T(\d{2}):/);
  const h = m ? Number(m[1]) : 12;
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 15 && h < 18) return "snack";
  if (h >= 18 && h < 23) return "dinner";
  return "other";
}

function minutesApart(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

// Given the model's validated tool calls, return them PLUS any synthesized
// fan-out calls. Currently: expense at a food merchant -> a food_log at the same
// time (unless one already exists within 2 minutes).
export function expandToolCalls(toolCalls = [], { evidence = "", now = "" } = {}) {
  let out = [...toolCalls];
  const foodLogs = toolCalls.filter((tc) => tc.name === "create_food_log_candidate");
  for (const tc of toolCalls) {
    if (tc.name !== "create_expense_candidate") continue;
    const a = tc.arguments || {};
    if (!looksLikeFood(`${a.merchant || ""} ${a.description || ""}`)) continue;
    const occurredAt = a.occurred_at;
    const dup = foodLogs.some((f) => minutesApart(f.arguments?.occurred_at, occurredAt) <= 2);
    if (dup) continue;
    out.push({
      name: "create_food_log_candidate",
      arguments: {
        meal_slot: mealSlotFromTime(occurredAt),
        description: `${a.merchant || a.description || "meal"} (auto from spend)`,
        occurred_at: occurredAt,
        _auto_expanded: true,
      },
      confidence: Math.round(Number(tc.confidence || 0.7) * 0.6 * 100) / 100,
    });
  }
  // Pure-food fallback: the model logged nothing (or only asked for review) but the
  // text is clearly food/drink -> log it so "had coffee and 5 cookies" still counts.
  const hasWrite = out.some((tc) => typeof tc?.name === "string" && tc.name.startsWith("create_"));
  if (!hasWrite && looksLikeFood(evidence)) {
    out = out.filter((tc) => tc?.name !== "request_user_review");
    const occurredAt = now || new Date().toISOString();
    out.push({
      name: "create_food_log_candidate",
      arguments: {
        meal_slot: mealSlotFromTime(occurredAt),
        description: String(evidence).trim().slice(0, 120),
        occurred_at: occurredAt,
        _auto_expanded: true,
      },
      confidence: 0.5,
    });
  }
  return out;
}
