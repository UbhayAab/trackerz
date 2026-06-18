// Client-side data export. Fetches the user's rows and downloads CSV/JSON in
// the browser — no server round-trip. Gives users real ownership of their data.
import { fetchLedger, fetchFoodLogs, fetchBodyMetrics, fetchWellnessLogs } from "./supabase-data.js";
import { toCsv } from "../utils/csv.js";

const DATASETS = {
  ledger: {
    fetch: () => fetchLedger({ limit: 5000 }),
    columns: ["occurred_at", "direction", "merchant", "description", "amount", "currency", "payment_mode", "is_discretionary", "tags"],
  },
  food_logs: {
    fetch: () => fetchFoodLogs({ limit: 5000 }),
    columns: ["occurred_at", "meal_slot", "meal_name", "description", "calories_estimate", "protein_g", "carbs_g", "fat_g"],
  },
  body_metrics: {
    fetch: () => fetchBodyMetrics({ limit: 5000 }),
    columns: ["occurred_at", "metric_type", "value", "unit"],
  },
  wellness_logs: {
    fetch: () => fetchWellnessLogs({ limit: 5000 }),
    columns: ["occurred_at", "note", "mood_score", "energy_score", "stress_score"],
  },
};

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportCsv(dataset) {
  const def = DATASETS[dataset];
  if (!def) throw new Error(`unknown dataset ${dataset}`);
  const rows = await def.fetch();
  download(`trackerz-${dataset}-${stamp()}.csv`, toCsv(rows, def.columns), "text/csv;charset=utf-8");
  return rows.length;
}

export async function exportAllJson() {
  const [ledger, food_logs, body_metrics, wellness_logs] = await Promise.all([
    DATASETS.ledger.fetch(),
    DATASETS.food_logs.fetch(),
    DATASETS.body_metrics.fetch(),
    DATASETS.wellness_logs.fetch(),
  ]);
  const payload = { exported_at: new Date().toISOString(), ledger, food_logs, body_metrics, wellness_logs };
  download(`trackerz-export-${stamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
  return ledger.length + food_logs.length + body_metrics.length + wellness_logs.length;
}
