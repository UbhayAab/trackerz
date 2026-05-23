// Pure helpers for picking and instantiating meal_templates rows.
// `templates` is always an array of rows shaped like the supabase
// meal_templates table (name, meal_slot, description, calories_estimate,
// protein_g, carbs_g, fat_g, last_used_at, use_count).

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

// Match a template by free-text search over name + description.
// Returns the single best match or null.
export function pickByName(templates, query) {
  const needle = lower(query);
  if (!needle) return null;
  let best = null;
  let bestScore = 0;
  for (const tpl of templates || []) {
    const name = lower(tpl.name);
    const description = lower(tpl.description);
    let score = 0;
    if (name === needle) score = 1.0;
    else if (name.startsWith(needle)) score = 0.85;
    else if (name.includes(needle)) score = 0.7;
    else if (description.includes(needle)) score = 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  }
  return best;
}

// Pick the most recently used template for a given meal slot. If no template
// in that slot has been used yet, return the highest-use_count one as a
// fallback. Returns null if there is no match.
export function pickByLastUsed(templates, slot) {
  const want = lower(slot);
  const inSlot = (templates || []).filter((t) => lower(t.meal_slot) === want);
  if (!inSlot.length) return null;
  const used = inSlot.filter((t) => t.last_used_at);
  if (used.length) {
    used.sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at));
    return used[0];
  }
  const byCount = [...inSlot].sort((a, b) => (b.use_count || 0) - (a.use_count || 0));
  return byCount[0] || null;
}

// Turn a meal_template row into a food_logs insert shape. The caller supplies
// `occurred_at` (defaults to "now"). Numeric fields are coerced.
export function instantiate(template, options = {}) {
  if (!template) throw new Error("instantiate requires a template");
  const occurredAt = options.occurred_at
    ? new Date(options.occurred_at).toISOString()
    : new Date().toISOString();
  return {
    meal_name: template.name,
    meal_slot: template.meal_slot || "other",
    description: template.description,
    calories_estimate: template.calories_estimate == null ? null : Number(template.calories_estimate),
    protein_g: template.protein_g == null ? null : Number(template.protein_g),
    carbs_g: template.carbs_g == null ? null : Number(template.carbs_g),
    fat_g: template.fat_g == null ? null : Number(template.fat_g),
    occurred_at: occurredAt,
    confidence: 0.95,
    duplicate_state: "unique",
    source_template_id: template.id || null,
  };
}

export default { pickByName, pickByLastUsed, instantiate };
