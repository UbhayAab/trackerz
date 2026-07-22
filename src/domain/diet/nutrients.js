// Full macro + micronutrient panel for the fixed plan, transcribed from the
// plan's own Macro/Vitamin/Mineral verification tables. Each entry carries the
// daily target (RDA, or an upper limit for `limit` nutrients) plus what the plan
// delivers on a Soybean day vs a Paneer-Soy day. Pure data + helpers - tested.

export const NUTRIENTS = [
  // Macros
  { key: "calories", label: "Calories", unit: "kcal", group: "macro", target: 2000, soybean: 2012, paneerSoy: 1961 },
  { key: "protein", label: "Protein", unit: "g", group: "macro", target: 162, soybean: 164, paneerSoy: 158 },
  { key: "carbs", label: "Carbs", unit: "g", group: "macro", target: 188, soybean: 190, paneerSoy: 183 },
  { key: "fat", label: "Fat", unit: "g", group: "macro", target: 77, soybean: 77, paneerSoy: 76 },
  { key: "fiber", label: "Fiber", unit: "g", group: "macro", target: 38, soybean: 48, paneerSoy: 45 },
  { key: "sat_fat", label: "Saturated fat", unit: "g", group: "macro", target: 22, soybean: 19, paneerSoy: 22, limit: true },
  // Minerals
  { key: "sodium", label: "Sodium", unit: "mg", group: "mineral", target: 2300, soybean: 1739, paneerSoy: 1722, limit: true },
  { key: "potassium", label: "Potassium", unit: "mg", group: "mineral", target: 3400, soybean: 5141, paneerSoy: 4821 },
  { key: "calcium", label: "Calcium", unit: "mg", group: "mineral", target: 1000, soybean: 1321, paneerSoy: 1376 },
  { key: "magnesium", label: "Magnesium", unit: "mg", group: "mineral", target: 400, soybean: 864, paneerSoy: 825 },
  { key: "iron", label: "Iron", unit: "mg", group: "mineral", target: 8, soybean: 19.3, paneerSoy: 16.1 },
  { key: "zinc", label: "Zinc", unit: "mg", group: "mineral", target: 11, soybean: 11.2, paneerSoy: 11.1 },
  { key: "copper", label: "Copper", unit: "mg", group: "mineral", target: 0.9, soybean: 2.25, paneerSoy: 2.06 },
  { key: "iodine", label: "Iodine", unit: "mcg", group: "mineral", target: 150, soybean: 234, paneerSoy: 214 },
  { key: "manganese", label: "Manganese", unit: "mg", group: "mineral", target: 2.3, soybean: 6.62, paneerSoy: 6.26 },
  { key: "molybdenum", label: "Molybdenum", unit: "mcg", group: "mineral", target: 45, soybean: 85, paneerSoy: 52 },
  { key: "phosphorus", label: "Phosphorus", unit: "mg", group: "mineral", target: 700, soybean: 2335, paneerSoy: 2174 },
  { key: "selenium", label: "Selenium", unit: "mcg", group: "mineral", target: 55, soybean: 148, paneerSoy: 142 },
  // Vitamins
  { key: "vit_a", label: "Vitamin A", unit: "mcg", group: "vitamin", target: 900, soybean: 1550, paneerSoy: 1544 },
  { key: "vit_b1", label: "B1 Thiamin", unit: "mg", group: "vitamin", target: 1.2, soybean: 1.35, paneerSoy: 1.26 },
  { key: "vit_b2", label: "B2 Riboflavin", unit: "mg", group: "vitamin", target: 1.3, soybean: 3.59, paneerSoy: 3.37 },
  { key: "vit_b3", label: "B3 Niacin", unit: "mg NE", group: "vitamin", target: 16, soybean: 16, paneerSoy: 16 },
  { key: "vit_b5", label: "B5 Pantothenic", unit: "mg", group: "vitamin", target: 5, soybean: 8.17, paneerSoy: 7.53 },
  { key: "vit_b6", label: "B6", unit: "mg", group: "vitamin", target: 1.3, soybean: 2.55, paneerSoy: 2.37 },
  { key: "vit_b7", label: "B7 Biotin", unit: "mcg", group: "vitamin", target: 30, soybean: 55, paneerSoy: 50 },
  { key: "vit_b9", label: "B9 Folate", unit: "mcg", group: "vitamin", target: 400, soybean: 556, paneerSoy: 506 },
  { key: "vit_b12", label: "B12", unit: "mcg", group: "vitamin", target: 2.4, soybean: 6.1, paneerSoy: 5.8 },
  { key: "vit_c", label: "Vitamin C", unit: "mg", group: "vitamin", target: 90, soybean: 451, paneerSoy: 450 },
  { key: "vit_d", label: "Vitamin D", unit: "mcg", group: "vitamin", target: 15, soybean: 54, paneerSoy: 53 },
  { key: "vit_e", label: "Vitamin E", unit: "mg", group: "vitamin", target: 15, soybean: 15.7, paneerSoy: 15.2 },
  { key: "vit_k", label: "Vitamin K", unit: "mcg", group: "vitamin", target: 120, soybean: 299, paneerSoy: 290 },
];

export const NUTRIENT_GROUPS = ["macro", "mineral", "vitamin"];

// Scale behaviour per nutrient:
//   target = hit it (both under and over are off)   -> calories/protein/carbs/fat
//   limit  = stay at/under it                         -> sodium, saturated fat
//   floor  = meet or exceed it (more is fine)         -> fiber, vitamins, minerals
const TARGET_KEYS = new Set(["calories", "protein", "carbs", "fat"]);
function kindOf(n) {
  if (n.limit) return "limit";
  if (TARGET_KEYS.has(n.key)) return "target";
  return "floor";
}

// What today's diet type is planned to deliver for each nutrient (full panel).
export function planNutrients(dietType) {
  const col = dietType === "paneer-soy" ? "paneerSoy" : "soybean";
  return NUTRIENTS.map((n) => ({
    key: n.key, label: n.label, unit: n.unit, group: n.group,
    target: n.target, plan: n[col], limit: Boolean(n.limit), kind: kindOf(n),
  }));
}

// Given the fraction of the day's calories already eaten (0..1), how much of each
// nutrient is logged so far - a proportional estimate so the panel fills in as
// meals are checked, hitting the full plan value when the day is complete.
export function nutrientsSoFar(dietType, fractionOfDay) {
  const f = Math.max(0, Math.min(1, Number(fractionOfDay) || 0));
  return planNutrients(dietType).map((n) => ({ ...n, current: Math.round(n.plan * f * 100) / 100 }));
}

// Range-gauge model: the TARGET sits at the centre (50%), the track runs 0..2×target,
// and the pointer shows the actual value. `over` flags a value past the high end so
// exceeding is visible (not silently clamped). `status` colours the pointer:
//   limit: good under target, bad over it.   floor: good at/above target.
//   target: good within ±15% of target.
export function gauge({ current, target, kind = "floor", limit = false } = {}) {
  const t = Number(target) || 1;
  const ratio = (Number(current) || 0) / t;
  const position = Math.max(0, Math.min(100, ratio * 50)); // target -> 50% (centre)
  const over = (Number(current) || 0) > t * 2;
  const k = limit ? "limit" : kind;
  let status;
  if (k === "limit") status = ratio <= 1 ? "good" : (ratio <= 1.1 ? "near" : "bad");
  else if (k === "target") status = (ratio >= 0.85 && ratio <= 1.15) ? "good" : ((ratio >= 0.6 && ratio <= 1.4) ? "near" : "bad");
  else status = ratio >= 1 ? "good" : (ratio >= 0.6 ? "near" : "bad");
  return { position: Math.round(position * 10) / 10, status, over };
}
