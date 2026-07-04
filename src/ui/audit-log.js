// Raw-query audit log: shows every capture the user ever typed/spoke/snapped, the
// AI run that processed it, and the tool calls it produced — date-stamped so the
// user can audit "how did the app behave this week". The DATA already exists in
// raw_ingestions + ai_runs + ai_actions; this module only joins + renders it.
//
// The join/derive/summarize helpers are PURE (no DOM, no Supabase) so they're
// unit-tested hard in tests/audit-log.test.mjs; renderAuditLog() is the only part
// that touches the DOM.

// Map a tool call to the domain(s) it affects, so the audit can be filtered by
// "show me everything that touched money / diet / gym". A few tools are
// poly-domain (set_target depends on the budget kind; update_plan + note carry
// their domain in the arguments), so this needs the arguments, not just the name.
export function toolDomain(toolName, args = {}) {
  const a = args || {};
  switch (toolName) {
    case "create_expense_candidate":
    case "create_income_candidate":
    case "create_transfer_candidate":
    case "create_statement_row_candidate":
      return "money";
    case "create_food_log_candidate":
      return "diet";
    case "create_workout_log_candidate":
      return "gym";
    case "create_body_metric_candidate":
    case "create_wellness_note_candidate":
      return "wellness";
    case "set_target_candidate":
      // daily_calories / daily_protein / weekly_calories / food_cap are diet goals;
      // monthly_spend / weekly_spend are money goals.
      return /cal|protein|food/i.test(String(a.kind || "")) ? "diet" : "money";
    case "update_plan_candidate":
      return a.kind === "gym" ? "gym" : "diet";
    case "create_note_candidate":
      return ["money", "diet", "gym", "wellness", "general"].includes(a.domain) ? a.domain : "general";
    case "remember_fact":
      return "memory";
    case "link_duplicate_candidates":
      return "money";
    case "request_user_review":
      return "review";
    default:
      return "other";
  }
}

// Coarse ACTION type (by tool) — powers the audit "action" filter.
export function toolActionType(toolName) {
  switch (toolName) {
    case "create_expense_candidate": return "expense";
    case "create_income_candidate": return "income";
    case "create_transfer_candidate": return "transfer";
    case "create_statement_row_candidate": return "statement";
    case "create_food_log_candidate": return "food";
    case "create_workout_log_candidate": return "workout";
    case "create_body_metric_candidate": return "body";
    case "create_wellness_note_candidate": return "wellness";
    case "update_plan_candidate": return "plan";
    case "set_target_candidate": return "target";
    case "create_note_candidate": return "note";
    case "remember_fact": return "memory";
    case "link_duplicate_candidates": return "dedupe";
    case "request_user_review": return "review";
    default: return "other";
  }
}

// [value, label] options for the action filter <select>.
export const ACTION_FILTERS = [
  ["all", "All actions"], ["expense", "Expense"], ["income", "Income"], ["transfer", "Transfer"],
  ["food", "Food log"], ["workout", "Workout"], ["body", "Body metric"], ["wellness", "Wellness"],
  ["plan", "Plan change"], ["target", "Target change"], ["note", "Note"], ["memory", "Memory"],
  ["review", "Review"],
];

function clip(s, n = 60) { return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n); }

// One-line summary of the AI OUTPUT — the arguments the model decided on. This is
// the middle of the input -> AI output -> action chain the audit surfaces.
export function summarizeToolArgs(tool, args = {}) {
  const a = args || {};
  switch (tool) {
    case "create_expense_candidate": return `₹${a.amount ?? "?"}${a.merchant ? ` · ${clip(a.merchant, 28)}` : (a.description ? ` · ${clip(a.description, 28)}` : "")}`;
    case "create_income_candidate": return `+₹${a.amount ?? "?"}${a.merchant ? ` · ${clip(a.merchant, 28)}` : ""}`;
    case "create_transfer_candidate": return `⇄ ₹${a.amount ?? "?"}`;
    case "create_statement_row_candidate": return `₹${a.amount ?? "?"} · ${clip(a.description, 30)}`;
    case "create_food_log_candidate": return `${a.meal_slot || "meal"}: ${clip(a.description || a.meal_name, 40)}`;
    case "create_workout_log_candidate": return clip(a.description || "workout", 48);
    case "create_body_metric_candidate": return `${a.metric_type || "metric"} ${a.value ?? ""}${a.unit || ""}`.trim();
    case "create_wellness_note_candidate": return clip(a.note || `mood ${a.mood_score ?? "?"}`, 48);
    case "update_plan_candidate": {
      const op = a.payload?.op;
      const what = op
        ? `${op}${a.payload?.meal?.name ? ` ${clip(a.payload.meal.name, 20)}` : (a.payload?.workout?.name ? ` ${clip(a.payload.workout.name, 20)}` : "")}`
        : "full plan";
      return `${a.kind || "diet"} · ${what} · ${a.scope || "permanent"}`;
    }
    case "set_target_candidate": return `${a.kind || "target"} → ${a.amount ?? "?"}`;
    case "create_note_candidate": return `${a.kind || "note"}: ${clip(a.body, 40)}`;
    case "remember_fact": return `${clip(a.key, 24)} = ${clip(a.value, 30)}`;
    case "request_user_review": return clip(a.reason || "review", 48);
    case "link_duplicate_candidates": return "link duplicates";
    default: return clip(JSON.stringify(a), 60);
  }
}

// Normalize an ai_actions.status into a coarse outcome bucket for colour-coding.
export function actionOutcome(status) {
  const s = String(status || "").toLowerCase();
  if (s === "auto_applied" || s === "applied") return "applied";
  if (s === "rejected") return "rejected";
  if (s === "errored") return "errored";
  if (s === "proposed") return "review";
  return "other";
}

// The headline outcome for a whole capture (one raw_ingestion). Precedence is
// chosen so the most "actionable for the user" state surfaces: a queued capture
// (edge offline) and a needs-review capture should stand out over an applied one.
export function entryOutcome(entry) {
  const { runs = [], actions = [], status } = entry;
  if (!runs.length && (!actions.length) && status === "queued") return "queued";
  if (runs.some((r) => r.status === "errored") && !actions.length) return "errored";
  const buckets = actions.map((x) => actionOutcome(x.status));
  if (buckets.includes("review")) return "review";
  if (buckets.includes("applied")) return "applied";
  if (buckets.length && buckets.every((b) => b === "rejected")) return "rejected";
  if (buckets.includes("errored")) return "errored";
  return "no_action";
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Join the three raw tables into one entry per raw_ingestion (newest first),
// attaching its ai_runs + ai_actions and deriving rollup fields. Pure.
export function buildAuditEntries({ ingestions = [], runs = [], actions = [] } = {}) {
  const runsByIngestion = new Map();
  for (const r of runs) {
    const k = r.ingestion_id;
    if (!k) continue;
    if (!runsByIngestion.has(k)) runsByIngestion.set(k, []);
    runsByIngestion.get(k).push({
      id: r.id,
      provider: r.provider || "",
      model: r.model || "",
      promptTokens: num(r.prompt_tokens),
      outputTokens: num(r.output_tokens),
      costUsd: num(r.estimated_cost_usd),
      latencyMs: num(r.latency_ms),
      status: r.status || "",
      errorMessage: r.error_message || "",
      createdAt: r.created_at || "",
    });
  }
  const actionsByIngestion = new Map();
  for (const a of actions) {
    const k = a.ingestion_id;
    if (!k) continue;
    if (!actionsByIngestion.has(k)) actionsByIngestion.set(k, []);
    actionsByIngestion.get(k).push({
      id: a.id,
      tool: a.tool_name || "",
      arguments: a.arguments || {},
      confidence: num(a.confidence),
      status: a.status || "",
      appliedTable: a.applied_record_table || null,
      appliedId: a.applied_record_id || null,
      domain: toolDomain(a.tool_name, a.arguments),
      actionType: toolActionType(a.tool_name),
      argsSummary: summarizeToolArgs(a.tool_name, a.arguments),
      createdAt: a.created_at || "",
    });
  }

  return ingestions.map((ing) => {
    const entryRuns = runsByIngestion.get(ing.id) || [];
    const entryActions = (actionsByIngestion.get(ing.id) || [])
      .slice()
      .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
    const domains = [...new Set(entryActions.map((x) => x.domain).filter((d) => d && d !== "review"))];
    const actionTypes = [...new Set(entryActions.map((x) => x.actionType))];
    const entry = {
      id: ing.id,
      rawText: ing.raw_text || "",
      sourceType: ing.source_type || "text",
      captureMode: ing.capture_mode || "auto",
      status: ing.status || "",
      occurredAt: ing.occurred_at || "",
      createdAt: ing.created_at || "",
      runs: entryRuns,
      actions: entryActions,
      model: entryRuns[0]?.model || "",
      provider: entryRuns[0]?.provider || "",
      costUsd: entryRuns.reduce((s, r) => s + r.costUsd, 0),
      latencyMs: entryRuns.reduce((s, r) => s + r.latencyMs, 0),
      toolCount: entryActions.length,
      appliedCount: entryActions.filter((x) => actionOutcome(x.status) === "applied").length,
      rejectedCount: entryActions.filter((x) => actionOutcome(x.status) === "rejected").length,
      reviewCount: entryActions.filter((x) => actionOutcome(x.status) === "review").length,
      domains,
      actionTypes,
    };
    entry.outcome = entryOutcome(entry);
    return entry;
  });
}

// Aggregate stats across all visible entries — drives the header strip.
export function auditTotals(entries = []) {
  const byDomain = {};
  let toolCalls = 0, applied = 0, rejected = 0, review = 0, costUsd = 0;
  for (const e of entries) {
    toolCalls += e.toolCount;
    applied += e.appliedCount;
    rejected += e.rejectedCount;
    review += e.reviewCount;
    costUsd += e.costUsd;
    for (const d of e.domains) byDomain[d] = (byDomain[d] || 0) + 1;
  }
  return { queries: entries.length, toolCalls, applied, rejected, review, costUsd, byDomain };
}

// A one-line plain-text summary of what the AI did with a capture — used as the
// entry subtitle and asserted directly in tests.
export function summarizeIngestion(entry) {
  if (!entry) return "";
  if (entry.outcome === "queued") return "queued — agent offline, nothing processed yet";
  if (entry.outcome === "errored" && !entry.toolCount) {
    return `errored${entry.model ? ` · ${entry.model}` : ""}`;
  }
  const parts = [];
  parts.push(entry.toolCount === 1 ? "1 tool call" : `${entry.toolCount} tool calls`);
  if (entry.appliedCount) parts.push(`${entry.appliedCount} applied`);
  if (entry.reviewCount) parts.push(`${entry.reviewCount} to review`);
  if (entry.rejectedCount) parts.push(`${entry.rejectedCount} rejected`);
  if (entry.domains.length) parts.push(entry.domains.join(", "));
  if (entry.model) parts.push(entry.model);
  if (entry.costUsd > 0) parts.push(formatCost(entry.costUsd));
  if (entry.latencyMs > 0) parts.push(`${Math.round(entry.latencyMs)}ms`);
  return parts.join(" · ");
}

export function formatCost(usd) {
  const n = Number(usd) || 0;
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}

// Filter for the page controls. `domain` "all" | money|diet|gym|wellness|…;
// `outcome` "all" | applied|review|rejected|queued|errored|no_action;
// `query` substring match on the raw text (case-insensitive). Pure.
export function filterAuditEntries(entries = [], { domain = "all", outcome = "all", action = "all", query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return entries.filter((e) => {
    if (domain !== "all" && !e.domains.includes(domain)) return false;
    if (outcome !== "all" && e.outcome !== outcome) return false;
    if (action !== "all" && !(e.actionTypes || []).includes(action)) return false;
    if (q && !String(e.rawText).toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---- presentation helpers (pure string builders, DOM-free) ----

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const OUTCOME_LABEL = {
  applied: "applied", review: "needs review", rejected: "rejected",
  queued: "queued", errored: "errored", no_action: "no action",
};

// Group entries under local YYYY-MM-DD date headers (newest day first). Entries
// must already be newest-first. Pure.
export function groupByDay(entries = []) {
  const groups = [];
  let current = null;
  for (const e of entries) {
    const day = String(e.createdAt).slice(0, 10) || "unknown";
    if (!current || current.day !== day) {
      current = { day, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return groups;
}

// Renders the full input -> AI output -> action chain per capture: the raw text
// (input), then each tool call with its decided arguments (AI output) and where
// it landed (action: → table / rejected / needs review).
export function auditEntryHtml(entry) {
  const time = String(entry.createdAt).slice(11, 16);
  const actionsHtml = entry.actions.map((a) => {
    const oc = actionOutcome(a.status);
    const pct = a.confidence ? `${Math.round(a.confidence * 100)}%` : "";
    const target = a.appliedTable
      ? `→ ${a.appliedTable.replace(/_/g, " ")}`
      : (OUTCOME_LABEL[oc] || a.status);
    return `<li class="audit-action audit-${oc}">`
      + `<code>${esc(a.tool)}</code>`
      + `<span class="audit-args">${esc(a.argsSummary || "")}</span>`
      + `<span class="audit-action-meta">${pct ? `${pct} · ` : ""}${esc(target)}</span>`
      + `</li>`;
  }).join("");
  return `<article class="audit-entry audit-${esc(entry.outcome)}" data-id="${esc(entry.id)}">`
    + `<header class="audit-entry-head">`
    + `<span class="audit-time">${esc(time)}</span>`
    + `<span class="audit-badge audit-${esc(entry.outcome)}">${esc(OUTCOME_LABEL[entry.outcome] || entry.outcome)}</span>`
    + `<span class="audit-source">${esc(entry.sourceType)}</span>`
    + `</header>`
    + `<p class="audit-raw"><span class="audit-io-tag">input</span> ${esc(entry.rawText) || "<em>(no text — media capture)</em>"}</p>`
    + (actionsHtml ? `<ul class="audit-actions">${actionsHtml}</ul>` : `<p class="audit-summary muted small">${esc(summarizeIngestion(entry))}</p>`)
    + `</article>`;
}

export function auditTotalsHtml(totals) {
  const dom = Object.entries(totals.byDomain).map(([d, n]) => `${d} ${n}`).join(" · ") || "—";
  return `<div class="audit-totals">`
    + `<span><strong>${totals.queries}</strong> queries</span>`
    + `<span><strong>${totals.toolCalls}</strong> tool calls</span>`
    + `<span><strong>${totals.applied}</strong> applied</span>`
    + `<span><strong>${totals.review}</strong> to review</span>`
    + `<span><strong>${totals.rejected}</strong> rejected</span>`
    + `<span>${esc(formatCost(totals.costUsd))} spent</span>`
    + `<span class="muted">${esc(dom)}</span>`
    + `</div>`;
}

// Render the full audit log into a host element. `entries` should be the
// already-filtered, newest-first list from buildAuditEntries + filterAuditEntries.
export function renderAuditLog(host, entries = []) {
  if (!host) return;
  if (!entries.length) {
    host.innerHTML = `<p class="muted">No captures in this window.</p>`;
    return;
  }
  const groups = groupByDay(entries);
  host.innerHTML = groups.map((g) =>
    `<section class="audit-day"><h3 class="audit-day-head">${esc(g.day)}</h3>`
    + g.entries.map(auditEntryHtml).join("")
    + `</section>`,
  ).join("");
}
