// Pure shaping of recent domain rows into one day-over-day "additions" list for
// the Home feed. No DOM, no Supabase — browser/Node isomorphic, so it is tested
// directly. Money rows show a signed amount; diet rows show calories/protein.

const INR = new Intl.NumberFormat("en-IN");

function dayKeyOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildAdditions(ledger = [], foods = [], { limit = 80 } = {}) {
  const items = [];
  for (const r of ledger) {
    const sign = r.direction === "income" ? "+" : r.direction === "transfer" ? "±" : "-";
    items.push({
      id: r.id, table: "ledger_entries", ts: r.occurred_at, domain: "money",
      label: r.merchant || r.description || "Spend",
      delta: `${sign}Rs ${INR.format(Number(r.amount || 0))}`,
      dayKey: dayKeyOf(r.occurred_at),
      status: r.duplicate_state === "duplicate_loser" ? "merged" : "added",
    });
  }
  for (const r of foods) {
    const cal = r.calories_estimate != null ? `${r.calories_estimate} cal` : "";
    const pro = r.protein_g != null ? `${r.protein_g}g P` : "";
    items.push({
      id: r.id, table: "food_logs", ts: r.occurred_at, domain: "diet",
      label: r.meal_name || r.meal_slot || (r.description ? r.description.slice(0, 40) : "Meal"),
      delta: [cal, pro].filter(Boolean).join(" · "),
      dayKey: dayKeyOf(r.occurred_at),
      status: r.duplicate_state === "duplicate_loser" ? "merged" : "added",
    });
  }
  // Newest first; drop rows merged away by dedupe (they live under their winner).
  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return items.filter((i) => i.status !== "merged").slice(0, limit);
}

export function groupByDay(items = []) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.dayKey)) map.set(it.dayKey, []);
    map.get(it.dayKey).push(it);
  }
  return [...map.entries()].map(([dayKey, rows]) => ({ dayKey, rows }));
}
