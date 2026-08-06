// WHAT ACTUALLY NEEDS DOING TONIGHT, derived from tomorrow's real meals.
//
// This replaces a hardcoded list. `prepForTomorrow()` in lib/diet-scaffold.mjs
// returned the same five sentences forever - soak 50 g dry soybeans, chill 200 g
// hung curd, keep 3 whole + 4 whites ready - regardless of what the owner eats or
// has ever eaten. The owner stopped having hung curd and the card kept asking
// them to chill some, every night, which is how a checklist teaches you to stop
// reading it.
//
// It is the same failure as the phantom meal card: a JS template rendered where
// the user expects a measurement. The rule this file follows instead:
//
//   NOTHING IS SUGGESTED THAT IS NOT NAMED IN TOMORROW'S ACTUAL PLAN.
//
// So the list can only ever shrink to empty, and empty is a legitimate answer
// that says so out loud. If tomorrow's plan is still the built-in scaffold
// rather than a real plan the owner set, the caller shows nothing at all -
// advice derived from a placeholder is fiction with a checkbox next to it.
//
// Pure: no DOM, no Supabase, no clock.

// Foods that genuinely need something done the night before, and the something.
// Deliberately short. A rule here has to survive the test "would a real cook be
// annoyed to be told this at 10pm?" - which is why "wash the vegetables" is not
// on it and "soak the rajma" is.
const PREP_RULES = [
  {
    id: "soak-legumes",
    match: /\b(soy\s*bean|soyabean|soybean|rajma|kidney bean|chana|chickpea|chhole|chole|black ?eyed|lobia|kabuli)\b/i,
    verb: "Soak",
    tail: "overnight - it needs 8 hours and cannot be rushed in the morning",
  },
  {
    id: "soak-chia",
    match: /\b(chia|basil seed|sabja|flax\s*seed)\b/i,
    verb: "Soak",
    tail: "for at least 20 minutes before it is eaten",
  },
  {
    id: "soak-oats",
    match: /\b(overnight oats|soaked oats|muesli)\b/i,
    verb: "Soak",
    tail: "tonight",
  },
  {
    id: "soak-nuts",
    match: /\b(almond|badam|walnut|akhrot)\b/i,
    verb: "Soak",
    tail: "overnight if you eat them soaked",
  },
  {
    id: "boil-eggs",
    // Matches the FOOD, whose name already carries the verb, so the sentence has
    // to be built from `noun` or it comes out as "boil the boiled eggs".
    match: /\bboiled eggs?\b/i,
    noun: "eggs",
    verb: "Boil",
    tail: "tonight so the morning is not a cooking job",
  },
  {
    id: "thaw",
    match: /\b(frozen|thaw|defrost)\b/i,
    verb: "Move",
    tail: "out of the freezer to thaw",
  },
  {
    id: "marinate",
    match: /\b(marinate|marinated|tandoori|tikka)\b/i,
    verb: "Marinate",
    tail: "tonight",
  },
  {
    id: "ferment",
    match: /\b(dosa|idli|dhokla|batter|curd|dahi|yog(h)?urt)\b/i,
    verb: "Set",
    tail: "tonight so it is ready by morning",
  },
];

/** The meal's human name, whatever shape the plan row is in. */
function mealText(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  return [m.name, m.detail, m.description].filter(Boolean).join(" ");
}

/**
 * Prep items for a list of meals.
 *
 * Each item names the MEAL it came from, so the card can never show an
 * instruction whose origin the owner cannot see. That is the whole difference
 * between this and the list it replaces: every line here is traceable to a row
 * in the plan, and if the plan changes the line disappears on its own.
 *
 * @param {Array} meals  tomorrow's meals, as `planForDate().meals`
 * @returns {{id: string, text: string, from: string}[]}
 */
export function prepFromMeals(meals) {
  const out = [];
  const seen = new Set();
  for (const m of meals || []) {
    const text = mealText(m);
    if (!text.trim()) continue;
    for (const rule of PREP_RULES) {
      const hit = text.match(rule.match);
      if (!hit) continue;
      // One line per (rule, food), not per meal: soybeans at lunch and soybeans
      // at dinner is one soaking job, and listing it twice is how a checklist
      // starts lying about how much work is left.
      const key = `${rule.id}:${hit[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // `noun` overrides the matched text when the match itself contains the verb
      // ("boiled eggs" -> "Boil the eggs", not "Boil the boiled eggs").
      const thing = rule.noun || hit[0].toLowerCase();
      out.push({
        id: `prep-${rule.id}-${seen.size}`,
        text: `${rule.verb} the ${thing} ${rule.tail}`,
        from: (typeof m === "object" && m && m.name) ? String(m.name) : text.slice(0, 40),
      });
    }
  }
  return out;
}
