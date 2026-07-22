// Pure shaping of recent domain rows into one day-over-day "additions" list for
// the Home feed. No DOM, no Supabase - browser/Node isomorphic, so it is tested
// directly. Money rows show a signed amount; diet rows show calories/protein.

const INR = new Intl.NumberFormat("en-IN");

// A plan row's scope is "permanent", a single date, or a comma-separated date
// list ("next 4 Mondays") - show a tidy count for the list case.
function planScopeLabel(scope) {
  const s = String(scope || "");
  if (!s || s === "permanent") return "permanent";
  const dates = s.split(",").map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  if (dates.length > 1) return `${dates.length} days`;
  return dates[0] || s;
}

function dayKeyOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function reviewLabel(a) {
  const args = a?.arguments || {};
  if (a?.tool_name === "request_user_review") {
    return String(args.raw_text || args.raw_input || args.reason || "Capture needs a look").slice(0, 60);
  }
  return String(args.description || args.merchant || args.note || args.body || a?.tool_name || "Pending capture").slice(0, 60);
}

export function buildAdditions(ledger = [], foods = [], userPlans = [], { limit = 80, notes = [], targetEvents = [], reviewActions = [] } = {}) {
  const items = [];
  // Pending/needs-review captures (e.g. the agent was unavailable, rate-limited,
  // or hit the daily cap). These are NOT yet domain rows, but they must be VISIBLE
  // so a capture is never silently lost - the user can dismiss or re-run them.
  for (const a of reviewActions) {
    items.push({
      id: a.id, table: "ai_actions", ts: a.created_at, domain: "review",
      label: reviewLabel(a),
      delta: a.tool_name === "request_user_review" ? "needs a look" : "pending review",
      dayKey: dayKeyOf(a.created_at),
      status: "review",
    });
  }
  // Notes / aspirations / todos - first-class captures, deletable from the feed.
  for (const n of notes) {
    if (n.status === "archived") continue;
    items.push({
      id: n.id, table: "notes", ts: n.occurred_at || n.created_at, domain: "note",
      label: n.body ? String(n.body).slice(0, 60) : (n.kind || "Note"),
      delta: `${n.kind || "note"}${n.due_on ? ` · due ${n.due_on}` : ""}`,
      dayKey: dayKeyOf(n.occurred_at || n.created_at),
      status: "added",
    });
  }
  // Target/budget changes the AI made (cascade) - shown with a one-tap undo.
  for (const e of targetEvents) {
    const after = e.after || {};
    const before = e.before || {};
    items.push({
      id: e.id, table: "budgets", ts: e.created_at, domain: "target",
      label: `Target: ${after.kind || "budget"}`,
      delta: `${before.amount != null ? before.amount : "-"} → ${after.amount != null ? after.amount : "-"}`,
      dayKey: dayKeyOf(e.created_at),
      status: "target", undoId: e.id,
    });
  }
  for (const p of userPlans) {
    items.push({
      id: p.id, table: "user_plans", ts: p.created_at, domain: "plan",
      label: p.summary || `${p.kind || "diet"} plan updated`,
      delta: `${p.kind || "diet"} · ${planScopeLabel(p.scope)}`,
      dayKey: dayKeyOf(p.created_at),
      status: "added",
    });
  }
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
