import { insights as seedInsights } from "../data/dashboard-data.js";
import { budgetRows, importRows, ledgerRows, macroRows, reviewRows } from "../data/table-data.js";

const listeners = new Set();

const initialState = {
  selectedNav: "capture",
  activeJob: null,
  parseLog: ["Ready. Drop text, screenshots, voice notes, or bank files."],
  reviewRows: withIds(reviewRows, "review"),
  importRows: withIds(importRows, "import"),
  ledgerRows: withIds(ledgerRows, "ledger"),
  budgetRows: withIds(budgetRows, "budget"),
  macroRows: withIds(macroRows, "macro"),
  insights: [...seedInsights],
  metrics: {
    todaySpend: 1430,
    budgetPace: 1100,
    protein: 86,
    proteinTarget: 130,
    habitScore: 74,
    habitNote: "Sleep drag detected",
  },
};

const state = loadState() || structuredClone(initialState);

function withIds(rows, prefix) {
  return rows.map((row, index) => ({ id: `${prefix}_${index + 1}`, ...row }));
}

export function getState() {
  return structuredClone(state);
}

export function updateState(mutator) {
  mutator(state);
  saveState(state);
  for (const listener of listeners) listener(getState());
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(getState());
  return () => listeners.delete(listener);
}

export function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
}

function loadState() {
  try {
    if (!globalThis.localStorage) return null;
    const raw = globalThis.localStorage.getItem("trackerz_state");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(value) {
  try {
    if (!globalThis.localStorage) return;
    globalThis.localStorage.setItem("trackerz_state", JSON.stringify(value));
  } catch {
    // Persistence is a convenience for the static prototype.
  }
}
