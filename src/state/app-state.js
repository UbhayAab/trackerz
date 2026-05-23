const STORAGE_KEY = "trackerz_state_v3";
const LEGACY_KEYS = ["trackerz_state", "trackerz_state_v2"];
const listeners = new Set();

let state = loadState() || createEmptyState();

export function createEmptyState() {
  return {
    selectedNav: "capture",
    activeJob: null,
    parseLog: [],
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

export function resetWorkspace() {
  state = createEmptyState();
  saveState(state);
  for (const listener of listeners) listener(getState());
}

export function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
}

function loadState() {
  try {
    if (!globalThis.localStorage) return null;
    for (const k of LEGACY_KEYS) globalThis.localStorage.removeItem(k);
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
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Persistence is a convenience for the static prototype.
  }
}
