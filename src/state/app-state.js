const STORAGE_KEY_BASE = "trackerz_state_v4";
const LOCAL_SESSION_KEY = "trackerz_local_auth_session_v1";
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
    additions: [],
    userPlans: [],
    insights: [],
    metrics: {
      // proteinTarget / caloriesTarget are SEED fallbacks only — sync.js overwrites
      // them from the single source (budget goals → scaffold) on every hydrate.
      todaySpend: 0,
      budgetPace: 0,
      protein: 0,
      proteinTarget: 162,
      caloriesToday: 0,
      caloriesLeft: 2000,
      caloriesTarget: 2000,
      habitScore: 0,
      habitNote: "No wellness data yet",
      adherence: 0,
    },
  };
}

export function getState() {
  return structuredClone(state);
}

export function getWorkspaceStorageKey() {
  return `${STORAGE_KEY_BASE}:${sanitizeStorageSuffix(getStorageUserId())}`;
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
      globalThis.localStorage.removeItem(getWorkspaceStorageKey());
      globalThis.history?.replaceState(null, "", globalThis.location.pathname);
      return null;
    }
    const raw = globalThis.localStorage.getItem(getWorkspaceStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(value) {
  try {
    if (!globalThis.localStorage) return;
    for (const k of LEGACY_KEYS) globalThis.localStorage.removeItem(k);
    globalThis.localStorage.removeItem(STORAGE_KEY_BASE);
    globalThis.localStorage.setItem(getWorkspaceStorageKey(), JSON.stringify(value));
  } catch {
    // Persistence is a convenience for the static prototype.
  }
}

function sanitizeStorageSuffix(value) {
  return String(value || "anonymous")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, 96) || "anonymous";
}

function getStorageUserId() {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_SESSION_KEY);
    return raw ? JSON.parse(raw)?.user?.id || "anonymous" : "anonymous";
  } catch {
    return "anonymous";
  }
}
