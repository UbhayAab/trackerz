import { insights as seedInsights } from "../data/dashboard-data.js";
import { budgetRows, importRows, ledgerRows, macroRows, reviewRows } from "../data/table-data.js";

const STORAGE_KEY = "trackerz_state_v2";
const LEGACY_STORAGE_KEY = "trackerz_state";
const listeners = new Set();

let state = loadState() || createEmptyState();

function withIds(rows, prefix) {
  return rows.map((row, index) => ({ id: `${prefix}_${index + 1}`, ...row }));
}

function createBaseState() {
  return {
    selectedNav: "capture",
    activeJob: null,
    parseLog: ["Fresh workspace. Add your first capture to build the tables."],
    reviewRows: [],
    importRows: [],
    ledgerRows: [],
    budgetRows: [],
    macroRows: [],
    insights: [],
    metrics: {
      todaySpend: 0,
      budgetPace: 0,
      protein: 0,
      proteinTarget: 130,
      caloriesLeft: 2100,
      habitScore: 0,
      habitNote: "No wellness data yet",
      adherence: 0,
    },
  };
}

export function createEmptyState() {
  return createBaseState();
}

export function createDemoState() {
  return {
    ...createBaseState(),
    parseLog: ["Demo data loaded. Clear all when you want a blank test run."],
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
      caloriesLeft: 500,
      habitScore: 74,
      habitNote: "Sleep drag detected",
      adherence: 78,
    },
  };
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

export function resetWorkspace(mode = "empty") {
  state = mode === "demo" ? createDemoState() : createEmptyState();
  saveState(state);
  notify();
}

export function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
}

function notify() {
  for (const listener of listeners) listener(getState());
}

function loadState() {
  try {
    if (!globalThis.localStorage) return null;
    globalThis.localStorage.removeItem(LEGACY_STORAGE_KEY);
    if (globalThis.location && new URLSearchParams(globalThis.location.search).has("reset")) {
      globalThis.localStorage.removeItem(STORAGE_KEY);
      globalThis.history?.replaceState(null, "", globalThis.location.pathname);
      return null;
    }
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(value) {
  try {
    if (!globalThis.localStorage) return;
    globalThis.localStorage.removeItem(LEGACY_STORAGE_KEY);
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Persistence is a convenience for the static prototype.
  }
}
