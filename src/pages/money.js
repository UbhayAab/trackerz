import { bindOperationalTables, renderOperationalTables } from "../ui/operational-tables.js";
import { bindBudgetInputs, renderBudgetInputs } from "../ui/budget-inputs.js";
import { renderNav } from "../ui/navigation.js";
import { showToast } from "../ui/toast.js";
import { getState, subscribe } from "../state/app-state.js";
import { bootWithAuth } from "./bootstrap.js";
import { hydrateStateFromSupabase } from "../state/sync.js";
import { bindStatementImporter } from "../ui/statement-importer.js";
import { fetchLedger, fetchOpenImports, fetchBudgets, fetchOpenAiActions } from "../services/supabase-data.js";
import { isLocalSession } from "../services/auth.js";
import { inr } from "../utils/formatters.js";
import { periodWindow } from "../analytics/budget-trajectory.js";
import {
  periodRange, periodLabel, periodShortLabel, stepAnchor, containsToday,
  ledgerCoverage, sumExpenses, inRange, startOfDay, PERIOD_UNIT,
} from "../../lib/money-period.mjs";

const DASH = "-";
// Mirrors the page sizes sync.js hydrates with. A full page means the counts
// below are a floor, not a total - so we say so instead of quoting a wrong one.
const LEDGER_LIMIT = 500;
const IMPORT_LIMIT = 20;
// Stepping back past the hydrated page has to fetch more rows, or the older
// period would render as an empty one. One deeper page is enough for years of
// this user's volume; beyond it we say the window isn't loaded rather than
// pretend it was empty.
const DEEP_LEDGER_LIMIT = 4000;

let loaded = false;   // has THIS page load actually read the data yet?
let loadErrors = {};  // table key -> message, for reads that failed

// --- selected period ---------------------------------------------------------
// Defaults to the current month, which is what the page used to show
// unconditionally. `_anchor` is any day inside the shown period; periodWindow
// expands it to the real boundaries (ISO Monday for weeks).
let _period = "monthly";
let _anchor = startOfDay(new Date());

// Rows from the deeper on-demand fetch, used only when the hydrated page
// doesn't reach back to the selected period.
let _deepLedger = null;
let _deepLimit = 0;
let _deepError = null;   // a failed deeper read - must never look like an empty period
let _deepening = false;

bootWithAuth(async () => {
  renderNav("money");
  subscribe(paint);
  bindOperationalTables();
  bindBudgetInputs("moneyBudgetStatus");
  bindStatementImporter();
  bindPeriodBar();

  await hydrateStateFromSupabase();
  loaded = true;
  loadErrors = await detectLoadErrors();
  reportLoadErrors();
  paint(getState());
});

function paint(state) {
  const view = buildPeriodView(state);
  renderPeriodBar(view);
  renderOperationalTables(state, {
    errors: { ...activeErrors(state), ledger: view.ledgerError },
    loading: !loaded,
    rows: { ledger: view.ledgerRows },
    emptyMessages: { ledger: view.ledgerEmptyMessage },
  });
  renderBudgetInputs(state);
  renderMoneySummary(state, view);

  // The selected window reaches past what we hold - go get the rest rather than
  // report a total that silently excludes it.
  if (view.coverage === "partial" || view.coverage === "none") deepenLedger();
}

// --- the period view ---------------------------------------------------------
// Everything the page renders about money is derived here, from ONE window, so
// a tile and the table underneath it can never describe different days.
function buildPeriodView(state) {
  const win = periodWindow(_period, _anchor);
  const range = periodRange(win);
  const today = new Date();
  const unit = PERIOD_UNIT[_period] || "period";
  const view = {
    range,
    label: periodLabel(_period, range, today),
    shortLabel: periodShortLabel(_period, range, today),
    isCurrent: containsToday(range, today),
    unit,
  };

  const source = ledgerSource(state);

  // A hydrate-time ledger read failure blanks every window: we can't say what
  // any period held. It outranks everything below.
  if (!loaded || loadErrors.ledger || !Array.isArray(source.rows)) {
    view.ledgerError = loadErrors.ledger || null;
    view.coverage = "unknown";
    view.ledgerRows = [];
    view.ledgerEmptyMessage = view.ledgerError ? "Not loaded - see the error above." : "Loading…";
    view.spendLabel = DASH;
    view.rowsLabel = DASH;
    view.note = null;
    return view;
  }

  view.ledgerError = null;
  view.coverage = ledgerCoverage(source.rows, range, { limit: source.limit });
  const { total, count } = sumExpenses(source.rows, range);

  if (view.coverage === "none") {
    // We hold nothing from this window. A deeper fetch might, but if that fetch
    // FAILED this is a read failure for this window, not an empty one - say so.
    if (_deepError) {
      view.ledgerError = _deepError;
      view.ledgerRows = [];
      view.ledgerEmptyMessage = "Not loaded - see the error above.";
      view.spendLabel = DASH;
      view.rowsLabel = DASH;
      view.note = null;
      return view;
    }
    // Rs 0 here would be an invention - we simply haven't fetched this far back.
    view.ledgerRows = [];
    view.ledgerEmptyMessage = `Not loaded - this ${unit} is older than the entries fetched so far.`;
    view.spendLabel = DASH;
    view.rowsLabel = DASH;
    view.note = `No data fetched for ${view.shortLabel}. This is a gap in what was loaded, not a ${unit} with no spending.`;
    return view;
  }

  view.ledgerRows = source.rows.filter((row) => inRange(range, row.occurred_at)).map(displayRow);

  if (view.coverage === "partial") {
    // Part of the window predates our oldest row, so every figure is a floor.
    view.spendLabel = `${inr(total)}+`;
    view.rowsLabel = `${count}+`;
    view.ledgerEmptyMessage = `Only part of this ${unit} is loaded.`;
    view.note = `Only part of ${view.shortLabel} is loaded - totals are a floor, not the full ${unit}.`;
    return view;
  }

  // Fully covered and genuinely empty: say so in words. "Rs 0" reads as a
  // measured zero and is indistinguishable from a failed read at a glance.
  view.spendLabel = count ? inr(total) : "Nothing spent";
  view.rowsLabel = String(count);
  view.ledgerEmptyMessage = `Nothing spent this ${unit} - no expenses recorded for ${view.shortLabel}.`;
  view.note = null;
  return view;
}

// The hydrated snapshot until a deeper fetch replaces it. `limit` travels with
// the rows because coverage depends on which cap produced them.
function ledgerSource(state) {
  const hydrated = Array.isArray(state.ledger) ? state.ledger : null;
  // A fresh hydrate (new capture, import) makes the deep cache stale - drop it
  // and let the next paint re-fetch rather than render rows that are behind.
  if (_deepLedger && hydrated && hydrated[0]?.id !== _deepLedger[0]?.id) {
    _deepLedger = null;
    _deepLimit = 0;
  }
  if (_deepLedger) return { rows: _deepLedger, limit: _deepLimit };
  return { rows: hydrated, limit: LEDGER_LIMIT };
}

// The page renders rows the shared hydrate never fetched (older periods), so it
// formats raw ledger entries itself instead of reusing state.ledgerRows.
function displayRow(row) {
  return {
    id: row.id,
    date: shortDate(row.occurred_at),
    merchant: row.merchant || DASH,
    category: row.is_discretionary ? "Discretionary" : "Essential",
    amount: fmtAmount(row.amount, row.currency),
    evidence: row.direction,
    state: row.duplicate_state === "unique" ? "AI applied" : row.duplicate_state,
  };
}

function fmtAmount(amount, currency = "INR") {
  if (currency && currency !== "INR") return `${currency} ${Number(amount).toLocaleString("en-IN")}`;
  return inr(amount);
}

function shortDate(iso) {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// --- deeper ledger fetch -----------------------------------------------------
async function deepenLedger() {
  if (isLocalSession()) return;          // nothing to page deeper into
  if (_deepening || _deepLimit >= DEEP_LEDGER_LIMIT) return;
  _deepening = true;
  try {
    const rows = await fetchLedger({ limit: DEEP_LEDGER_LIMIT });
    _deepLedger = rows;
    _deepLimit = DEEP_LEDGER_LIMIT;
    _deepError = null;
  } catch (err) {
    // Surfaced, never swallowed: without this the older period would fall back
    // to the short page and look like a quiet month.
    _deepError = messageOf(err);
    showToast(`Couldn't load older ledger rows - ${_deepError}`, { kind: "error", duration: 6000 });
  } finally {
    _deepening = false;
  }
  paint(getState());
}

// --- period controls ---------------------------------------------------------
function renderPeriodBar(view) {
  document.querySelectorAll("[data-money-period]").forEach((button) => {
    const active = button.dataset.moneyPeriod === _period;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  setText("#moneyPeriodLabel", view.label);
  setText("#ledgerPanelTitle", view.label);

  const next = document.querySelector("[data-money-step='1']");
  if (next) next.disabled = view.isCurrent;   // there is no data from the future
  const todayButton = document.querySelector("[data-money-today]");
  if (todayButton) todayButton.hidden = view.isCurrent;

  const input = document.querySelector("#moneyPeriodDate");
  if (input) {
    input.value = isoDay(_anchor);
    input.max = isoDay(new Date());
  }

  const note = document.querySelector("#moneyPeriodNote");
  if (note) {
    note.textContent = view.note || "";
    note.hidden = !view.note;
  }
}

function bindPeriodBar() {
  const bar = document.querySelector("#moneyPeriodBar");
  if (!bar) return;

  bar.addEventListener("click", (event) => {
    const periodButton = event.target.closest("[data-money-period]");
    if (periodButton) {
      _period = periodButton.dataset.moneyPeriod;
      // Keep the anchor day; the new period just re-cuts the window around it.
      paint(getState());
      return;
    }
    const stepButton = event.target.closest("[data-money-step]");
    if (stepButton) {
      const delta = Number(stepButton.dataset.moneyStep);
      const next = stepAnchor(_period, _anchor, delta);
      if (delta > 0 && next > startOfDay(new Date())) return;
      _anchor = next;
      paint(getState());
      return;
    }
    if (event.target.closest("[data-money-today]")) {
      _anchor = startOfDay(new Date());
      paint(getState());
    }
  });

  const input = document.querySelector("#moneyPeriodDate");
  if (input) {
    input.addEventListener("change", () => {
      const picked = parseIsoDay(input.value);
      // An unparseable/cleared value must not silently reset the view to today -
      // put the current anchor back so what's on screen still matches the label.
      if (!picked) { input.value = isoDay(_anchor); return; }
      const today = startOfDay(new Date());
      _anchor = picked > today ? today : picked;
      paint(getState());
    });
  }
}

function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Parsed as LOCAL midnight. new Date("2026-07-22") is UTC midnight, which in
// IST is 05:30 the same day - fine here, but it silently shifts the day for
// negative offsets, so the parts are split by hand.
function parseIsoDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date.getTime()) ? date : null;
}

// --- tiles -------------------------------------------------------------------
// Every tile is a measured number, an explicit "nothing spent", or an em-dash.
// A 0 here reads as "you spent nothing" / "you have no rows", so we only print
// one when we actually read the data and it really was empty. Each money tile
// also carries the window it describes, so no figure is ambiguous.
function renderMoneySummary(state, view) {
  const importsOk = loaded && !loadErrors.import;
  const reviewOk = loaded && !loadErrors.review;

  setText("#summaryMoneySpendLabel", `Spend · ${view.shortLabel}`);
  setText("#summaryLedgerRowsLabel", `Ledger rows · ${view.shortLabel}`);
  setTile("#summaryMoneySpend", view.spendLabel);
  setTile("#summaryLedgerRows", view.rowsLabel);
  // Imports and the review queue aren't date-scoped reads, so they stay whole-
  // account and are labelled that way in the markup.
  setTile("#summaryImportRows", importsOk ? countLabel((state.importRows || []).length, IMPORT_LIMIT) : DASH);
  setTile("#summaryMoneyReview", reviewOk ? String(moneyReviewCount(state)) : DASH);
}

function moneyReviewCount(state) {
  return (state.reviewRows || []).filter((row) => row.domain === "Money").length;
}

function countLabel(count, limit) {
  return count >= limit ? `${limit}+` : String(count);
}

// sync.js turns a per-table fetch failure into an empty array, so an outage
// renders as "nothing logged yet". Re-run only the queries that came back empty
// (limit 1) to tell "you have no rows" apart from "we couldn't read your rows".
async function detectLoadErrors() {
  if (isLocalSession()) return {};
  const state = getState();
  if (state.syncError) {
    const message = state.syncError;
    return { ledger: message, import: message, budget: message, review: message };
  }
  const probes = [];
  if (!(state.ledger || []).length) probes.push(["ledger", () => fetchLedger({ limit: 1 })]);
  if (!(state.importRows || []).length) probes.push(["import", () => fetchOpenImports({ limit: 1 })]);
  if (!(state.budgetRows || []).length) probes.push(["budget", () => fetchBudgets()]);
  if (!(state.reviewRows || []).length) probes.push(["review", () => fetchOpenAiActions({ limit: 1 })]);

  const settled = await Promise.allSettled(probes.map(([, run]) => run()));
  const errors = {};
  settled.forEach((result, i) => {
    if (result.status === "rejected") errors[probes[i][0]] = messageOf(result.reason);
  });
  return errors;
}

// A load error only stands while its table is still empty - a later successful
// hydrate (after an import, say) fills the table and retires the message.
function activeErrors(state) {
  const rows = {
    ledger: state.ledger,
    import: state.importRows,
    budget: state.budgetRows,
    review: state.reviewRows,
  };
  const out = {};
  for (const [key, message] of Object.entries(loadErrors)) {
    if (!(rows[key] || []).length) out[key] = message;
  }
  return out;
}

function reportLoadErrors() {
  const keys = Object.keys(loadErrors);
  if (!keys.length) return;
  showToast(`Couldn't load ${keys.join(", ")} - ${loadErrors[keys[0]]}`, { kind: "error", duration: 6000 });
}

function messageOf(err) {
  return err?.message || err?.error_description || String(err || "read failed");
}

function setTile(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
