// Canonical Indian home-food portion table.
// Each entry encodes the "regular" household portion the user is likely to
// log (e.g. "1 katori dal", "1 phulka roti") and the macros for that portion.
// Macros are rough averages — meant for instant defaults when the user types
// a vague meal name, not for clinical accuracy.

export const HOME_FOOD_PORTIONS = [
  { name: "dal", portion: "1 katori (150ml)", calories: 150, protein_g: 9, carbs_g: 20, fat_g: 3 },
  { name: "roti", portion: "1 phulka", calories: 110, protein_g: 3.5, carbs_g: 22, fat_g: 1 },
  { name: "rice", portion: "1 katori cooked", calories: 210, protein_g: 4, carbs_g: 45, fat_g: 0.5 },
  { name: "sabzi", portion: "1 katori mixed veg", calories: 130, protein_g: 4, carbs_g: 12, fat_g: 7 },
  { name: "curd", portion: "1 katori (150g)", calories: 90, protein_g: 5, carbs_g: 6, fat_g: 5 },
  { name: "paneer 30g", portion: "30g cubes", calories: 80, protein_g: 5.4, carbs_g: 1.2, fat_g: 6 },
  { name: "paneer 50g", portion: "50g cubes", calories: 130, protein_g: 9, carbs_g: 2, fat_g: 10 },
  { name: "paneer 100g", portion: "100g", calories: 265, protein_g: 18, carbs_g: 4, fat_g: 20 },
  { name: "boiled egg", portion: "1 egg", calories: 70, protein_g: 6, carbs_g: 0.5, fat_g: 5 },
  { name: "omelette (2 egg)", portion: "2 eggs + oil", calories: 200, protein_g: 12, carbs_g: 1, fat_g: 16 },
  { name: "paratha", portion: "1 plain", calories: 240, protein_g: 5, carbs_g: 30, fat_g: 10 },
  { name: "aloo paratha", portion: "1 stuffed", calories: 320, protein_g: 6, carbs_g: 38, fat_g: 14 },
  { name: "idli", portion: "1 piece", calories: 50, protein_g: 1.5, carbs_g: 10, fat_g: 0.3 },
  { name: "dosa", portion: "1 plain", calories: 170, protein_g: 4, carbs_g: 28, fat_g: 4 },
  { name: "masala dosa", portion: "1 piece", calories: 260, protein_g: 5, carbs_g: 36, fat_g: 10 },
  { name: "khichdi", portion: "1 bowl (250g)", calories: 290, protein_g: 11, carbs_g: 45, fat_g: 6 },
  { name: "chai", portion: "1 cup (150ml)", calories: 70, protein_g: 2, carbs_g: 8, fat_g: 3 },
  { name: "filter coffee", portion: "1 cup (150ml)", calories: 90, protein_g: 3, carbs_g: 9, fat_g: 4 },
  { name: "poha", portion: "1 plate", calories: 250, protein_g: 5, carbs_g: 40, fat_g: 7 },
  { name: "upma", portion: "1 katori", calories: 230, protein_g: 5, carbs_g: 35, fat_g: 8 },
  { name: "sambar", portion: "1 katori", calories: 140, protein_g: 6, carbs_g: 18, fat_g: 4 },
  { name: "rajma", portion: "1 katori", calories: 200, protein_g: 12, carbs_g: 30, fat_g: 4 },
  { name: "chole", portion: "1 katori", calories: 220, protein_g: 11, carbs_g: 28, fat_g: 7 },
  { name: "biryani veg", portion: "1 plate", calories: 480, protein_g: 12, carbs_g: 70, fat_g: 16 },
  { name: "biryani chicken", portion: "1 plate", calories: 600, protein_g: 28, carbs_g: 70, fat_g: 22 },
  { name: "chicken curry", portion: "1 katori", calories: 280, protein_g: 22, carbs_g: 6, fat_g: 18 },
  { name: "fish curry", portion: "1 katori", calories: 230, protein_g: 20, carbs_g: 5, fat_g: 14 },
  { name: "lassi", portion: "1 glass (250ml)", calories: 220, protein_g: 7, carbs_g: 28, fat_g: 8 },
  { name: "buttermilk", portion: "1 glass (250ml)", calories: 60, protein_g: 3, carbs_g: 6, fat_g: 2 },
  { name: "fruit chaat", portion: "1 katori", calories: 110, protein_g: 1.5, carbs_g: 26, fat_g: 0.5 },
  { name: "banana", portion: "1 medium", calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.3 },
  { name: "milk toned", portion: "1 glass (250ml)", calories: 140, protein_g: 8, carbs_g: 12, fat_g: 5 },
];

if (HOME_FOOD_PORTIONS.length < 25) {
  throw new Error("home-food-portions must list at least 25 items");
}

export function findHomeFood(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return null;
  let best = null;
  let bestScore = 0;
  for (const entry of HOME_FOOD_PORTIONS) {
    const name = entry.name.toLowerCase();
    let score = 0;
    if (name === needle) score = 1;
    else if (name.startsWith(needle)) score = 0.85;
    else if (needle.startsWith(name)) score = 0.75;
    else if (name.includes(needle) || needle.includes(name)) score = 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

export default HOME_FOOD_PORTIONS;
