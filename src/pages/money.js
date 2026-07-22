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

const DASH = "—";
// Mirrors the page sizes sync.js hydrates with. A full page means the counts
// below are a floor, not a total — so we say so instead of quoting a wrong one.
const LEDGER_LIMIT = 500;
const IMPORT_LIMIT = 20;

let loaded = false;   // has THIS page load actually read the data yet?
let loadErrors = {};  // table key -> message, for reads that failed

bootWithAuth(async () => {
  renderNav("money");
  subscribe(paint);
  bindOperationalTables();
  bindBudgetInputs("moneyBudgetStatus");
  bindStatementImporter();

  await hydrateStateFromSupabase();
  loaded = true;
  loadErrors = await detectLoadErrors();
  reportLoadErrors();
  paint(getState());
});

function paint(state) {
  renderOperationalTables(state, { errors: activeErrors(state), loading: !loaded });
  renderBudgetInputs(state);
  renderMoneySummary(state);
}

// Every tile is a measured number or an em-dash. A 0 here reads as "you spent
// nothing" / "you have no rows", so we only print one when we actually read the
// data and it really was empty.
function renderMoneySummary(state) {
  const ledger = Array.isArray(state.ledger) ? state.ledger : null;
  const ledgerOk = loaded && ledger && !loadErrors.ledger;
  const importsOk = loaded && !loadErrors.import;
  const reviewOk = loaded && !loadErrors.review;

  setTile("#summaryMoneySpend", ledgerOk ? monthSpendLabel(ledger) : DASH);
  setTile("#summaryLedgerRows", ledgerOk ? countLabel(ledger.length, LEDGER_LIMIT) : DASH);
  setTile("#summaryImportRows", importsOk ? countLabel((state.importRows || []).length, IMPORT_LIMIT) : DASH);
  setTile("#summaryMoneyReview", reviewOk ? String(moneyReviewCount(state)) : DASH);
}

function monthSpendLabel(ledger) {
  const start = startOfMonth();
  let total = 0;
  for (const row of ledger) {
    if (row.direction !== "expense" || !row.occurred_at) continue;
    if (new Date(row.occurred_at) < start) continue;
    total += Number(row.amount) || 0;
  }
  // Rows arrive newest-first and capped: if the oldest one we hold is still
  // inside this month there is older spend we never fetched, so this is a floor.
  const oldest = ledger[ledger.length - 1];
  const partial = ledger.length >= LEDGER_LIMIT && oldest?.occurred_at && new Date(oldest.occurred_at) >= start;
  return partial ? `${inr(total)}+` : inr(total);
}

function moneyReviewCount(state) {
  return (state.reviewRows || []).filter((row) => row.domain === "Money").length;
}

function countLabel(count, limit) {
  return count >= limit ? `${limit}+` : String(count);
}

function startOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
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

// A load error only stands while its table is still empty — a later successful
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
  showToast(`Couldn't load ${keys.join(", ")} — ${loadErrors[keys[0]]}`, { kind: "error", duration: 6000 });
}

function messageOf(err) {
  return err?.message || err?.error_description || String(err || "read failed");
}

function setTile(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
