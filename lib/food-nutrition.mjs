// Deterministic everyday-food nutrition.
//
// The problem this solves: macros for logged food used to be 100% the model's
// guess ("coffee + 5 cookies -> 10g protein" - nonsense). Here is a real lookup
// table of everyday foods with per-unit macros, plus a quantity-aware parser, so
// common foods get ACCURATE numbers without asking the model to invent them.
//
// Contract used by the edge function:
//   - if estimateNutrition(text).recognized === true, the table totals are
//     AUTHORITATIVE and override the model.
//   - if it's NOT fully recognized (an unusual / non-everyday food is present),
//     the caller falls back to DeepSeek reasoning - "deepseek thinking only for
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
  { key: "egg", category: "protein", kind: "count", unit: "1 egg", aliases: ["egg", "eggs", "boiled egg", "boiled eggs", "whole egg", "whole eggs", "anda", "ande"], calories: 72, protein_g: 6.3, carbs_g: 0.4, fat_g: 5 },
  { key: "egg white", category: "protein", kind: "count", unit: "1 white", aliases: ["egg white", "egg whites", "whites"], calories: 17, protein_g: 3.6, carbs_g: 0.2, fat_g: 0.1 },
  { key: "roti", category: "staple", kind: "count", unit: "1 roti", gramsPerUnit: 45, aliases: ["roti", "rotis", "phulka", "phulkas", "chapati", "chapatis", "chapathi", "fulka"], calories: 110, protein_g: 3.5, carbs_g: 22, fat_g: 1 },
  { key: "paratha", category: "staple", kind: "count", unit: "1 paratha", aliases: ["paratha", "parathas", "parantha"], calories: 240, protein_g: 5, carbs_g: 30, fat_g: 10 },
  { key: "aloo paratha", category: "staple", kind: "count", unit: "1 stuffed", aliases: ["aloo paratha", "aloo parathas", "potato paratha"], calories: 320, protein_g: 6, carbs_g: 38, fat_g: 14 },
  { key: "rice", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["rice", "rice bowl", "steamed rice", "jeera rice", "white rice", "boiled rice", "chawal", "bhaat"], calories: 210, protein_g: 4, carbs_g: 45, fat_g: 0.5 },
  { key: "dal", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["dal", "daal", "dal bowl", "lentils", "tadka dal", "dal fry"], calories: 150, protein_g: 9, carbs_g: 20, fat_g: 3 },
  { key: "sabzi", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["sabzi", "sabji", "mixed veg", "veg curry", "bhindi", "aloo gobi"], calories: 130, protein_g: 4, carbs_g: 12, fat_g: 7 },
  { key: "rajma", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["rajma", "kidney beans"], calories: 200, protein_g: 12, carbs_g: 30, fat_g: 4 },
  { key: "chole", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["chole", "chana", "chickpea curry", "chana masala", "chhole"], calories: 220, protein_g: 11, carbs_g: 28, fat_g: 7 },
  { key: "sambar", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["sambar", "sambhar"], calories: 140, protein_g: 6, carbs_g: 18, fat_g: 4 },
  { key: "curd", category: "protein", kind: "count", unit: "1 katori", gramsPerUnit: 150, mlPerUnit: 150, aliases: ["curd", "dahi", "yogurt", "yoghurt"], calories: 90, protein_g: 5, carbs_g: 6, fat_g: 5 },
  { key: "greek yogurt", category: "protein", kind: "gram", per: 100, unit: "100 g", aliases: ["greek yogurt", "greek yoghurt", "hung curd"], calories: 60, protein_g: 10, carbs_g: 4, fat_g: 0.4 },
  { key: "paneer", category: "protein", kind: "gram", per: 100, unit: "100 g", aliases: ["paneer", "cottage cheese"], calories: 265, protein_g: 18, carbs_g: 4, fat_g: 20 },
  // SOYA CHUNKS AND BOILED SOYBEANS ARE NOT THE SAME FOOD, and conflating them is
  // a 3x protein error on the single biggest protein source in this owner's diet.
  //
  // Soya chunks (TVP, sold here as Nutrela or "meal maker") are a dry extruded
  // product: 52 g protein per 100 g, and they are weighed DRY before soaking.
  // Boiled soybeans are the whole bean cooked: 18 g per 100 g. One entry claiming
  // "100 g cooked" used to carry BOTH, so "70 g soya chunks (soaked, drained)" -
  // 70 g of dry chunks, 36 g of protein - was priced as 70 g of boiled beans at
  // 12.6 g. That single row is the whole of a 26 g gap between two days the owner
  // ate identically, and it is why they noticed.
  //
  // The bare words default to CHUNKS because that is what "soyabean" means in an
  // Indian kitchen and what every row in this app's history has actually been.
  // The boiled bean needs saying out loud, and its aliases are longer so they win
  // the match.
  { key: "soya chunks", category: "protein", kind: "gram", per: 100, unit: "100 g dry", aliases: ["soya chunks", "soy chunks", "soya chunk", "soya bean", "soya beans", "soyabean", "soyabeans", "soybean", "soybeans", "soya", "nutrela", "meal maker", "textured vegetable protein", "tvp"], calories: 345, protein_g: 52, carbs_g: 33, fat_g: 0.5 },
  { key: "boiled soybean", category: "protein", kind: "gram", per: 100, unit: "100 g cooked", aliases: ["boiled soybeans", "boiled soybean", "cooked soybeans", "cooked soybean", "boiled soya", "cooked soya", "boiled soya beans"], calories: 172, protein_g: 18, carbs_g: 10, fat_g: 9 },
  { key: "tofu", category: "protein", kind: "gram", per: 100, unit: "100 g", aliases: ["tofu"], calories: 145, protein_g: 15, carbs_g: 4, fat_g: 9 },
  { key: "idli", category: "staple", kind: "count", unit: "1 piece", aliases: ["idli", "idlis", "idly"], calories: 50, protein_g: 1.5, carbs_g: 10, fat_g: 0.3 },
  { key: "dosa", category: "staple", kind: "count", unit: "1 plain", aliases: ["dosa", "dosas", "plain dosa"], calories: 170, protein_g: 4, carbs_g: 28, fat_g: 4 },
  { key: "masala dosa", category: "staple", kind: "count", unit: "1 piece", aliases: ["masala dosa", "masala dosas"], calories: 260, protein_g: 5, carbs_g: 36, fat_g: 10 },
  { key: "poha", category: "staple", kind: "count", unit: "1 plate", gramsPerUnit: 150, aliases: ["poha"], calories: 250, protein_g: 5, carbs_g: 40, fat_g: 7 },
  { key: "upma", category: "staple", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["upma"], calories: 230, protein_g: 5, carbs_g: 35, fat_g: 8 },
  { key: "khichdi", category: "staple", kind: "count", unit: "1 bowl", gramsPerUnit: 250, aliases: ["khichdi"], calories: 290, protein_g: 11, carbs_g: 45, fat_g: 6 },
  { key: "biryani veg", category: "fastfood", kind: "count", unit: "1 plate", aliases: ["veg biryani", "vegetable biryani"], calories: 480, protein_g: 12, carbs_g: 70, fat_g: 16 },
  { key: "biryani chicken", category: "fastfood", kind: "count", unit: "1 plate", aliases: ["chicken biryani", "biryani"], calories: 600, protein_g: 28, carbs_g: 70, fat_g: 22 },
  { key: "chicken curry", category: "protein", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["chicken curry", "chicken gravy", "butter chicken"], calories: 280, protein_g: 22, carbs_g: 6, fat_g: 18 },
  { key: "chicken breast", category: "protein", kind: "gram", per: 100, unit: "100 g", aliases: ["chicken breast", "grilled chicken", "chicken 100g", "chicken"], calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  { key: "fish curry", category: "protein", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["fish curry", "fish"], calories: 230, protein_g: 20, carbs_g: 5, fat_g: 14 },
  { key: "mutton curry", category: "protein", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["mutton curry", "mutton", "lamb curry"], calories: 300, protein_g: 22, carbs_g: 5, fat_g: 22 },
  { key: "egg curry", category: "protein", kind: "count", unit: "1 katori (2 egg)", gramsPerUnit: 150, aliases: ["egg curry", "anda curry", "egg masala"], calories: 230, protein_g: 14, carbs_g: 6, fat_g: 16 },
  { key: "samosa", category: "fastfood", kind: "count", unit: "1 piece", aliases: ["samosa", "samosas"], calories: 130, protein_g: 3, carbs_g: 16, fat_g: 7 },
  { key: "pakora", category: "fastfood", kind: "count", unit: "1 piece", aliases: ["pakora", "pakoda", "bhaji"], calories: 60, protein_g: 1.5, carbs_g: 5, fat_g: 4 },
  { key: "vada pav", category: "fastfood", kind: "count", unit: "1 piece", aliases: ["vada pav", "vada pao"], calories: 290, protein_g: 7, carbs_g: 42, fat_g: 11 },
  { key: "pav bhaji", category: "fastfood", kind: "count", unit: "1 plate", aliases: ["pav bhaji", "pao bhaji"], calories: 400, protein_g: 9, carbs_g: 48, fat_g: 18 },
  { key: "salad", category: "veg", kind: "count", unit: "1 bowl", gramsPerUnit: 250, aliases: ["salad", "salad bowl", "veg salad", "green salad"], calories: 150, protein_g: 5, carbs_g: 15, fat_g: 7 },
  { key: "fruit chaat", category: "fruit", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["fruit chaat", "fruit salad"], calories: 110, protein_g: 1.5, carbs_g: 26, fat_g: 0.5 },

  // --- drinks ---
  // Packet namkeen. Densest thing the owner logs (a 50 g handful is a third of a
  // roti day's calories), and it was absent, so every bhujia row was a guess.
  { key: "aloo bhujia", category: "snack", kind: "gram", per: 100, unit: "100 g", aliases: ["aloo bhujia", "aloo bhujiya", "bhujia", "bhujiya", "sev", "namkeen", "mixture"], calories: 570, protein_g: 12, carbs_g: 50, fat_g: 36 },
  // The instant sachet, not a bowl of restaurant soup - the whole point of the
  // entry is that it is nearly nothing and should not be priced like a meal.
  { key: "instant soup", category: "drink", kind: "count", unit: "1 sachet", aliases: ["soup sachet", "soup sachets", "instant soup", "soup packet", "knorr soup", "soop sachet"], calories: 40, protein_g: 1, carbs_g: 8, fat_g: 0.5 },
  { key: "tomato", category: "veg", kind: "count", unit: "1 medium", gramsPerUnit: 100, aliases: ["tomato", "tomatoes", "tamatar"], calories: 18, protein_g: 0.9, carbs_g: 3.9, fat_g: 0.2 },
  { key: "cucumber", category: "veg", kind: "count", unit: "1 medium", gramsPerUnit: 150, aliases: ["cucumber", "cucumbers", "kheera", "kakdi"], calories: 22, protein_g: 1, carbs_g: 5, fat_g: 0.2 },
  { key: "onion", category: "veg", kind: "count", unit: "1 medium", gramsPerUnit: 110, aliases: ["onion", "onions", "pyaz", "pyaaz"], calories: 44, protein_g: 1.2, carbs_g: 10, fat_g: 0.1 },
  { key: "chutney", category: "veg", kind: "count", unit: "1 tbsp", gramsPerUnit: 15, aliases: ["chutney", "chatni", "green chutney", "coconut chutney"], calories: 25, protein_g: 0.6, carbs_g: 2, fat_g: 1.8 },
  { key: "chai", category: "drink", kind: "count", unit: "1 cup", mlPerUnit: 150, aliases: ["chai", "tea", "masala chai", "milk tea", "doodh chai"], calories: 70, protein_g: 2, carbs_g: 8, fat_g: 3 },
  { key: "black tea", category: "drink", kind: "count", unit: "1 cup", mlPerUnit: 150, aliases: ["black tea", "green tea", "lemon tea"], calories: 5, protein_g: 0, carbs_g: 1, fat_g: 0 },
  { key: "coffee", category: "drink", kind: "count", unit: "1 cup", mlPerUnit: 150, aliases: ["coffee", "milk coffee", "cappuccino", "latte", "cafe latte"], calories: 60, protein_g: 2, carbs_g: 7, fat_g: 3 },
  { key: "black coffee", category: "drink", kind: "count", unit: "1 cup", mlPerUnit: 150, aliases: ["black coffee", "americano", "espresso"], calories: 5, protein_g: 0.3, carbs_g: 1, fat_g: 0 },
  { key: "filter coffee", category: "drink", kind: "count", unit: "1 cup", mlPerUnit: 150, aliases: ["filter coffee", "south indian coffee"], calories: 90, protein_g: 3, carbs_g: 9, fat_g: 4 },
  { key: "milk", category: "drink", kind: "ml", per: 250, unit: "1 glass (250 ml)", aliases: ["milk", "toned milk", "doodh"], calories: 140, protein_g: 8, carbs_g: 12, fat_g: 5 },
  { key: "lassi", category: "drink", kind: "count", unit: "1 glass", mlPerUnit: 250, aliases: ["lassi", "sweet lassi"], calories: 220, protein_g: 7, carbs_g: 28, fat_g: 8 },
  { key: "buttermilk", category: "drink", kind: "count", unit: "1 glass", mlPerUnit: 250, aliases: ["buttermilk", "chaas", "chhaas"], calories: 60, protein_g: 3, carbs_g: 6, fat_g: 2 },
  { key: "juice", category: "drink", kind: "count", unit: "1 glass", mlPerUnit: 250, aliases: ["juice", "orange juice", "fruit juice", "mango juice"], calories: 130, protein_g: 1, carbs_g: 32, fat_g: 0.3 },
  { key: "soft drink", category: "softdrink", kind: "count", unit: "1 can", aliases: ["coke", "coca cola", "cocacola", "pepsi", "soft drink", "cola", "soda", "sprite", "thums up", "limca", "fanta", "mirinda"], calories: 140, protein_g: 0, carbs_g: 39, fat_g: 0 },
  // A zero-sugar can is ~1 kcal, not 140. Without this row a "Coke Zero" fuzzy-
  // matched the full-sugar entry above and charged 140 kcal / 39 g carbs that the
  // drink does not contain. SUGAR_FREE_CUE below routes any sugar-free phrasing
  // here even when only the plain alias ("cola", "soft drink") is what matched.
  { key: "diet soft drink", category: "drink", kind: "count", unit: "1 can", aliases: ["diet coke", "coke zero", "coca cola zero", "diet pepsi", "pepsi black", "pepsi zero", "sprite zero", "thums up zero", "zero sugar cola", "sugar free cola", "diet soda", "diet soft drink"], calories: 2, protein_g: 0, carbs_g: 0.5, fat_g: 0 },
  { key: "protein shake", category: "protein", kind: "count", unit: "1 glass", mlPerUnit: 300, aliases: ["protein shake", "protein milk shake", "mass gainer shake"], calories: 250, protein_g: 35, carbs_g: 12, fat_g: 5 },
  { key: "whey scoop", category: "protein", kind: "count", unit: "1 scoop", aliases: ["whey", "whey protein", "whey powder", "whey scoop", "protein powder", "protein scoop", "scoop whey", "scoop of whey"], calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 },

  // --- fruits ---
  { key: "banana", category: "fruit", kind: "count", unit: "1 medium", aliases: ["banana", "bananas", "kela"], calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.3 },
  { key: "blueberry", category: "fruit", kind: "gram", per: 100, unit: "100 g", aliases: ["blueberry", "blueberries"], calories: 57, protein_g: 0.7, carbs_g: 14, fat_g: 0.3 },
  { key: "apple", category: "fruit", kind: "count", unit: "1 medium", aliases: ["apple", "apples", "seb"], calories: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 },
  { key: "guava", category: "fruit", kind: "gram", per: 100, unit: "100 g", aliases: ["guava", "amrood"], calories: 68, protein_g: 2.6, carbs_g: 14, fat_g: 1 },
  { key: "orange", category: "fruit", kind: "count", unit: "1 medium", aliases: ["orange", "oranges", "santra"], calories: 62, protein_g: 1.2, carbs_g: 15, fat_g: 0.2 },
  { key: "mango", category: "fruit", kind: "count", unit: "1 medium", aliases: ["mango", "mangoes", "aam"], calories: 150, protein_g: 2, carbs_g: 38, fat_g: 0.6 },

  // --- snacks / packaged ---
  { key: "cookie", category: "snack", kind: "count", unit: "1 cookie", aliases: ["cookie", "cookies", "biscuit", "biscuits", "choc chip cookie", "choco chip cookie", "chocolate chip cookie", "choco chip cookies", "choc chip cookies", "chocolate chip cookies", "cream biscuit"], calories: 55, protein_g: 0.7, carbs_g: 7, fat_g: 2.7 },
  { key: "rusk", category: "snack", kind: "count", unit: "1 piece", aliases: ["rusk", "toast biscuit"], calories: 40, protein_g: 0.8, carbs_g: 7, fat_g: 1 },
  { key: "bread slice", category: "staple", kind: "count", unit: "1 slice", aliases: ["bread slice", "bread", "toast", "slice of bread", "bread slices"], calories: 70, protein_g: 2.5, carbs_g: 13, fat_g: 1 },
  { key: "butter", category: "condiment", kind: "count", unit: "1 tsp", aliases: ["butter", "makhan"], calories: 35, protein_g: 0, carbs_g: 0, fat_g: 4 },
  { key: "jam", category: "condiment", kind: "count", unit: "1 tbsp", aliases: ["jam", "marmalade"], calories: 50, protein_g: 0, carbs_g: 13, fat_g: 0 },
  { key: "cheese slice", category: "condiment", kind: "count", unit: "1 slice", aliases: ["cheese slice", "cheese", "cheese slices"], calories: 60, protein_g: 4, carbs_g: 1, fat_g: 5 },
  { key: "peanut butter", category: "protein", kind: "count", unit: "1 tbsp", aliases: ["peanut butter", "pb"], calories: 95, protein_g: 4, carbs_g: 3, fat_g: 8 },
  { key: "chocolate", category: "snack", kind: "count", unit: "1 small bar (30 g)", aliases: ["chocolate", "dairy milk", "choco bar", "chocolate bar"], calories: 160, protein_g: 2, carbs_g: 18, fat_g: 9 },
  { key: "chips", category: "snack", kind: "count", unit: "1 small packet", aliases: ["chips", "lays", "potato chips", "wafers"], calories: 270, protein_g: 3, carbs_g: 27, fat_g: 17 },
  // Baked millet/ragi chips are their own thing - lighter in fat than fried
  // potato chips, and sold in a labelled 55 g pack, so price them per gram.
  { key: "millet chips", category: "snack", kind: "gram", per: 55, unit: "1 pack (55 g)", aliases: ["ragi chips", "millet chips", "ragi chip", "millet chip", "baked chips"], calories: 250, protein_g: 4.5, carbs_g: 33, fat_g: 11 },
  { key: "namkeen", category: "snack", kind: "count", unit: "1 serving (30 g)", aliases: ["namkeen", "mixture", "sev", "bhujia"], calories: 150, protein_g: 3, carbs_g: 15, fat_g: 9 },
  { key: "oats", category: "staple", kind: "gram", per: 40, unit: "40 g serving", aliases: ["oats", "oatmeal", "porridge"], calories: 150, protein_g: 5, carbs_g: 27, fat_g: 3 },
  { key: "peanuts", category: "protein", kind: "gram", per: 30, unit: "30 g handful", aliases: ["peanuts", "groundnut", "moongphali", "roasted peanuts"], calories: 170, protein_g: 7, carbs_g: 5, fat_g: 14 },
  { key: "almonds", category: "protein", kind: "count", unit: "1 almond", aliases: ["almond", "almonds", "badam"], calories: 7, protein_g: 0.26, carbs_g: 0.25, fat_g: 0.6 },
  { key: "seeds", category: "protein", kind: "count", unit: "1 tbsp", aliases: ["seeds", "seed mix", "pumpkin seeds", "chia", "chia seeds", "flax seeds", "sunflower seeds"], calories: 50, protein_g: 2, carbs_g: 3, fat_g: 4 },
  { key: "noodles", category: "fastfood", kind: "count", unit: "1 pack", aliases: ["maggi", "noodles", "ramen", "instant noodles"], calories: 350, protein_g: 8, carbs_g: 50, fat_g: 13 },
  { key: "pasta", category: "fastfood", kind: "count", unit: "1 plate", aliases: ["pasta", "macaroni", "white sauce pasta"], calories: 350, protein_g: 10, carbs_g: 55, fat_g: 9 },
  { key: "sandwich", category: "fastfood", kind: "count", unit: "1 sandwich", aliases: ["sandwich", "veg sandwich", "grilled sandwich"], calories: 250, protein_g: 8, carbs_g: 35, fat_g: 9 },
  { key: "popcorn", category: "snack", kind: "gram", per: 100, unit: "100 g", aliases: ["popcorn", "cheese popcorn", "caramel popcorn"], calories: 500, protein_g: 8, carbs_g: 57, fat_g: 27 },
  { key: "burrito", category: "fastfood", kind: "count", unit: "1 regular", aliases: ["burrito", "burritos"], calories: 900, protein_g: 30, carbs_g: 110, fat_g: 38 },
  { key: "nachos", category: "fastfood", kind: "gram", per: 100, unit: "100 g", aliases: ["nachos", "nacho"], calories: 490, protein_g: 8, carbs_g: 58, fat_g: 25 },
  { key: "quesadilla", category: "fastfood", kind: "count", unit: "1 piece", aliases: ["quesadilla", "quesadillas"], calories: 520, protein_g: 22, carbs_g: 40, fat_g: 29 },
  { key: "burger", category: "fastfood", kind: "count", unit: "1 burger", aliases: ["burger", "veg burger", "aloo tikki burger"], calories: 350, protein_g: 10, carbs_g: 45, fat_g: 14 },
  { key: "chicken burger", category: "fastfood", kind: "count", unit: "1 burger", aliases: ["chicken burger", "mcchicken", "chicken patty burger"], calories: 450, protein_g: 22, carbs_g: 40, fat_g: 22 },
  { key: "pizza slice", category: "fastfood", kind: "count", unit: "1 slice", aliases: ["pizza slice", "pizza", "pizza slices"], calories: 285, protein_g: 12, carbs_g: 36, fat_g: 10 },
  { key: "momo", category: "fastfood", kind: "count", unit: "1 piece", aliases: ["momo", "momos", "dumpling", "dumplings"], calories: 35, protein_g: 1.5, carbs_g: 5, fat_g: 1 },

  // --- desserts ---
  // Added 2026-08-06. `grep -c "ice cream" lib/food-nutrition.mjs` returned 0:
  // the owner's own worked example of a pattern ("if I eat ice cream every
  // Sunday it should tell me") was unmatchable by the only food vocabulary the
  // app has. A whole class of weekend eating was invisible - not
  // under-estimated, INVISIBLE, because an unrecognised food never becomes a
  // row the pattern engine can count.
  { key: "ice cream", category: "dessert", kind: "count", unit: "1 scoop", gramsPerUnit: 100, aliases: ["ice cream", "icecream", "ice creams", "ice cream scoop", "gelato", "softy", "soft serve", "sundae"], calories: 200, protein_g: 3.5, carbs_g: 24, fat_g: 11 },
  { key: "kulfi", category: "dessert", kind: "count", unit: "1 piece", aliases: ["kulfi", "kulfis", "matka kulfi"], calories: 190, protein_g: 4, carbs_g: 20, fat_g: 10 },
  { key: "gulab jamun", category: "dessert", kind: "count", unit: "1 piece", aliases: ["gulab jamun", "gulab jamuns", "gulabjamun"], calories: 150, protein_g: 2, carbs_g: 25, fat_g: 5 },
  { key: "jalebi", category: "dessert", kind: "count", unit: "1 piece", aliases: ["jalebi", "jalebis"], calories: 150, protein_g: 1, carbs_g: 26, fat_g: 5 },
  { key: "rasgulla", category: "dessert", kind: "count", unit: "1 piece", aliases: ["rasgulla", "rasgullas", "rosogolla"], calories: 106, protein_g: 2, carbs_g: 20, fat_g: 2 },
  { key: "rasmalai", category: "dessert", kind: "count", unit: "1 piece", aliases: ["rasmalai", "ras malai", "rasmalais"], calories: 190, protein_g: 6, carbs_g: 22, fat_g: 9 },
  { key: "kheer", category: "dessert", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["kheer", "payasam", "rice pudding", "sewai"], calories: 250, protein_g: 6, carbs_g: 38, fat_g: 8 },
  { key: "halwa", category: "dessert", kind: "count", unit: "1 katori", gramsPerUnit: 150, aliases: ["halwa", "halva", "sooji halwa", "suji halwa", "gajar halwa", "carrot halwa"], calories: 320, protein_g: 5, carbs_g: 45, fat_g: 14 },
  { key: "laddu", category: "dessert", kind: "count", unit: "1 piece", aliases: ["laddu", "ladoo", "laddoo", "besan laddu", "motichoor laddu"], calories: 185, protein_g: 4, carbs_g: 22, fat_g: 9 },
  { key: "barfi", category: "dessert", kind: "count", unit: "1 piece", aliases: ["barfi", "burfi", "kaju katli", "kaju barfi"], calories: 145, protein_g: 3, carbs_g: 17, fat_g: 7 },
  { key: "cake", category: "dessert", kind: "count", unit: "1 slice", gramsPerUnit: 100, aliases: ["cake", "cake slice", "pastry", "cupcake", "cup cake", "black forest"], calories: 350, protein_g: 4, carbs_g: 50, fat_g: 15 },
  { key: "brownie", category: "dessert", kind: "count", unit: "1 piece", aliases: ["brownie", "brownies"], calories: 240, protein_g: 3, carbs_g: 32, fat_g: 12 },
  { key: "donut", category: "dessert", kind: "count", unit: "1 piece", aliases: ["donut", "donuts", "doughnut", "doughnuts"], calories: 250, protein_g: 4, carbs_g: 31, fat_g: 13 },
];

if (FOOD_TABLE.length < 50) {
  throw new Error("food-nutrition table must list at least 50 everyday foods");
}

// CATEGORY LAYER - what makes "pizza OR going out with friends" detectable.
//
// The owner's flagship request is a CATEGORY pattern, not a dish pattern. Pizza
// twice plus a burger twice across four Saturdays is support 2 at key level -
// dead at the floor, correctly - and support 4 at `indulgence` level, which
// fires. Without a rollup the requirement simply cannot be met, no matter how
// good the statistics are.
//
// Leaf categories stay narrow enough to be useful on their own ("dessert every
// Sunday" is a better sentence than "indulgence every Sunday"); the parent is
// what unions the split keys.
const CATEGORY_PARENT = {
  dessert: "indulgence",
  fastfood: "indulgence",
  snack: "indulgence",
  softdrink: "indulgence",
};

const CATEGORY_BY_KEY = new Map(FOOD_TABLE.map((e) => [e.key, e.category]));

// Every entry must carry a category or the rollup silently under-counts: a food
// with no category contributes nothing to `indulgence` and the pattern it was
// part of quietly loses support. Fail loudly at import instead, the same way the
// 50-food floor above does.
for (const entry of FOOD_TABLE) {
  if (!entry.category) throw new Error(`food-nutrition: FOOD_TABLE entry "${entry.key}" has no category`);
}

export function categoryOf(key) {
  return CATEGORY_BY_KEY.get(key) || null;
}

// The parent of a CATEGORY (not of a food key). Lets a consumer rank two
// categories by specificity: "dessert" beats "indulgence" for the same set of
// days, so the user hears the sharper of the two sentences, not both.
export function categoryParentOf(category) {
  return CATEGORY_PARENT[category] || null;
}

// The leaf category plus every ancestor, e.g. "ice cream" -> ["dessert", "indulgence"].
// Returns [] for an unknown key rather than guessing a category, because a
// guessed category is a claim about the user's eating that nobody made.
export function categoryChainOf(key) {
  const leaf = CATEGORY_BY_KEY.get(key);
  if (!leaf) return [];
  const chain = [leaf];
  let cur = leaf;
  while (CATEGORY_PARENT[cur] && !chain.includes(CATEGORY_PARENT[cur])) {
    cur = CATEGORY_PARENT[cur];
    chain.push(cur);
  }
  return chain;
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
  // Plurals of the measure words above. Their absence made "2 scoops whey"
  // report "scoops" as an unknown FOOD and lose the table's macros entirely.
  "plates", "bowls", "cups", "glasses", "katoris", "scoops", "handful", "handfuls",
  "serving", "servings", "approx", "about", "around", "roughly", "g", "gram", "grams", "gm", "ml", "kg", "tbsp", "tsp",
  "veg", "non", "veggie", "ka", "ki", "ke", "aur", "thoda", "kuch", "wala", "style", "type", "kind", "mix", "mixed",
  // Packaged-goods noise. A delivery order names a BRAND, a PACK and a FLAVOUR
  // around the food ("Eat Better Co Ragi Chips, Achari Masti (55 g)"); without
  // these every such line reported unknown foods and lost its table macros.
  "can", "cans", "pack", "packs", "packet", "packets", "bottle", "bottles", "box", "tin", "tetra", "combo",
  // Ranked out of scripts/food-vocab-audit.mjs against every food row ever
  // logged. "whole" alone broke "6 whole boiled eggs" - the owner's actual
  // breakfast - even though "boiled eggs" is an exact alias, because ONE unknown
  // token drops `recognized` to false and hands the entire meal to the model.
  "water", "paani", "pani", "whole", "cooked", "uncooked", "soaked", "drained", "chopped", "sliced", "diced", "peeled",
  "quantity", "standard", "unknown", "all", "each", "total", "approx.", "leftover",
  "drank", "drink", "drinks", "drinking", "tub", "tubs", "movie", "theater", "theatre", "party",
  "brick", "bricks", "assorted", "flavour", "flavor", "flavoured",
  // Brands seen in the owner's own history. A brand is not a food, and treating
  // one as an unknown food loses the macros of the food beside it.
  "haldiram", "haldirams", "tata", "bistro", "saffola", "amul", "britannia", "nestle", "epigamia",
  "sugar", "zero", "diet", "sugarfree", "light", "lite", "better", "best", "co", "ltd", "pvt", "limited", "brand",
  "flavour", "flavours", "flavor", "flavors", "salted", "salt", "sweet", "sour", "tangy", "creamy", "crunchy", "baked",
  "achari", "tadka", "masti", "chilli", "chili", "thai", "peri", "cream", "onion", "classic", "original", "value",
]);

// A sugar-free qualifier anywhere in the phrase reroutes a sugared drink to its
// zero-sugar row. This is a QUALIFIER scan rather than an alias, because the
// sugared alias usually still matches too: "Coca Cola Zero Sugar Soft Drink Can"
// contains "cola" AND "soft drink", and both must land on the diet row or the
// can gets priced at 140 kcal.
const SUGAR_FREE_CUE = /\b(?:zero[\s-]*sugar|no[\s-]*sugar|sugar[\s-]*free|sugarfree|zero|diet)\b/i;
const SUGAR_FREE_SWAP = { "soft drink": "diet soft drink" };

// Order manifests write the count AFTER the item ("Coke Zero (300 ml) x 3").
// The `x` must stand alone so "box 8" is not read as eight boxes.
const TRAILING_QTY = /(?:^|[\s)\]])[x×*]\s*(\d+(?:\.\d+)?)\s*$/i;

// Split a meal description into food phrases on natural separators. We keep
// decimals intact (do NOT split on ".") so "1.5 cups" survives.
function splitPhrases(text) {
  return String(text || "")
    .toLowerCase()
    // COLLAPSE A RANGE TO ITS MIDPOINT, before anything else touches the string.
    //
    // "200-300 g curd" used to parse as the bare count 200 - two hundred KATORIS
    // of curd, 18,000 kcal and 1,000 g of protein, from an entirely ordinary
    // sentence. The hyphen broke the "300 g" pairing, leaving "200" adjacent to a
    // food with no unit, and a bare number next to a food is a count.
    //
    // It survived unnoticed because the rows that used this phrasing all said
    // "water", which is zero either way. Nothing about the bug was specific to
    // water; the next range over a real food would have poisoned the day's
    // totals, the weekly review and the pattern engine at once.
    //
    // The midpoint is the honest reading of a stated range: the owner said they
    // do not know which, so neither end is more true than the other.
    .replace(/(\d+(?:\.\d+)?)\s*[-‐-―]\s*(\d+(?:\.\d+)?)(?=\s*(?:g\b|gm\b|gram|kg\b|ml\b|l\b|pieces?\b|nos?\b|\s|$))/g,
      (_m, a, b) => String(Math.round(((Number(a) + Number(b)) / 2) * 100) / 100))
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
// `lineQty` is the count carried by the whole line this phrase came from. An
// order manifest writes "Ragi Chips, Achari Masti (55 g) x 1", where the comma
// splits the flavour off into its own phrase and would otherwise strand the
// count on a phrase that names no food at all - counting two packs as one.
function parsePhrase(phrase, lineQty = null) {
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

  // Reroute sugared drinks to their zero-sugar row when the phrase says so.
  if (SUGAR_FREE_CUE.test(phrase)) {
    for (const f of found) {
      const swapKey = SUGAR_FREE_SWAP[f.entry.key];
      if (!swapKey) continue;
      const target = FOOD_TABLE.find((e) => e.key === swapKey);
      if (target) f.entry = target;
    }
  }

  // Two aliases of the SAME food inside one phrase are one mention, not two
  // ("Coca Cola ... Soft Drink Can" is a single can). Collapsing here is what
  // lets a trailing "x 3" attach once instead of being counted per alias.
  const seenKey = new Set();
  const deduped = [];
  for (const f of found) {
    if (seenKey.has(f.entry.key)) continue;
    seenKey.add(f.entry.key);
    deduped.push(f);
  }
  found.length = 0;
  found.push(...deduped);

  // Tokenize the ORIGINAL phrase to locate numbers / gram / ml quantities.
  const tokens = [...` ${phrase} `.matchAll(/(\d+(?:\.\d+)?)\s*(g|gram|grams|gm|ml|kg)?|[a-z]+/g)]
    .map((t) => ({ raw: t[0].trim(), num: numberAt(t[1] ?? t[0].trim()), unit: t[2] || null, index: t.index }));

  const numbers = tokens.filter((t) => t.num != null).sort((a, b) => a.index - b.index);

  // Assign quantities. Each number binds to the NEAREST food that starts after it
  // and isn't already taken - so "3 rotis dal sabzi" gives rotis=3, dal=1, sabzi=1
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
  // A trailing "x N" is the line-item count for the food(s) named in the phrase,
  // and it outranks the single-food fallback below - in "Coke Zero (300 ml) x 3"
  // the 300 is the can size and only the 3 is a count.
  const trailing = String(phrase).match(TRAILING_QTY);
  const trailingQty = trailing ? Number(trailing[1]) : null;
  if (Number.isFinite(trailingQty) && trailingQty > 0) {
    for (const f of sortedFoods) {
      if (!qtyFor.has(f)) qtyFor.set(f, { qty: trailingQty, explicit: true, grams: null, ml: null });
    }
  }
  if (sortedFoods.length === 1 && !qtyFor.has(sortedFoods[0]) && numbers.length) {
    qtyFor.set(sortedFoods[0], toQty(numbers[numbers.length - 1]));
  }
  // A STATED WEIGHT THAT TRAILS ITS FOOD OUTRANKS A VAGUE COUNT.
  //
  // Numbers only bind forwards, so "1 small bowl Haldiram Aloo Bhujia (30 g)"
  // gave the bowl the 1 and dropped the 30 g entirely - pricing a 30 g snack as
  // 100 g, 570 kcal instead of 171. The owner wrote the exact weight down and the
  // parser preferred the word "bowl".
  //
  // Deliberately narrow, because the opposite reading is also real: in "Coke Zero
  // (300 ml) x 3" the 300 is the CAN SIZE and only the 3 is a count. So this runs
  // only when there is no trailing "x N", and only upgrades a quantity that
  // carries no unit of its own.
  if (!Number.isFinite(trailingQty)) {
    for (const n of numbers) {
      if (!n.unit) continue;
      // The food this weight belongs to is the last one starting before it.
      let owner = null;
      for (const f of sortedFoods) if (f.start < n.index) owner = f; else break;
      if (!owner) continue;
      const cur = qtyFor.get(owner);
      if (cur && (cur.grams != null || cur.ml != null)) continue; // already precise
      qtyFor.set(owner, toQty(n));
    }
  }
  // Nothing in this phrase carried a count, so the line's own count applies.
  if (Number.isFinite(lineQty) && lineQty > 0) {
    for (const f of sortedFoods) {
      if (!qtyFor.has(f)) qtyFor.set(f, { qty: lineQty, explicit: true, grams: null, ml: null });
    }
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
    // Strip wrapping punctuation first, or a bracketed pack size arrives as
    // "(300" / "ml)" and is reported as an unknown FOOD, which drops an
    // otherwise fully-priced meal to recognized:false.
    const t = w.trim().replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
    if (t.length < 3) continue;
    if (/^\d/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    // A spelled-out number is a quantity, never a food. Without this "one
    // tomato" reported "one" as an unknown FOOD and lost the whole line's
    // macros, while "1 tomato" priced correctly - the same sentence, two
    // answers, decided by whether the owner typed a digit.
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t)) continue;
    unknown.push(t);
  }
  return { items, unknown };
}

function multiplier(item) {
  const e = item.entry;
  if (e.kind === "gram") return (item.grams != null ? item.grams : (item.qty || 1) * (e.per || 100)) / (e.per || 100);
  if (e.kind === "ml") return (item.ml != null ? item.ml : (item.qty || 1) * (e.per || 250)) / (e.per || 250);
  // count-kind: a gram/ml quantity is a WEIGHT, not a serving count. "250 g rice"
  // must NOT become 250 katoris (that was a 100x blow-up: 250g -> 52,500 kcal).
  // Convert via the entry's grams/ml-per-serving when known (rice = 150 g/katori,
  // so 250 g = 1.67); otherwise treat a weighed mention as a single serving rather
  // than multiplying servings by the raw gram number.
  if (item.grams != null) return e.gramsPerUnit ? item.grams / e.gramsPerUnit : 1;
  if (item.ml != null) return e.mlPerUnit ? item.ml / e.mlPerUnit : 1;
  return item.qty || 1;
}

// Did we quietly throw away a stated weight or volume?
//
// A count-kind food with no gramsPerUnit/mlPerUnit falls back to ONE serving,
// whatever number the user said. That is the right guard against "250 g rice"
// becoming 250 katoris - but it silently converts a real quantity into a guess,
// and the table's totals then OVERRIDE the model (see CLAUDE.md), so the guess
// wins. Measured on real rows: "6 boiled eggs and 500ml curd" was priced at
// 522 kcal / 42.8g protein, charging half a litre of curd as one 150g katori
// and costing ~12g of protein on the metric the owner is short on.
//
// Serving sizes are filled in above for the foods he actually weighs. For any
// that remain, say so, so recognized goes false and the model prices it instead
// of the table asserting a serving count nobody stated.
function unscaledQuantity(item) {
  const e = item.entry;
  if (e.kind !== "count") return false;
  if (item.grams != null && !e.gramsPerUnit) return true;
  if (item.ml != null && !e.mlPerUnit) return true;
  return false;
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
  const matchedByKey = new Map(); // key -> { entry, qty, explicit }
  const unknown = new Set();

  // Lines are the outer unit: one line of an order is one line item, and its
  // trailing count belongs to every food named on that line.
  const lines = String(text || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const phrases = [];
  for (const line of lines) {
    const m = line.match(TRAILING_QTY);
    const n = m ? Number(m[1]) : null;
    const lineQty = Number.isFinite(n) && n > 0 ? n : null;
    for (const phrase of splitPhrases(line)) phrases.push({ phrase, lineQty });
  }

  for (const { phrase, lineQty } of phrases) {
    const { items, unknown: unk } = parsePhrase(phrase, lineQty);
    for (const it of items) {
      const key = it.entry.key;
      const mult = multiplier(it);
      const prev = matchedByKey.get(key);
      if (!prev) { matchedByKey.set(key, { entry: it.entry, mult, explicit: it.explicit, unscaled: unscaledQuantity(it) }); continue; }
      // Same food seen twice: an explicit-quantity mention wins over a bare one
      // ("egg curry ... 2 eggs" -> egg counts as 2, not 1+2). Two explicit
      // mentions add up.
      if (unscaledQuantity(it)) prev.unscaled = true;
      if (it.explicit && prev.explicit) prev.mult += mult;
      else if (it.explicit && !prev.explicit) { prev.mult = mult; prev.explicit = true; }
      // bare-after-explicit or bare-after-bare: keep what we have.
    }
    for (const u of unk) unknown.add(u);
  }

  // Composite-dish de-dup: if the user names a dish AND itemizes its components
  // with an explicit count ("egg curry ... 2 eggs"), the explicit items are the
  // real content - drop the composite so we don't count the eggs twice.
  const COMPOSITE_COMPONENTS = { "egg curry": ["egg", "egg white"] };
  for (const [dish, parts] of Object.entries(COMPOSITE_COMPONENTS)) {
    if (matchedByKey.has(dish) && parts.some((p) => matchedByKey.get(p)?.explicit)) {
      matchedByKey.delete(dish);
    }
  }

  const items = [];
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const unscaled = [];
  for (const { entry, mult, unscaled: isUnscaled } of matchedByKey.values()) {
    if (isUnscaled) unscaled.push(entry.key);
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
    // Foods whose stated weight/volume the table could not convert. Their row is
    // still returned (one serving) so the caller has something, but `recognized`
    // is false so the totals do NOT override the model.
    unscaled,
    recognized: matchedCount > 0 && unknownCount === 0 && unscaled.length === 0,
    coverage: matchedCount + unknownCount === 0 ? 0 : round1(matchedCount / (matchedCount + unknownCount)),
  };
}

export default { FOOD_TABLE, estimateNutrition, categoryOf, categoryChainOf, categoryParentOf };
