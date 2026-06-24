// Deterministic everyday-food nutrition.
//
// The problem this solves: macros for logged food used to be 100% the model's
// guess ("coffee + 5 cookies -> 10g protein" — nonsense). Here is a real lookup
// table of everyday foods with per-unit macros, plus a quantity-aware parser, so
// common foods get ACCURATE numbers without asking the model to invent them.
//
// Contract used by the edge function:
//   - if estimateNutrition(text).recognized === true, the table totals are
//     AUTHORITATIVE and override the model.
//   - if it's NOT fully recognized (an unusual / non-everyday food is present),
//     the caller falls back to DeepSeek reasoning — "deepseek thinking only for
//     items that are not everyday", exactly as asked.
//
// Pure (no DOM / no Supabase) so it is importable by the browser, by tests, and
// mirrored verbatim inside supabase/functions/agent/index.ts.

// Each entry's macros are for ONE `unit` (named for clarity). `per` is the base
// quantity a count multiplies (1 for countables; for gram/ml foods it's the
// reference grams/ml, and a "100g paneer" phrase scales by grams/per).
// kinds: "count" (eggs, rotis, cookies), "gram" (paneer, chicken), "ml" (milk).
export const FOOD_TABLE = [
  // --- Indian staples ---
  { key: "egg", kind: "count", unit: "1 egg", aliases: ["egg", "eggs", "boiled egg", "boiled eggs", "whole egg", "whole eggs", "anda", "ande"], calories: 72, protein_g: 6.3, carbs_g: 0.4, fat_g: 5 },
  { key: "egg white", kind: "count", unit: "1 white", aliases: ["egg white", "egg whites", "whites"], calories: 17, protein_g: 3.6, carbs_g: 0.2, fat_g: 0.1 },
  { key: "roti", kind: "count", unit: "1 roti", aliases: ["roti", "rotis", "phulka", "phulkas", "chapati", "chapatis", "chapathi", "fulka"], calories: 110, protein_g: 3.5, carbs_g: 22, fat_g: 1 },
  { key: "paratha", kind: "count", unit: "1 paratha", aliases: ["paratha", "parathas", "parantha"], calories: 240, protein_g: 5, carbs_g: 30, fat_g: 10 },
  { key: "aloo paratha", kind: "count", unit: "1 stuffed", aliases: ["aloo paratha", "aloo parathas", "potato paratha"], calories: 320, protein_g: 6, carbs_g: 38, fat_g: 14 },
  { key: "rice", kind: "count", unit: "1 katori", aliases: ["rice", "rice bowl", "steamed rice", "jeera rice", "white rice", "boiled rice", "chawal", "bhaat"], calories: 210, protein_g: 4, carbs_g: 45, fat_g: 0.5 },
  { key: "dal", kind: "count", unit: "1 katori", aliases: ["dal", "daal", "dal bowl", "lentils", "tadka dal", "dal fry"], calories: 150, protein_g: 9, carbs_g: 20, fat_g: 3 },
  { key: "sabzi", kind: "count", unit: "1 katori", aliases: ["sabzi", "sabji", "mixed veg", "veg curry", "bhindi", "aloo gobi"], calories: 130, protein_g: 4, carbs_g: 12, fat_g: 7 },
  { key: "rajma", kind: "count", unit: "1 katori", aliases: ["rajma", "kidney beans"], calories: 200, protein_g: 12, carbs_g: 30, fat_g: 4 },
  { key: "chole", kind: "count", unit: "1 katori", aliases: ["chole", "chana", "chickpea curry", "chana masala", "chhole"], calories: 220, protein_g: 11, carbs_g: 28, fat_g: 7 },
  { key: "sambar", kind: "count", unit: "1 katori", aliases: ["sambar", "sambhar"], calories: 140, protein_g: 6, carbs_g: 18, fat_g: 4 },
  { key: "curd", kind: "count", unit: "1 katori", aliases: ["curd", "dahi", "yogurt", "yoghurt"], calories: 90, protein_g: 5, carbs_g: 6, fat_g: 5 },
  { key: "greek yogurt", kind: "gram", per: 100, unit: "100 g", aliases: ["greek yogurt", "greek yoghurt", "hung curd"], calories: 60, protein_g: 10, carbs_g: 4, fat_g: 0.4 },
  { key: "paneer", kind: "gram", per: 100, unit: "100 g", aliases: ["paneer", "cottage cheese"], calories: 265, protein_g: 18, carbs_g: 4, fat_g: 20 },
  { key: "soybean", kind: "gram", per: 100, unit: "100 g cooked", aliases: ["soybean", "soybeans", "soya", "soya beans", "soya chunks", "soyabean", "soyabeans"], calories: 172, protein_g: 18, carbs_g: 10, fat_g: 9 },
  { key: "tofu", kind: "gram", per: 100, unit: "100 g", aliases: ["tofu"], calories: 145, protein_g: 15, carbs_g: 4, fat_g: 9 },
  { key: "idli", kind: "count", unit: "1 piece", aliases: ["idli", "idlis", "idly"], calories: 50, protein_g: 1.5, carbs_g: 10, fat_g: 0.3 },
  { key: "dosa", kind: "count", unit: "1 plain", aliases: ["dosa", "dosas", "plain dosa"], calories: 170, protein_g: 4, carbs_g: 28, fat_g: 4 },
  { key: "masala dosa", kind: "count", unit: "1 piece", aliases: ["masala dosa", "masala dosas"], calories: 260, protein_g: 5, carbs_g: 36, fat_g: 10 },
  { key: "poha", kind: "count", unit: "1 plate", aliases: ["poha"], calories: 250, protein_g: 5, carbs_g: 40, fat_g: 7 },
  { key: "upma", kind: "count", unit: "1 katori", aliases: ["upma"], calories: 230, protein_g: 5, carbs_g: 35, fat_g: 8 },
  { key: "khichdi", kind: "count", unit: "1 bowl", aliases: ["khichdi"], calories: 290, protein_g: 11, carbs_g: 45, fat_g: 6 },
  { key: "biryani veg", kind: "count", unit: "1 plate", aliases: ["veg biryani", "vegetable biryani"], calories: 480, protein_g: 12, carbs_g: 70, fat_g: 16 },
  { key: "biryani chicken", kind: "count", unit: "1 plate", aliases: ["chicken biryani", "biryani"], calories: 600, protein_g: 28, carbs_g: 70, fat_g: 22 },
  { key: "chicken curry", kind: "count", unit: "1 katori", aliases: ["chicken curry", "chicken gravy", "butter chicken"], calories: 280, protein_g: 22, carbs_g: 6, fat_g: 18 },
  { key: "chicken breast", kind: "gram", per: 100, unit: "100 g", aliases: ["chicken breast", "grilled chicken", "chicken 100g", "chicken"], calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  { key: "fish curry", kind: "count", unit: "1 katori", aliases: ["fish curry", "fish"], calories: 230, protein_g: 20, carbs_g: 5, fat_g: 14 },
  { key: "mutton curry", kind: "count", unit: "1 katori", aliases: ["mutton curry", "mutton", "lamb curry"], calories: 300, protein_g: 22, carbs_g: 5, fat_g: 22 },
  { key: "egg curry", kind: "count", unit: "1 katori (2 egg)", aliases: ["egg curry", "anda curry", "egg masala"], calories: 230, protein_g: 14, carbs_g: 6, fat_g: 16 },
  { key: "samosa", kind: "count", unit: "1 piece", aliases: ["samosa", "samosas"], calories: 130, protein_g: 3, carbs_g: 16, fat_g: 7 },
  { key: "pakora", kind: "count", unit: "1 piece", aliases: ["pakora", "pakoda", "bhaji"], calories: 60, protein_g: 1.5, carbs_g: 5, fat_g: 4 },
  { key: "vada pav", kind: "count", unit: "1 piece", aliases: ["vada pav", "vada pao"], calories: 290, protein_g: 7, carbs_g: 42, fat_g: 11 },
  { key: "pav bhaji", kind: "count", unit: "1 plate", aliases: ["pav bhaji", "pao bhaji"], calories: 400, protein_g: 9, carbs_g: 48, fat_g: 18 },
  { key: "salad", kind: "count", unit: "1 bowl", aliases: ["salad", "salad bowl", "veg salad", "green salad"], calories: 150, protein_g: 5, carbs_g: 15, fat_g: 7 },
  { key: "fruit chaat", kind: "count", unit: "1 katori", aliases: ["fruit chaat", "fruit salad"], calories: 110, protein_g: 1.5, carbs_g: 26, fat_g: 0.5 },

  // --- drinks ---
  { key: "chai", kind: "count", unit: "1 cup", aliases: ["chai", "tea", "masala chai", "milk tea", "doodh chai"], calories: 70, protein_g: 2, carbs_g: 8, fat_g: 3 },
  { key: "black tea", kind: "count", unit: "1 cup", aliases: ["black tea", "green tea", "lemon tea"], calories: 5, protein_g: 0, carbs_g: 1, fat_g: 0 },
  { key: "coffee", kind: "count", unit: "1 cup", aliases: ["coffee", "milk coffee", "cappuccino", "latte", "cafe latte"], calories: 60, protein_g: 2, carbs_g: 7, fat_g: 3 },
  { key: "black coffee", kind: "count", unit: "1 cup", aliases: ["black coffee", "americano", "espresso"], calories: 5, protein_g: 0.3, carbs_g: 1, fat_g: 0 },
  { key: "filter coffee", kind: "count", unit: "1 cup", aliases: ["filter coffee", "south indian coffee"], calories: 90, protein_g: 3, carbs_g: 9, fat_g: 4 },
  { key: "milk", kind: "ml", per: 250, unit: "1 glass (250 ml)", aliases: ["milk", "toned milk", "doodh"], calories: 140, protein_g: 8, carbs_g: 12, fat_g: 5 },
  { key: "lassi", kind: "count", unit: "1 glass", aliases: ["lassi", "sweet lassi"], calories: 220, protein_g: 7, carbs_g: 28, fat_g: 8 },
  { key: "buttermilk", kind: "count", unit: "1 glass", aliases: ["buttermilk", "chaas", "chhaas"], calories: 60, protein_g: 3, carbs_g: 6, fat_g: 2 },
  { key: "juice", kind: "count", unit: "1 glass", aliases: ["juice", "orange juice", "fruit juice", "mango juice"], calories: 130, protein_g: 1, carbs_g: 32, fat_g: 0.3 },
  { key: "soft drink", kind: "count", unit: "1 can", aliases: ["coke", "pepsi", "soft drink", "cola", "soda", "sprite", "thums up"], calories: 140, protein_g: 0, carbs_g: 39, fat_g: 0 },
  { key: "protein shake", kind: "count", unit: "1 glass", aliases: ["protein shake", "protein milk shake", "mass gainer shake"], calories: 250, protein_g: 35, carbs_g: 12, fat_g: 5 },
  { key: "whey scoop", kind: "count", unit: "1 scoop", aliases: ["whey", "whey scoop", "protein scoop", "scoop whey", "scoop of whey"], calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 },

  // --- fruits ---
  { key: "banana", kind: "count", unit: "1 medium", aliases: ["banana", "bananas", "kela"], calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.3 },
  { key: "apple", kind: "count", unit: "1 medium", aliases: ["apple", "apples", "seb"], calories: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 },
  { key: "guava", kind: "gram", per: 100, unit: "100 g", aliases: ["guava", "amrood"], calories: 68, protein_g: 2.6, carbs_g: 14, fat_g: 1 },
  { key: "orange", kind: "count", unit: "1 medium", aliases: ["orange", "oranges", "santra"], calories: 62, protein_g: 1.2, carbs_g: 15, fat_g: 0.2 },
  { key: "mango", kind: "count", unit: "1 medium", aliases: ["mango", "mangoes", "aam"], calories: 150, protein_g: 2, carbs_g: 38, fat_g: 0.6 },

  // --- snacks / packaged ---
  { key: "cookie", kind: "count", unit: "1 cookie", aliases: ["cookie", "cookies", "biscuit", "biscuits", "choc chip cookie", "choco chip cookie", "chocolate chip cookie", "choco chip cookies", "choc chip cookies", "chocolate chip cookies", "cream biscuit"], calories: 55, protein_g: 0.7, carbs_g: 7, fat_g: 2.7 },
  { key: "rusk", kind: "count", unit: "1 piece", aliases: ["rusk", "toast biscuit"], calories: 40, protein_g: 0.8, carbs_g: 7, fat_g: 1 },
  { key: "bread slice", kind: "count", unit: "1 slice", aliases: ["bread slice", "bread", "toast", "slice of bread", "bread slices"], calories: 70, protein_g: 2.5, carbs_g: 13, fat_g: 1 },
  { key: "butter", kind: "count", unit: "1 tsp", aliases: ["butter", "makhan"], calories: 35, protein_g: 0, carbs_g: 0, fat_g: 4 },
  { key: "jam", kind: "count", unit: "1 tbsp", aliases: ["jam", "marmalade"], calories: 50, protein_g: 0, carbs_g: 13, fat_g: 0 },
  { key: "cheese slice", kind: "count", unit: "1 slice", aliases: ["cheese slice", "cheese", "cheese slices"], calories: 60, protein_g: 4, carbs_g: 1, fat_g: 5 },
  { key: "peanut butter", kind: "count", unit: "1 tbsp", aliases: ["peanut butter", "pb"], calories: 95, protein_g: 4, carbs_g: 3, fat_g: 8 },
  { key: "chocolate", kind: "count", unit: "1 small bar (30 g)", aliases: ["chocolate", "dairy milk", "choco bar", "chocolate bar"], calories: 160, protein_g: 2, carbs_g: 18, fat_g: 9 },
  { key: "chips", kind: "count", unit: "1 small packet", aliases: ["chips", "lays", "potato chips", "wafers"], calories: 270, protein_g: 3, carbs_g: 27, fat_g: 17 },
  { key: "namkeen", kind: "count", unit: "1 serving (30 g)", aliases: ["namkeen", "mixture", "sev", "bhujia"], calories: 150, protein_g: 3, carbs_g: 15, fat_g: 9 },
  { key: "oats", kind: "gram", per: 40, unit: "40 g serving", aliases: ["oats", "oatmeal", "porridge"], calories: 150, protein_g: 5, carbs_g: 27, fat_g: 3 },
  { key: "peanuts", kind: "gram", per: 30, unit: "30 g handful", aliases: ["peanuts", "groundnut", "moongphali", "roasted peanuts"], calories: 170, protein_g: 7, carbs_g: 5, fat_g: 14 },
  { key: "almonds", kind: "count", unit: "1 almond", aliases: ["almond", "almonds", "badam"], calories: 7, protein_g: 0.26, carbs_g: 0.25, fat_g: 0.6 },
  { key: "seeds", kind: "count", unit: "1 tbsp", aliases: ["seeds", "seed mix", "pumpkin seeds", "chia", "chia seeds", "flax seeds", "sunflower seeds"], calories: 50, protein_g: 2, carbs_g: 3, fat_g: 4 },
  { key: "noodles", kind: "count", unit: "1 pack", aliases: ["maggi", "noodles", "ramen", "instant noodles"], calories: 350, protein_g: 8, carbs_g: 50, fat_g: 13 },
  { key: "pasta", kind: "count", unit: "1 plate", aliases: ["pasta", "macaroni", "white sauce pasta"], calories: 350, protein_g: 10, carbs_g: 55, fat_g: 9 },
  { key: "sandwich", kind: "count", unit: "1 sandwich", aliases: ["sandwich", "veg sandwich", "grilled sandwich"], calories: 250, protein_g: 8, carbs_g: 35, fat_g: 9 },
  { key: "burger", kind: "count", unit: "1 burger", aliases: ["burger", "veg burger", "aloo tikki burger"], calories: 350, protein_g: 10, carbs_g: 45, fat_g: 14 },
  { key: "chicken burger", kind: "count", unit: "1 burger", aliases: ["chicken burger", "mcchicken", "chicken patty burger"], calories: 450, protein_g: 22, carbs_g: 40, fat_g: 22 },
  { key: "pizza slice", kind: "count", unit: "1 slice", aliases: ["pizza slice", "pizza", "pizza slices"], calories: 285, protein_g: 12, carbs_g: 36, fat_g: 10 },
  { key: "momo", kind: "count", unit: "1 piece", aliases: ["momo", "momos", "dumpling", "dumplings"], calories: 35, protein_g: 1.5, carbs_g: 5, fat_g: 1 },
];

if (FOOD_TABLE.length < 50) {
  throw new Error("food-nutrition table must list at least 50 everyday foods");
}

// Build an alias index sorted so the LONGEST / most-specific alias wins
// ("egg white" before "egg", "chicken breast" before "chicken").
const ALIAS_INDEX = (() => {
  const rows = [];
  for (const entry of FOOD_TABLE) {
    for (const alias of entry.aliases) rows.push({ alias, words: alias.trim().split(/\s+/).length, len: alias.length, entry });
  }
  rows.sort((a, b) => b.words - a.words || b.len - a.len);
  return rows;
})();

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, half: 0.5, couple: 2, few: 3, dozen: 12,
};

// Words that are NOT food and must never be treated as an unknown food token:
// fillers, cooking methods, descriptors, money words, time words.
const STOPWORDS = new Set([
  "i", "ate", "eaten", "eat", "had", "have", "having", "having", "just", "today", "yesterday", "now", "and", "with",
  "plus", "the", "a", "an", "some", "of", "for", "my", "me", "this", "that", "these", "those", "free", "sent", "got",
  "paid", "pay", "spent", "rs", "rupees", "inr", "only", "also", "in", "on", "at", "to", "from", "was", "were", "is",
  "morning", "afternoon", "evening", "night", "breakfast", "lunch", "dinner", "snack", "meal", "brunch", "supper",
  "curry", "gravy", "fry", "fried", "boiled", "roasted", "grilled", "steamed", "raw", "fresh", "homemade", "home",
  "made", "plain", "masala", "spicy", "hot", "cold", "small", "big", "large", "medium", "regular", "extra", "more",
  "less", "little", "bit", "piece", "pieces", "plate", "bowl", "cup", "glass", "katori", "scoop", "slice", "slices",
  "serving", "servings", "approx", "about", "around", "roughly", "g", "gram", "grams", "gm", "ml", "kg", "tbsp", "tsp",
  "veg", "non", "veggie", "ka", "ki", "ke", "aur", "thoda", "kuch", "wala", "style", "type", "kind", "mix", "mixed",
]);

// Split a meal description into food phrases on natural separators. We keep
// decimals intact (do NOT split on ".") so "1.5 cups" survives.
function splitPhrases(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\b(and|with|plus|along\s+with|aur|n)\b/g, "|")
    .replace(/[,;+&/\n]+/g, "|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function numberAt(token) {
  if (token == null) return null;
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  return null;
}

// Within one phrase, find every food the table knows (longest alias first,
// consuming matched spans), assign each a quantity, and report leftover
// non-stopword tokens as "unknown" foods.
function parsePhrase(phrase) {
  let masked = ` ${phrase} `;
  const found = [];
  for (const row of ALIAS_INDEX) {
    const rx = new RegExp(`(?<![a-z])${row.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "g");
    let m;
    while ((m = rx.exec(masked)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip if this span was already consumed by a longer alias (masked to \0).
      if (masked.slice(start, end).includes("\0")) continue;
      found.push({ entry: row.entry, start, end });
      masked = masked.slice(0, start) + "\0".repeat(end - start) + masked.slice(end);
    }
  }
  found.sort((a, b) => a.start - b.start);

  // Tokenize the ORIGINAL phrase to locate numbers / gram / ml quantities.
  const tokens = [...` ${phrase} `.matchAll(/(\d+(?:\.\d+)?)\s*(g|gram|grams|gm|ml|kg)?|[a-z]+/g)]
    .map((t) => ({ raw: t[0].trim(), num: numberAt(t[1] ?? t[0].trim()), unit: t[2] || null, index: t.index }));

  const numbers = tokens.filter((t) => t.num != null).sort((a, b) => a.index - b.index);

  // Assign quantities. Each number binds to the NEAREST food that starts after it
  // and isn't already taken — so "3 rotis dal sabzi" gives rotis=3, dal=1, sabzi=1
  // (the 3 is consumed by rotis, not reused). A trailing-number phrase ("cookies
  // x5") is caught by the single-food fallback. Foods with no number default to 1.
  const sortedFoods = [...found].sort((a, b) => a.start - b.start);
  const qtyFor = new Map();
  const toQty = (n) => {
    const o = { qty: n.num, explicit: true, grams: null, ml: null };
    if (n.unit && /^(g|gram|grams|gm)$/.test(n.unit)) o.grams = n.num;
    else if (n.unit === "kg") o.grams = n.num * 1000;
    else if (n.unit === "ml") o.ml = n.num;
    return o;
  };
  for (const n of numbers) {
    const target = sortedFoods.find((f) => f.start > n.index && !qtyFor.has(f));
    if (target) qtyFor.set(target, toQty(n));
  }
  if (sortedFoods.length === 1 && !qtyFor.has(sortedFoods[0]) && numbers.length) {
    qtyFor.set(sortedFoods[0], toQty(numbers[numbers.length - 1]));
  }
  const items = sortedFoods.map((f) => {
    const q = qtyFor.get(f) || { qty: 1, explicit: false, grams: null, ml: null };
    return { entry: f.entry, ...q };
  });

  // Leftover alphabetic tokens that aren't stopwords and weren't matched = the
  // "unknown" foods that should go to the model.
  const unknown = [];
  const leftover = masked.replace(/\0+/g, " ");
  for (const w of leftover.split(/\s+/)) {
    const t = w.trim();
    if (t.length < 3) continue;
    if (/^\d/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    unknown.push(t);
  }
  return { items, unknown };
}

function multiplier(item) {
  const e = item.entry;
  if (e.kind === "gram") return (item.grams != null ? item.grams : (item.qty || 1) * (e.per || 100)) / (e.per || 100);
  if (e.kind === "ml") return (item.ml != null ? item.ml : (item.qty || 1) * (e.per || 250)) / (e.per || 250);
  return item.qty || 1;
}

function round1(n) { return Math.round(n * 10) / 10; }

// Estimate macros for a free-text food description.
// Returns:
//   items:      [{ key, label, qty, calories, protein_g, carbs_g, fat_g }]
//   unknown:    [tokens]   foods the table doesn't know -> caller asks the model
//   totals:     { calories, protein_g, carbs_g, fat_g }
//   recognized: true when at least one food matched AND no unknown food remains
//   coverage:   matched / (matched + unknown)
export function estimateNutrition(text) {
  const phrases = splitPhrases(text);
  const matchedByKey = new Map(); // key -> { entry, qty, explicit }
  const unknown = new Set();

  for (const phrase of phrases) {
    const { items, unknown: unk } = parsePhrase(phrase);
    for (const it of items) {
      const key = it.entry.key;
      const mult = multiplier(it);
      const prev = matchedByKey.get(key);
      if (!prev) { matchedByKey.set(key, { entry: it.entry, mult, explicit: it.explicit }); continue; }
      // Same food seen twice: an explicit-quantity mention wins over a bare one
      // ("egg curry ... 2 eggs" -> egg counts as 2, not 1+2). Two explicit
      // mentions add up.
      if (it.explicit && prev.explicit) prev.mult += mult;
      else if (it.explicit && !prev.explicit) { prev.mult = mult; prev.explicit = true; }
      // bare-after-explicit or bare-after-bare: keep what we have.
    }
    for (const u of unk) unknown.add(u);
  }

  // Composite-dish de-dup: if the user names a dish AND itemizes its components
  // with an explicit count ("egg curry ... 2 eggs"), the explicit items are the
  // real content — drop the composite so we don't count the eggs twice.
  const COMPOSITE_COMPONENTS = { "egg curry": ["egg", "egg white"] };
  for (const [dish, parts] of Object.entries(COMPOSITE_COMPONENTS)) {
    if (matchedByKey.has(dish) && parts.some((p) => matchedByKey.get(p)?.explicit)) {
      matchedByKey.delete(dish);
    }
  }

  const items = [];
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const { entry, mult } of matchedByKey.values()) {
    const row = {
      key: entry.key,
      label: entry.key,
      qty: round1(mult),
      calories: round1(entry.calories * mult),
      protein_g: round1(entry.protein_g * mult),
      carbs_g: round1(entry.carbs_g * mult),
      fat_g: round1(entry.fat_g * mult),
    };
    items.push(row);
    totals.calories += row.calories;
    totals.protein_g += row.protein_g;
    totals.carbs_g += row.carbs_g;
    totals.fat_g += row.fat_g;
  }
  totals.calories = Math.round(totals.calories);
  totals.protein_g = round1(totals.protein_g);
  totals.carbs_g = round1(totals.carbs_g);
  totals.fat_g = round1(totals.fat_g);

  const matchedCount = items.length;
  const unknownCount = unknown.size;
  return {
    items,
    unknown: [...unknown],
    totals,
    recognized: matchedCount > 0 && unknownCount === 0,
    coverage: matchedCount + unknownCount === 0 ? 0 : round1(matchedCount / (matchedCount + unknownCount)),
  };
}

export default { FOOD_TABLE, estimateNutrition };
