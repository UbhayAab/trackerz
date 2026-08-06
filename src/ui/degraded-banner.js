// DEGRADED BANNER - the surface that says which read failed, by name.
//
// This is the visible half of lib/failure.mjs. Every page in this app renders
// numbers assembled from several independent reads (ledger, food logs, wellness,
// reminders, briefings). When one of them fails, the page today looks EXACTLY
// like a page where that source was empty: a confident Rs 0, a flat chart, a
// "no meals logged" line. The user has no way to tell "you spent nothing" from
// "we could not ask".
//
// "Something went wrong" is the same disease one level up: it tells the user a
// failure happened but not what is now missing from the screen, so they still
// cannot decide whether to trust the numbers that DID render. This banner names
// the failing sources:
//
//   "Money and reminders could not be loaded. Numbers on this page may be
//    incomplete. [Retry]"
//
// It creates its own element at runtime and prepends it, so no HTML file has to
// be edited to adopt it - drop the import into a page module and it appears.

import { isDegraded } from "../../lib/failure.mjs";

export const BANNER_ID = "degradedBanner";

/**
 * Human names for the read keys the services layer uses. A key with no entry
 * falls back to a de-slugged version of itself rather than being dropped -
 * an unnamed failing source is worse than an ugly one.
 */
export const SOURCE_LABELS = {
  ledger: "money",
  ledger_entries: "money",
  budgets: "budgets",
  food_logs: "diet",
  foodLogs: "diet",
  workout_logs: "workouts",
  workoutLogs: "workouts",
  wellness_logs: "wellness",
  wellnessLogs: "wellness",
  body_metrics: "body metrics",
  bodyMetrics: "body metrics",
  sleep_sessions: "sleep",
  sleepSessions: "sleep",
  hydration_logs: "hydration",
  reminders: "reminders",
  briefings: "briefings",
  ai_actions: "the AI feed",
  aiActions: "the AI feed",
  raw_ingestions: "captures",
  profile: "your profile",
};

/** "ledger" -> "money"; "spend_patterns" -> "spend patterns". */
export function sourceLabel(key) {
  const raw = String(key ?? "").trim();
  if (!raw) return "one source";
  return SOURCE_LABELS[raw] || raw.replace(/[_-]+/g, " ");
}

/** ["a"] -> "a"; ["a","b"] -> "a and b"; ["a","b","c"] -> "a, b and c". */
export function sentenceList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The exact sentence the user reads. Pure, so tests can assert the wording
 * without a DOM - the wording IS the feature here.
 */
export function degradedMessage(failing = []) {
  const names = failing.map(sourceLabel);
  if (!names.length) return "";
  const subject = sentenceList(names);
  return `${capitalise(subject)} could not be loaded. Numbers on this page may be incomplete.`;
}

function capitalise(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Find the banner, creating and prepending it if the page has none. Created
 * once and left in the DOM even when healthy: an aria-live region that is
 * inserted at the same moment it gets its text is frequently not announced by
 * screen readers, so the element has to pre-exist its first message.
 */
export function ensureDegradedBanner(root = null) {
  const doc = root?.ownerDocument || globalThis.document;
  if (!doc) return null;
  const existing = doc.getElementById(BANNER_ID);
  if (existing) return existing;
  const host = root || doc.querySelector("main") || doc.body;
  if (!host) return null;
  const el = doc.createElement("div");
  el.id = BANNER_ID;
  // .auth-banner is the existing warning-banner style in styles/quick-actions.css;
  // reusing it means this ships styled without touching the CSS layers.
  el.className = "degraded-banner auth-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  host.prepend(el);
  return el;
}

/**
 * renderDegradedBanner(results, { onRetry, root })
 *
 * `results` is an array of Ok()/Err() results (each carrying meta.source) or a
 * { sourceName: result } map - whatever isDegraded() accepts. Returns the
 * { degraded, failing } verdict so the caller can also gate its own rendering.
 *
 * Non-results in the collection are ignored rather than assumed healthy: this
 * function only ever reports failures it can actually see.
 */
export function renderDegradedBanner(results, { onRetry = null, root = null, retryLabel = "Retry" } = {}) {
  const verdict = isDegraded(results);
  const el = ensureDegradedBanner(root);
  if (!el) return verdict;

  if (!verdict.degraded) {
    el.hidden = true;
    el.textContent = "";
    return verdict;
  }

  el.hidden = false;
  el.textContent = "";
  const doc = el.ownerDocument;
  const text = doc.createElement("span");
  text.className = "degraded-banner-text";
  text.textContent = degradedMessage(verdict.failing);
  el.append(text);

  if (typeof onRetry === "function") {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "link-button degraded-retry";
    btn.dataset.action = "retry-degraded";
    btn.textContent = retryLabel;
    btn.addEventListener("click", () => {
      // A retry that gives no feedback reads as a dead button. Say so, and let
      // the next render replace this text with the fresh verdict.
      btn.disabled = true;
      btn.textContent = "Retrying...";
      Promise.resolve()
        .then(() => onRetry())
        .then(
          () => { /* the caller re-renders; if it does not, the banner stays honest */ },
          (err) => {
            btn.disabled = false;
            btn.textContent = retryLabel;
            text.textContent = `${degradedMessage(verdict.failing)} Retry failed: ${errText(err)}`;
          },
        );
    });
    el.append(doc.createTextNode(" "));
    el.append(btn);
  }
  return verdict;
}

/** Hide the banner (used when a page tears down or a retry fully succeeds). */
export function clearDegradedBanner(root = null) {
  const doc = root?.ownerDocument || globalThis.document;
  const el = doc?.getElementById(BANNER_ID);
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function errText(err) {
  if (!err) return "unknown error";
  return String(err.message || err).slice(0, 160);
}
