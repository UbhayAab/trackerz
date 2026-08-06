// DIFF CARD - "here is what this will change" at 320 px, before it changes.
//
// This is the surface the confirm gate hands its work to. Without it, making
// grounding load-bearing just routes writes into a queue nobody looks at (which
// is the silent-loss failure this codebase keeps rediscovering); with it, a
// consequential write has somewhere to be seen and one tap to accept or drop.
//
// Design rules, each of them a thing that does not work on a phone:
//
// * NEVER a <table>. Three columns of label / old / new is 380 px minimum before
//   it starts wrapping mid-number. Every change is a two-line stack instead: the
//   label, then `old -> new` with the old struck through and dimmed.
// * LEAD WITH THE AGGREGATE. When a plan changes, what matters is that the day
//   went from 2100 kcal to 1850 - the meal-by-meal list is the supporting
//   evidence for that sentence, not the headline. The old ordering buried the
//   number the decision actually turns on under six unchanged meals.
// * MAX 5 rows, then "+N more". A card taller than the screen has no visible
//   footer, and a confirm button you have to scroll to find is not a confirm.
// * `+ - ~` only, and only changed lines. An unchanged line is noise that pushes
//   the changed one off screen.
// * Sticky footer, both buttons >= 44 px, one tap each. No "are you sure".
//
// The SAME diffRowsFor() feeds the preview and the applied write - planChangePreview()
// below computes the `after` document ONCE and hands the identical object to both,
// so what was approved and what lands cannot disagree. That is exactly the
// discipline ingestStatements() enforces for bank statement imports.

import { applyPlanDelta, isPlanDelta } from "../../lib/plan-merge.mjs";

const AGGREGATES = [
  { key: "calories", label: "Calories", unit: " kcal" },
  { key: "protein_g", label: "Protein", unit: " g" },
];

const LIST_KEYS = ["meals", "items"];

// Fields worth naming when they change. Anything not here still diffs, it just
// sorts after these.
const FIELD_LABELS = {
  "targets.calories": "Calorie target",
  "targets.protein_g": "Protein target",
  "targets.carbs_g": "Carb target",
  "targets.fat_g": "Fat target",
  "targets.fiber_g": "Fibre target",
  "targets.water_ml": "Water target",
  name: "Workout",
  kind: "Kind",
  duration_min: "Duration",
  rules: "Rules",
  summary: "Summary",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value, unit = "") {
  if (value == null || value === "") return "-";
  if (typeof value === "number") return `${Math.round(value * 100) / 100}${unit}`;
  return `${value}${unit}`;
}

// The day's totals. Read from the meal list when there is one, because that is
// what an add/drop/swap actually moves; `targets` are a separate, explicit thing
// and get their own rows.
function aggregateOf(doc, key) {
  if (Array.isArray(doc?.meals)) {
    return doc.meals.reduce((t, m) => t + num(m?.[key] ?? m?.[`${key}_estimate`]), 0);
  }
  if (doc?.targets && typeof doc.targets === "object") return num(doc.targets[key]);
  return 0;
}

function mealKey(m) {
  return String(m?.name || m?.meal_name || "").trim().toLowerCase();
}

function mealLabel(m) {
  return String(m?.name || m?.meal_name || "Meal");
}

function mealSummary(m) {
  const bits = [];
  if (m?.slot) bits.push(m.slot);
  if (num(m?.calories ?? m?.calories_estimate)) bits.push(`${Math.round(num(m.calories ?? m.calories_estimate))} kcal`);
  if (num(m?.protein_g)) bits.push(`${Math.round(num(m.protein_g))}g P`);
  return bits.join(" · ") || "no macros";
}

function flattenScalars(doc, prefix = "", out = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  for (const [k, v] of Object.entries(doc)) {
    if (LIST_KEYS.includes(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenScalars(v, `${prefix}${k}.`, out);
    else if (!Array.isArray(v)) out[`${prefix}${k}`] = v;
  }
  return out;
}

// Compute the changed rows between two plan/document objects.
//
// Row shape: { verb: "+"|"-"|"~", key, label, from, to, detail, aggregate }
// Aggregate rows come first and carry aggregate:true so the renderer can lead
// with them without re-deriving which ones they are.
export function diffRowsFor(before, after, { fields = null, aggregates = AGGREGATES } = {}) {
  const rows = [];
  const b = before && typeof before === "object" ? before : {};
  const a = after && typeof after === "object" ? after : {};

  // 1. Aggregates first - the sentence the decision turns on.
  for (const agg of aggregates) {
    const from = aggregateOf(b, agg.key);
    const to = aggregateOf(a, agg.key);
    if (from === to) continue;
    rows.push({
      verb: "~", key: `total.${agg.key}`, label: `${agg.label} (day total)`,
      from: fmt(from, agg.unit), to: fmt(to, agg.unit), aggregate: true,
      delta: to - from,
    });
  }

  // 2. Meals: added / removed / changed, keyed by name so a reordered list is not
  //    reported as six changes.
  const bMeals = Array.isArray(b.meals) ? b.meals : [];
  const aMeals = Array.isArray(a.meals) ? a.meals : [];
  if (bMeals.length || aMeals.length) {
    const bByKey = new Map(bMeals.map((m) => [mealKey(m), m]));
    const aByKey = new Map(aMeals.map((m) => [mealKey(m), m]));
    for (const [key, m] of aByKey) {
      if (!bByKey.has(key)) rows.push({ verb: "+", key: `meal.${key}`, label: mealLabel(m), from: "", to: mealSummary(m) });
    }
    for (const [key, m] of bByKey) {
      if (!aByKey.has(key)) rows.push({ verb: "-", key: `meal.${key}`, label: mealLabel(m), from: mealSummary(m), to: "" });
    }
    for (const [key, m] of aByKey) {
      const prev = bByKey.get(key);
      if (!prev) continue;
      const from = mealSummary(prev);
      const to = mealSummary(m);
      if (from !== to) rows.push({ verb: "~", key: `meal.${key}`, label: mealLabel(m), from, to });
    }
  }

  // 3. Gym items (plain strings).
  const bItems = Array.isArray(b.items) ? b.items.map(String) : [];
  const aItems = Array.isArray(a.items) ? a.items.map(String) : [];
  for (const it of aItems) if (!bItems.includes(it)) rows.push({ verb: "+", key: `item.${it}`, label: it, from: "", to: "added" });
  for (const it of bItems) if (!aItems.includes(it)) rows.push({ verb: "-", key: `item.${it}`, label: it, from: "removed", to: "" });

  // 4. Named scalars (targets, workout name, duration...).
  const bFlat = flattenScalars(b);
  const aFlat = flattenScalars(a);
  const keys = fields && fields.length ? fields : [...new Set([...Object.keys(bFlat), ...Object.keys(aFlat)])];
  for (const key of keys) {
    const from = bFlat[key];
    const to = aFlat[key];
    if (from === to) continue;
    if (from == null && to == null) continue;
    const verb = from == null || from === "" ? "+" : (to == null || to === "" ? "-" : "~");
    rows.push({ verb, key, label: FIELD_LABELS[key] || key.replace(/^targets\./, "").replace(/_/g, " "), from: fmt(from), to: fmt(to) });
  }

  return rows;
}

// One function produces the document that is PREVIEWED and the document that is
// WRITTEN. Callers must not fold the delta a second time on the write path - that
// is how a preview and a write drift apart.
export function planChangePreview(kind, base, payload) {
  if (!isPlanDelta(payload)) {
    const after = payload && typeof payload === "object" ? payload : {};
    return { before: base, after, rows: diffRowsFor(base, after), applied: true, matched_count: null, reason: null };
  }
  const result = applyPlanDelta(kind, base, payload);
  const after = result && result.plan ? result.plan : result;
  return {
    before: base,
    after,
    rows: diffRowsFor(base, after),
    applied: result?.applied !== false,
    matched_count: result?.matched_count ?? null,
    reason: result?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// AMENDING A ROW THAT ALREADY EXISTS.
//
// Same card, same rules, one different input: a plan from lib/amend-target.mjs
// instead of a plan document. The plan carries `before` and `values` for exactly
// the columns the write will touch, so these rows cannot describe a change the
// write will not make - there is nothing here to recompute.
//
// LEAD WITH THE AGGREGATE still holds and matters more here than for a plan: the
// decision on "actually it was 50 g not 30 g" turns on the day going from 205 to
// 430 kcal, not on the word "30" becoming the word "50". `plan.headline` is the
// figure amend-target already picked for that kind, so the ordering is decided
// once, next to the column rules, rather than guessed by the renderer.
// ---------------------------------------------------------------------------

const AMEND_COLUMN_LABELS = {
  calories_estimate: { label: "Calories", unit: " kcal" },
  protein_g: { label: "Protein", unit: " g" },
  carbs_g: { label: "Carbs", unit: " g" },
  fat_g: { label: "Fat", unit: " g" },
  description: { label: "What", unit: "" },
  meal_name: { label: "Meal name", unit: "" },
  meal_slot: { label: "Meal", unit: "" },
  amount: { label: "Amount", unit: "" },
  merchant: { label: "Merchant", unit: "" },
  payment_mode: { label: "Paid by", unit: "" },
  is_discretionary: { label: "Discretionary", unit: "" },
  duration_min: { label: "Duration", unit: " min" },
  intensity: { label: "Intensity", unit: "" },
  status: { label: "Status", unit: "" },
  ml: { label: "Water", unit: " ml" },
  quality: { label: "Sleep quality", unit: "/5" },
  started_at: { label: "Slept from", unit: "" },
  ended_at: { label: "Woke at", unit: "" },
  value: { label: "Value", unit: "" },
  unit: { label: "Unit", unit: "" },
  metric_type: { label: "Metric", unit: "" },
  note: { label: "Note", unit: "" },
  body: { label: "Note", unit: "" },
  mood_score: { label: "Mood", unit: "/10" },
  energy_score: { label: "Energy", unit: "/10" },
  stress_score: { label: "Stress", unit: "/10" },
  occurred_at: { label: "When", unit: "" },
  due_on: { label: "Due", unit: "" },
  deleted_at: { label: "Deleted", unit: "" },
};

function amendLabel(column) {
  return AMEND_COLUMN_LABELS[column] || { label: String(column).replace(/_/g, " "), unit: "" };
}

// Numerics arrive as a JS number from PostgREST and as a string ("7.00") from
// node-postgres. Rendering "7.00 -> 7" as a change would be a lie about the write.
function amendSame(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
  return String(a).trim() === String(b).trim();
}

/**
 * Rows for one amendment plan, aggregates first.
 *
 * @param {{op, table, id, kind, before, values, columns, headline}} plan
 *   Straight from amendWritePlan(). Nothing else is accepted, because anything
 *   else would be a second opinion about what the write does.
 */
export function amendDiffRows(plan) {
  const p = plan && typeof plan === "object" ? plan : {};
  const rows = [];
  if (p.op === "soft_delete") {
    // A delete has no column diff worth showing - the change is the whole row.
    // Lead with the figures it takes OUT of the day, because that is the number
    // the user is deciding about.
    for (const h of p.headline || []) {
      const meta = amendLabel(h.column);
      rows.push({
        verb: "-", key: `del.${h.column}`, label: meta.label,
        from: fmt(h.from, meta.unit), to: "0", aggregate: true, delta: -num(h.from),
      });
    }
    rows.push({ verb: "-", key: "row", label: "This entry", from: "kept", to: "" });
    return rows;
  }

  const before = p.before || {};
  const after = p.values || {};
  const columns = Array.isArray(p.columns) ? p.columns : Object.keys(after);

  // 1. The aggregate the decision turns on.
  const headlineCols = new Set();
  for (const h of p.headline || []) {
    if (!h.changed) continue;
    headlineCols.add(h.column);
    const meta = amendLabel(h.column);
    rows.push({
      verb: "~", key: `total.${h.column}`, label: meta.label,
      from: fmt(h.from, meta.unit), to: fmt(h.to, meta.unit),
      aggregate: true, delta: num(h.to) - num(h.from),
    });
  }

  // 2. Every other column the write will actually touch. Unchanged columns are
  //    not in `columns` at all - amendWritePlan drops the no-ops - so there is
  //    nothing here to filter for noise.
  for (const col of columns) {
    if (headlineCols.has(col)) continue;
    if (amendSame(before[col], after[col])) continue;
    const meta = amendLabel(col);
    const from = before[col];
    const to = after[col];
    const verb = from == null || from === "" ? "+" : (to == null || to === "" ? "-" : "~");
    rows.push({ verb, key: col, label: meta.label, from: fmt(from, meta.unit), to: fmt(to, meta.unit) });
  }
  return rows;
}

/**
 * The card for an amendment. Confirm label says what will happen to WHICH row.
 */
export function renderAmendCard(plan, { title = null, summary = "", id = "amendCard" } = {}) {
  const p = plan && typeof plan === "object" ? plan : {};
  const deleting = p.op === "soft_delete";
  return renderDiffCard(amendDiffRows(p), {
    title: title || (deleting ? "Delete this entry?" : "Change this entry?"),
    summary,
    confirmLabel: deleting ? "Delete it" : "Change it",
    cancelLabel: "Leave it",
    id,
  });
}

/**
 * AMBIGUITY RENDERS A CHOOSER, NOT A GUESS.
 *
 * Three buttons maximum, each NAMING the row it would change ("50g aloo bhujia,
 * 15:14 today"). A fourth button is a list, and a list on a phone is a thing
 * people dismiss - and dismissing this one means the correction is lost, which is
 * why the resolver's answer is a question rather than a best guess in the first
 * place.
 *
 * `labels` are produced by describeAmendCandidate() in lib/amend-target.mjs, so
 * the words on the button come from the same place the row did.
 */
export function renderAmendChooser(labels = [], {
  question = "Which one did you mean?",
  id = "amendChooser",
} = {}) {
  const list = (Array.isArray(labels) ? labels : []).slice(0, 3);
  if (!list.length) {
    return `<section class="command-panel diff-card" id="${esc(id)}" data-amend-choices="0">
      <p class="small muted">I could not find that entry.</p>
    </section>`;
  }
  return `<section class="command-panel diff-card" id="${esc(id)}" data-amend-choices="${list.length}">
    <p class="diff-title" style="font-weight:600;margin:0 0 8px">${esc(question)}</p>
    <div class="diff-rows" style="display:grid;gap:6px">
      ${list.map((label, i) => `<button class="secondary-button" type="button" data-amend-choice="${i}" style="min-height:44px;text-align:left">${esc(label)}</button>`).join("")}
    </div>
    <div class="diff-actions" style="position:sticky;bottom:0;display:grid;grid-template-columns:1fr;gap:8px;padding-top:10px;background:var(--panel)">
      <button class="ghost-button" type="button" data-diff-act="cancel" style="min-height:44px">None of these</button>
    </div>
  </section>`;
}

const VERB_CLASS = { "+": "diff-add", "-": "diff-del", "~": "diff-mod" };

function rowHtml(row) {
  const cls = VERB_CLASS[row.verb] || "diff-mod";
  const change = row.verb === "+"
    ? `<span class="diff-new">${esc(row.to)}</span>`
    : row.verb === "-"
      ? `<s class="diff-old" style="opacity:.55">${esc(row.from)}</s>`
      : `<s class="diff-old" style="opacity:.55">${esc(row.from)}</s> <span aria-hidden="true">→</span> <span class="diff-new">${esc(row.to)}</span>`;
  return `<div class="settings-row diff-row ${cls}${row.aggregate ? " diff-aggregate" : ""}" style="flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px">
      <span class="diff-label small" style="opacity:.75"><span class="diff-verb" aria-hidden="true">${row.verb}</span> ${esc(row.label)}</span>
      <span class="diff-change">${change}</span>
    </div>`;
}

// Render the card. `rows` comes straight from diffRowsFor(); nothing is recomputed
// here, so the card cannot show a number the write will not make.
export function renderDiffCard(rows = [], {
  title = "Confirm this change",
  summary = "",
  confirmLabel = "Apply",
  cancelLabel = "Discard",
  maxRows = 5,
  id = "diffCard",
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return `<section class="command-panel diff-card" id="${esc(id)}" data-diff-empty="1">
      <p class="small muted">Nothing would change.</p>
      <div class="diff-actions" style="position:sticky;bottom:0;display:grid;grid-template-columns:1fr;gap:8px;padding-top:10px;background:var(--panel)">
        <button class="secondary-button" type="button" data-diff-act="cancel" style="min-height:44px">Close</button>
      </div>
    </section>`;
  }
  const head = list.slice(0, maxRows);
  const rest = list.slice(maxRows);
  return `<section class="command-panel diff-card" id="${esc(id)}" data-diff-count="${list.length}">
    <p class="diff-title" style="font-weight:600;margin:0 0 2px">${esc(title)}</p>
    ${summary ? `<p class="small muted" style="margin:0 0 10px">${esc(summary)}</p>` : ""}
    <div class="diff-rows" style="display:grid;gap:6px">
      ${head.map(rowHtml).join("")}
      ${rest.length ? `<div class="diff-more" hidden style="display:grid;gap:6px">${rest.map(rowHtml).join("")}</div>
      <button class="ghost-button diff-expand" type="button" data-diff-act="expand" style="min-height:44px">+${rest.length} more</button>` : ""}
    </div>
    <div class="diff-actions" style="position:sticky;bottom:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:10px;background:var(--panel)">
      <button class="secondary-button" type="button" data-diff-act="cancel" style="min-height:44px">${esc(cancelLabel)}</button>
      <button class="primary-button" type="button" data-diff-act="confirm" style="min-height:44px">${esc(confirmLabel)}</button>
    </div>
  </section>`;
}

// Wire one card. `onConfirm` / `onCancel` are called at most ONCE each: the
// buttons disable themselves on the first tap, because a double tap on a confirm
// is how one plan change becomes two rows.
export function bindDiffCard(root, { onConfirm, onCancel, onChoose } = {}) {
  if (!root || typeof root.addEventListener !== "function") return () => {};
  let settled = false;
  const handler = (event) => {
    // The ambiguity chooser. Same one-tap-only rule as confirm: a double tap on
    // "which one did you mean" would resolve twice and amend two rows.
    const choice = event.target?.closest?.("[data-amend-choice]");
    if (choice) {
      if (settled) return;
      settled = true;
      root.querySelectorAll("[data-amend-choice],[data-diff-act]").forEach((b) => { b.disabled = true; });
      onChoose?.(Number(choice.getAttribute("data-amend-choice")));
      return;
    }
    const btn = event.target?.closest?.("[data-diff-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-diff-act");
    if (act === "expand") {
      const more = root.querySelector(".diff-more");
      if (more) more.hidden = false;
      btn.remove();
      return;
    }
    if (settled) return;
    settled = true;
    root.querySelectorAll("[data-diff-act]").forEach((b) => { b.disabled = true; });
    if (act === "confirm") onConfirm?.();
    else if (act === "cancel") onCancel?.();
  };
  root.addEventListener("click", handler);
  return () => root.removeEventListener("click", handler);
}

export default renderDiffCard;
