import { fetchLedger, fetchFoodLogs, fetchOpenAiActions, fetchOpenImports, fetchBudgets } from "../services/supabase-data.js";
import { isLocalSession } from "../services/auth.js";
import { updateState } from "./app-state.js";

const INR = new Intl.NumberFormat("en-IN");

function fmtAmount(amount, currency = "INR") {
  if (currency === "INR") return `Rs ${INR.format(Number(amount))}`;
  return `${currency} ${INR.format(Number(amount))}`;
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export async function hydrateStateFromSupabase() {
  if (isLocalSession()) return;
  try {
    const [ledger, foods, actions, imports, budgets] = await Promise.all([
      fetchLedger().catch(() => []),
      fetchFoodLogs().catch(() => []),
      fetchOpenAiActions().catch(() => []),
      fetchOpenImports().catch(() => []),
      fetchBudgets().catch(() => []),
    ]);

    const ledgerRows = ledger.map((row) => ({
      id: row.id,
      date: shortDate(row.occurred_at),
      merchant: row.merchant || "—",
      category: row.is_discretionary ? "Discretionary" : "Essential",
      amount: fmtAmount(row.amount, row.currency),
      evidence: row.direction,
      state: row.duplicate_state === "unique" ? "AI applied" : row.duplicate_state,
    }));

    const macroRows = foods.map((row) => ({
      id: row.id,
      meal: row.meal_slot || row.meal_name || "Meal",
      calories: String(row.calories_estimate ?? "—"),
      protein: row.protein_g != null ? `${row.protein_g}g` : "—",
      confidence: row.confidence > 0.8 ? "high" : row.confidence > 0.5 ? "medium" : "review",
      note: row.description?.slice(0, 90) || "",
    }));

    const reviewRows = actions.map((row) => ({
      id: row.id,
      item: humanizeTool(row.tool_name, row.arguments),
      domain: domainForTool(row.tool_name),
      confidence: `${Math.round(Number(row.confidence) * 100)}%`,
      risk: row.confidence > 0.85 ? "none" : "review",
      action: "approve / reject",
    }));

    const importRows = imports.map((row) => ({
      id: row.id,
      file: row.source_name || row.detected_bank || "Import",
      rows: String(row.row_count ?? 0),
      mapped: row.status === "mapped" ? "done" : "pending",
      duplicate: "—",
      status: row.status,
    }));

    const budgetRows = budgets.map((row) => ({
      id: row.id,
      category: row.category_id ? "Category" : "All",
      period: row.period,
      amount: fmtAmount(row.amount),
      starts: shortDate(row.starts_on),
      status: "active",
    }));

    const todaySpend = sumTodayExpense(ledger);
    const protein = sumTodayProtein(foods);

    updateState((state) => {
      state.ledgerRows = ledgerRows;
      state.macroRows = macroRows;
      state.reviewRows = reviewRows;
      state.importRows = importRows;
      state.budgetRows = budgetRows;
      state.metrics.todaySpend = todaySpend;
      state.metrics.protein = protein;
    });
  } catch (err) {
    console.warn("hydrateStateFromSupabase failed", err);
  }
}

function humanizeTool(name, args = {}) {
  switch (name) {
    case "create_expense_candidate":
      return `${args.merchant || "expense"} ${args.amount ? `Rs ${args.amount}` : ""}`.trim();
    case "create_food_log_candidate":
      return `${args.meal_slot || "meal"}: ${args.description?.slice(0, 50) || ""}`.trim();
    case "create_body_metric_candidate":
      return `${args.metric_type || "metric"} ${args.value || ""}`.trim();
    case "create_statement_row_candidate":
      return `statement row ${args.description?.slice(0, 50) || ""}`.trim();
    default:
      return name.replace(/_/g, " ");
  }
}

function domainForTool(name) {
  if (name.includes("expense") || name.includes("income") || name.includes("statement") || name.includes("transfer")) return "Money";
  if (name.includes("food")) return "Diet";
  if (name.includes("workout") || name.includes("body") || name.includes("wellness")) return "Wellness";
  return "AI";
}

function isSameLocalDay(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function sumTodayExpense(rows) {
  return rows
    .filter((r) => r.direction === "expense" && isSameLocalDay(r.occurred_at))
    .reduce((acc, r) => acc + Number(r.amount || 0), 0);
}

function sumTodayProtein(rows) {
  return rows
    .filter((r) => isSameLocalDay(r.occurred_at))
    .reduce((acc, r) => acc + Number(r.protein_g || 0), 0);
}
