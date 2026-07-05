// Suggests concrete foods to close the day's protein gap.
// Uses a small lookup of high-protein, India-friendly items (veg + non-veg).
// Pure: takes a day's food_logs and a protein target, returns string tips.

// Protein per 100g (or per unit where noted). Conservative averages.
export const PROTEIN_SOURCES = [
  { name: "whey scoop (30g)", proteinPerServing: 24, serving: "1 scoop", veg: true },
  { name: "boiled egg", proteinPerServing: 6, serving: "1 egg", veg: false },
  { name: "paneer", proteinPer100g: 18, defaultServingG: 50, veg: true },
  { name: "tofu", proteinPer100g: 12, defaultServingG: 100, veg: true },
  { name: "chicken breast", proteinPer100g: 31, defaultServingG: 100, veg: false },
  { name: "fish (rohu/pomfret)", proteinPer100g: 22, defaultServingG: 100, veg: false },
  { name: "soya chunks (dry)", proteinPer100g: 52, defaultServingG: 25, veg: true },
  { name: "dal (cooked, toor/moong)", proteinPer100g: 7, defaultServingG: 200, veg: true },
  { name: "rajma (cooked)", proteinPer100g: 8.7, defaultServingG: 150, veg: true },
  { name: "chana (cooked)", proteinPer100g: 8.9, defaultServingG: 150, veg: true },
  { name: "curd (full fat)", proteinPer100g: 3.5, defaultServingG: 200, veg: true },
  { name: "greek yogurt", proteinPer100g: 10, defaultServingG: 150, veg: true },
  { name: "milk (toned)", proteinPer100g: 3.2, defaultServingG: 250, veg: true },
  { name: "peanuts", proteinPer100g: 26, defaultServingG: 30, veg: true },
  { name: "almonds", proteinPer100g: 21, defaultServingG: 25, veg: true },
  { name: "sprouted moong", proteinPer100g: 7, defaultServingG: 100, veg: true },
];

if (PROTEIN_SOURCES.length < 12) {
  throw new Error("protein-gap lookup must have at least 12 items");
}

function gramsForProtein(source, gramsOfProtein) {
  if (source.proteinPerServing) {
    const servings = Math.max(1, Math.round(gramsOfProtein / source.proteinPerServing));
    return { servings, label: `${servings} × ${source.serving}` };
  }
  const grams = Math.max(20, Math.round((gramsOfProtein / source.proteinPer100g) * 100));
  return { grams, label: `${grams}g` };
}

function formatSuggestion(source, gramsOfProtein) {
  const portion = gramsForProtein(source, gramsOfProtein);
  if (source.proteinPerServing) {
    const totalProtein = Math.round(portion.servings * source.proteinPerServing);
    return `Add ${portion.label} of ${source.name} (~${totalProtein}g protein)`;
  }
  const totalProtein = Math.round((portion.grams * source.proteinPer100g) / 100);
  return `Eat ${portion.label} of ${source.name} (~${totalProtein}g protein)`;
}

export function suggestProteinFixes(foodLogs, targetProteinG, options = {}) {
  const consumed = (foodLogs || []).reduce(
    (sum, row) => sum + (Number(row.protein_g) || 0),
    0,
  );
  const target = Number(targetProteinG) || 0;
  const gap = target - consumed;
  if (gap <= 0) {
    return ["Protein target met — keep hydration up."];
  }

  const wantVeg = options.vegOnly === true;
  const limit = Math.max(3, Math.min(8, Number(options.limit) || 5));

  const pool = PROTEIN_SOURCES.filter((s) => (wantVeg ? s.veg : true));

  // Sort to suggest the most "efficient" sources first when the gap is large.
  const sorted = [...pool].sort((a, b) => {
    const aDensity = a.proteinPerServing || a.proteinPer100g;
    const bDensity = b.proteinPerServing || b.proteinPer100g;
    return bDensity - aDensity;
  });

  const tips = [];
  for (const source of sorted) {
    tips.push(formatSuggestion(source, gap));
    if (tips.length >= limit) break;
  }
  return tips;
}

export default suggestProteinFixes;
