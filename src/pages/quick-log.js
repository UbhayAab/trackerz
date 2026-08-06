// ONE-TAP LOGGING WITHOUT OPENING THE APP.
//
// The owner's ask, verbatim: "for the water tracker, can we not add a widget
// kind of a thing, which whenever I tap on, it logs water". This page is the web
// half of that. It is the target of:
//   - the manifest `shortcuts` entry (long-press the installed icon -> "Log 250
//     ml water"), which needs no APK at all;
//   - the Android home-screen widget and the Quick Settings tile, when they need
//     the app to finish the job (see android/.../water/).
//
// The contract: the URL IS the action. ?do=water&ml=250 logs 250 ml on load, with
// nothing to tap first. Then it shows the running day total big enough to read at
// arm's length, a "+250 ml again" button so a second glass is one more tap, an
// Undo, and a way into the real app.
//
// WHAT THIS FILE REFUSES TO DO
// ----------------------------
// 1. Reimplement water. lib/water.mjs already solved the hard part - a burst of
//    taps must all count, and the number must move on the tap frame, not on the
//    server round trip. Reimplementing that here would have re-created the bug
//    where six taps in three seconds logged one glass.
// 2. Drop a tap. Every path - offline, signed out, local test mode, server
//    error - ends in either a durable queued item or a specific visible error.
//    A quick action that fails quietly is worse than no button at all.
// 3. Block the first paint on the database library. Only lib/water.mjs is a
//    static import; auth, supabase-js and the offline queue are pulled in
//    dynamically AFTER the optimistic number is already on screen. That also
//    keeps this module importable by tests/quick-log.test.mjs under plain node.

import {
  WATER_FLUSH_MS,
  WATER_TAP_ML,
  applyServerTotal,
  createWaterState,
  flushFailed,
  flushOk,
  fmtMl,
  pctOf,
  setGoalMl,
  takeFlushBatch,
  tapWater,
  undoWater,
  waterView,
} from "../../lib/water.mjs";

// A single tap is a glass, not a bathtub. 5 L in one shot is a typo or a crafted
// URL, and silently writing it would poison the day's total with no way to tell
// it from a real reading.
export const QUICK_LOG_MAX_ML = 5000;

// Everything this page knows how to do. `sync` exists so the widget has a URL to
// open that flushes what it queued WITHOUT logging another glass - opening
// ?do=water to sync would add water the user never drank.
export const QUICK_LOG_ACTIONS = ["water", "sync"];

/**
 * Parse the request out of a query string. Pure, exported, and tested directly:
 * this is the one place where a bad URL turns into either an action or a refusal,
 * and "the shortcut did nothing" is indistinguishable from "the shortcut logged
 * nothing" unless the refusal is explicit.
 *
 * Accepts a raw "?do=water&ml=250", a bare "do=water", a full URL, or a
 * URLSearchParams. Returns { action, ml, error }. `error` non-null means: show it
 * and write nothing.
 */
export function parseQuickLogRequest(input = "") {
  let params;
  try {
    if (input instanceof URLSearchParams) params = input;
    else {
      const raw = String(input ?? "");
      // A full href ("https://host/quick-log.html?do=water") has to have its
      // query lifted out; a bare query string must not.
      const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.replace(/^[#&]/, "");
      params = new URLSearchParams(q);
    }
  } catch {
    params = new URLSearchParams();
  }

  // No `do` at all means the page was opened directly. Water is the only reason
  // this page exists, so that is the default rather than an error page.
  const rawAction = (params.get("do") || params.get("action") || "water").trim().toLowerCase();
  if (!QUICK_LOG_ACTIONS.includes(rawAction)) {
    return {
      action: null,
      ml: 0,
      error: `Deno doesn't know how to "${rawAction}". This link can do: ${QUICK_LOG_ACTIONS.join(", ")}.`,
    };
  }

  if (rawAction === "sync") return { action: "sync", ml: 0, error: null };

  const rawMl = params.get("ml");
  if (rawMl === null || rawMl === "") return { action: "water", ml: WATER_TAP_ML, error: null };

  const ml = Math.round(Number(rawMl));
  // Number("") is 0 and Number("abc") is NaN - both have to be refused out loud,
  // because a 0 ml "success" is a tap the user believes was recorded.
  if (!Number.isFinite(ml) || ml <= 0) {
    return { action: null, ml: 0, error: `"${rawMl}" is not an amount of water this can log.` };
  }
  if (ml > QUICK_LOG_MAX_ML) {
    return {
      action: null,
      ml: 0,
      error: `${ml} ml in one tap looks like a typo, so nothing was logged. The most a single tap can add is ${fmtMl(QUICK_LOG_MAX_ML)}.`,
    };
  }
  return { action: "water", ml, error: null };
}

/**
 * Classify a failure so the caller knows whether the write can be safely retried
 * later (queue it) or might have already landed (say so instead).
 *
 * The distinction is the whole difference between "your glass is safe" and a
 * silent duplicate: a fetch that never reached PostgREST is safe to replay, but a
 * PostgREST error carrying a code (a constraint, an RLS refusal) is the server
 * having ANSWERED, and replaying that is how one glass becomes two.
 */
export function isReplayableFailure(err) {
  if (!err) return false;
  if (err.message === "not_authenticated") return true;
  // supabase-js surfaces a transport failure as a TypeError from fetch, with no
  // PostgREST `code`. A PostgrestError always carries one.
  if (err.code) return false;
  const text = String(err.message || err).toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|offline|timeout|econnrefused|fetch failed/.test(text);
}

// ---------------------------------------------------------------------------
// Everything below here needs a DOM. Guarded so `import`ing this module in node
// (tests/quick-log.test.mjs) exercises the pure parts and mounts nothing.
// ---------------------------------------------------------------------------

let state = createWaterState();
// Water that exists ONLY on this device: written to the IndexedDB capture queue
// because the account could not be reached. Counted in the number on screen with
// a visible "not synced yet" chip, never counted as saved.
let queuedMl = 0;
let flushTimer = null;
let flushing = null;
let authReady = null;

// Resolved once, lazily, and never re-entered. Lazy rather than eager because
// "+250 again" is bound and clickable before start() has finished its first
// await, and a flush firing against a null promise would throw a TypeError where
// the user expects either a saved glass or a reason.
function ensureSession() {
  if (!authReady) authReady = resolveSession();
  return authReady;
}

const el = (id) => document.getElementById(id);

function setStatus(text, kind = "info") {
  const node = el("qlStatus");
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}

function setHeadline(text) {
  const node = el("qlHeadline");
  if (node) node.textContent = text;
}

// Repaint the number, the meter and the buttons from the reducer's view. Never
// computes a percentage itself: pctOf is the function that cannot return
// Infinity, which is what a goal of 0 used to render as `width:Infinity%`.
function paint() {
  const v = waterView(state);
  const shown = v.totalMl + queuedMl;
  const total = el("qlTotal");
  if (total) total.textContent = fmtMl(shown);
  const goal = el("qlGoal");
  if (goal) goal.textContent = `of ${v.goalText} today`;
  const meter = el("qlMeter");
  if (meter) meter.style.width = `${pctOf(shown, v.goalMl)}%`;

  const queued = el("qlQueued");
  if (queued) {
    queued.hidden = queuedMl <= 0;
    queued.textContent = queuedMl > 0 ? `${fmtMl(queuedMl)} waiting on this device - not saved to your account yet` : "";
  }

  const again = el("qlAgain");
  if (again) {
    again.textContent = `+${fmtMl(WATER_TAP_ML)} again`;
    again.disabled = false;
  }
  const undo = el("qlUndo");
  if (undo) undo.disabled = !v.canUndo;
}

// THE TAP. Identical shape to src/ui/quick-actions.js on purpose: zero network,
// zero await, nothing that can be "busy". Tapping "+250 again" four times while
// the first flush is still in the air is four glasses.
function onTap(ml = WATER_TAP_ML) {
  state = tapWater(state, ml);
  paint();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushNow(); }, WATER_FLUSH_MS);
}

// Send everything tapped since the last flush as ONE insert.
async function flushNow() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (flushing) await flushing.catch(() => {});
  const { next, batch } = takeFlushBatch(state);
  if (!batch.length) return;
  state = next;
  flushing = (async () => {
    try {
      const session = await ensureSession();
      if (!session.usable) throw new Error("not_authenticated");
      const { logHydrationBatch } = await import("../services/supabase-data.js");
      await logHydrationBatch(batch.map((t) => t.ml));
      state = flushOk(state, batch);
      paint();
      const v = waterView(state);
      setHeadline("Logged.");
      setStatus(`${fmtMl(batch.reduce((s, t) => s + t.ml, 0))} saved. ${v.label} today.`, "ok");
      pushTotalToWidget();
    } catch (err) {
      // The number goes visibly back down first - an optimistic total that stays
      // up after a failed write is a lie the user walks away believing.
      const rollback = flushFailed(state, batch);
      state = rollback.next;
      paint();
      await handleWriteFailure(err, batch, rollback.lostMl);
    } finally {
      flushing = null;
    }
  })();
  await flushing;
}

// Where a failed write goes to be honest about itself.
//
// Replayable (offline, signed out, local test mode): park it in the SAME
// IndexedDB queue the share target and the capture box use, so it is filed the
// next time the app runs online. Not replayable (the server answered and said
// no): say exactly what it said and offer a retry, because queueing a write that
// may already have landed is how one glass becomes two.
async function handleWriteFailure(err, batch, lostMl) {
  const reason = err?.message || String(err);
  if (!isReplayableFailure(err)) {
    setHeadline("Not saved.");
    setStatus(`Didn't save ${fmtMl(lostMl)}: ${reason}. Nothing was written - tap "+${fmtMl(WATER_TAP_ML)} again" to retry.`, "error");
    return;
  }
  try {
    const { enqueueCapture } = await import("../services/offline-queue.js");
    for (const tap of batch) {
      await enqueueCapture({ text: describeTapForQueue(tap.ml), captureType: "auto" });
    }
    queuedMl += lostMl;
    paint();
    const session = await ensureSession();
    setHeadline("Saved on this device.");
    setStatus(
      session.reason === "signed_out"
        ? `You're not signed in, so ${fmtMl(lostMl)} could not go to your account. It is queued on this phone - sign in and open Deno and it will be filed.`
        : session.reason === "local_mode"
          ? `Deno is in local test mode, which never syncs. ${fmtMl(lostMl)} is queued on this phone; sign in for real and open Deno to file it.`
          : `Offline. ${fmtMl(lostMl)} is queued on this phone and will be filed the next time Deno opens with a connection.`,
      "warn",
    );
  } catch (queueErr) {
    // Both the server AND the local queue refused. This is the one case where a
    // tap really is gone, so it has to be said in those words rather than left
    // to look like a success.
    setHeadline("Not saved anywhere.");
    setStatus(
      `${fmtMl(lostMl)} could not be saved (${reason}) and could not be queued on this device either ` +
      `(${queueErr?.message || queueErr}). Nothing was recorded - log it in the app.`,
      "error",
    );
  }
}

// The text a queued tap is replayed as. The agent's own vocabulary: "drank",
// "ml", "water" are what create_hydration_candidate keys off, and the explicit
// clock time stops a glass drunk at 11pm being filed at 9am tomorrow when the
// queue finally drains.
function describeTapForQueue(ml) {
  const now = new Date();
  const when = now.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return `drank ${ml} ml of water at ${when}`;
}

// ---------------------------------------------------------------------------
// The native surfaces. Both are no-ops in a browser - `Capacitor.Plugins` only
// exists inside the APK - so nothing here can break the PWA.
// ---------------------------------------------------------------------------

function waterWidgetPlugin() {
  const plugin = globalThis.Capacitor?.Plugins?.WaterWidget;
  return plugin && typeof plugin.setToday === "function" ? plugin : null;
}

// Hand the authoritative total to the home-screen widget and the Quick Settings
// tile so they stop showing a stale number the moment the app knows better.
function pushTotalToWidget() {
  const plugin = waterWidgetPlugin();
  if (!plugin) return;
  const v = waterView(state);
  Promise.resolve(plugin.setToday({ ml: v.totalMl, goalMl: v.goalMl }))
    .catch((err) => console.warn("[quick-log] could not refresh the water widget:", err));
}

// Ask the native side to flush anything the widget/tile queued while the app was
// closed. Native owns that write because it kept each tap's real timestamp; this
// is only the trigger, and it runs once we know auth is good.
async function syncNativeQueue() {
  const plugin = waterWidgetPlugin();
  if (!plugin || typeof plugin.syncNow !== "function") return null;
  try {
    return await plugin.syncNow();
  } catch (err) {
    console.warn("[quick-log] widget sync failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------

// Resolve who we are ONCE, and describe it in terms this page can act on.
// `usable` is deliberately false for local test mode: those sessions carry a
// user id of `local:<email>`, which Postgres rejects as a uuid, so writing
// through them would fail at the database with an unreadable error instead of
// the plain "this mode never syncs" the user needs.
async function resolveSession() {
  try {
    const { initAuth, getCurrentSession, isLocalSession } = await import("../services/auth.js");
    await initAuth();
    const session = getCurrentSession();
    if (!session) return { usable: false, reason: "signed_out", session: null };
    if (isLocalSession(session)) return { usable: false, reason: "local_mode", session };
    return { usable: true, reason: "signed_in", session };
  } catch (err) {
    // The auth module itself failed to load (offline, blocked CDN). That is not
    // "signed out" and must not be reported as it.
    return { usable: false, reason: "unreachable", session: null, error: err };
  }
}

// Ground the page in what the server actually holds: today's total and the real
// goal. Failure here is not fatal - the tap is already counted optimistically -
// so it degrades to the scaffold goal rather than blocking the write.
async function loadServerState() {
  const session = await ensureSession();
  if (!session.usable) return;
  const { fetchHydrationTotal, fetchWaterGoalMl } = await import("../services/supabase-data.js");
  const [total, goal] = await Promise.allSettled([fetchHydrationTotal(new Date()), fetchWaterGoalMl()]);
  // A goal the user never set reads null; setGoalMl would reject it, so the
  // state keeps the scaffold-derived default instead of storing a 0 that makes
  // the meter Infinity.
  if (goal.status === "fulfilled" && goal.value != null) {
    state = setGoalMl(state, goal.value).next;
  }
  // applyServerTotal ignores this by itself while a batch is inflight, so a read
  // that cannot have seen our insert can never erase it.
  if (total.status === "fulfilled") {
    state = applyServerTotal(state, { ml: total.value.ml, rows: total.value.rows });
  }
  paint();
}

function bind() {
  el("qlAgain")?.addEventListener("click", () => {
    setHeadline("Logging water…");
    setStatus("Saving…");
    onTap(WATER_TAP_ML);
  });

  el("qlUndo")?.addEventListener("click", async () => {
    // Water sitting in the offline queue cannot be pulled back out from here -
    // offline-queue.js exposes no single-row delete, and duplicating its schema
    // to reach in would be a second source of truth for the same store. Say that
    // plainly rather than pretending the button did something.
    if (queuedMl > 0) {
      setStatus(
        `${fmtMl(queuedMl)} is already queued on this device and can't be cancelled from here. ` +
        "Open Deno when you're back online and remove it from the additions feed.",
        "warn",
      );
      return;
    }
    const { next, undone } = undoWater(state);
    if (!undone) { setStatus("Nothing to undo - no water logged today.", "warn"); return; }
    if (undone.scope === "pending") {
      // Never written, so there is no row to delete and no chance of deleting
      // the older glass that came before it.
      state = next;
      paint();
      setHeadline("Removed.");
      setStatus(`Removed ${fmtMl(undone.ml)} - it hadn't been saved yet.`, "ok");
      return;
    }
    const undoBtn = el("qlUndo");
    if (undoBtn) undoBtn.disabled = true;
    try {
      const session = await ensureSession();
      if (!session.usable) throw new Error("not_authenticated");
      // Let the in-flight batch land first, so undo removes the newest row
      // instead of racing the insert that is creating it.
      await flushNow();
      const { undoLastHydration, fetchHydrationTotal } = await import("../services/supabase-data.js");
      const removed = await undoLastHydration();
      const fresh = await fetchHydrationTotal(new Date());
      state = applyServerTotal(state, { ml: fresh.ml, rows: fresh.rows });
      paint();
      setHeadline(removed ? "Removed." : "Nothing to undo.");
      setStatus(removed ? `Removed ${fmtMl(removed.ml)}. ${waterView(state).label} today.` : "Nothing to undo today.", removed ? "ok" : "warn");
      pushTotalToWidget();
    } catch (err) {
      setStatus(`Couldn't undo: ${err?.message || err}`, "error");
    } finally {
      paint();
    }
  });

  // Leaving the page is exactly when an unflushed tap would be lost, so pay the
  // debt immediately rather than on a timer that may never get to fire.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  globalThis.addEventListener?.("pagehide", () => { flushNow(); });
}

async function start() {
  bind();
  const req = parseQuickLogRequest(globalThis.location?.search || "");

  if (req.error) {
    setHeadline("Nothing logged.");
    setStatus(req.error, "error");
    const total = el("qlTotal");
    if (total) total.textContent = "–";
    const again = el("qlAgain");
    if (again) again.disabled = false;   // the button still works; the URL did not
    return;
  }

  // THE TAP HAPPENS FIRST, before auth, before supabase-js, before any await.
  // Nothing downstream is allowed to be the reason a tap did not count.
  if (req.action === "water") {
    state = tapWater(state, req.ml);
    setHeadline(`Logging ${fmtMl(req.ml)}…`);
  } else {
    setHeadline("Syncing…");
    setStatus("Sending anything the widget logged while Deno was closed…");
  }
  paint();

  // A reload, or Android restoring this tab when the app is reopened, must not
  // silently pour another glass. Once the tap is counted, the URL stops being an
  // instruction and becomes a plain sync link.
  try {
    const url = new URL(globalThis.location.href);
    url.search = "?do=sync";
    history.replaceState(null, "", url.href);
  } catch { /* non-browser or opaque origin */ }

  const session = await ensureSession();

  if (session.reason === "unreachable") {
    setStatus("Couldn't reach the account service - saving locally instead.", "warn");
  }

  await loadServerState();
  await flushNow();

  if (req.action === "sync") {
    setHeadline("Up to date.");
    const v = waterView(state);
    setStatus(session.usable ? `${v.label} today.` : "Not signed in, so nothing could be synced. Open Deno and sign in.", session.usable ? "ok" : "warn");
  }

  // Native queue last: it needs a good token, which the plugin re-reads from
  // this WebView when the app resumes, and it is the only path that can be
  // holding taps made while the app was not running at all.
  const synced = await syncNativeQueue();
  if (synced && Number(synced.syncedMl) > 0) {
    await loadServerState();
    setStatus(`${fmtMl(Number(synced.syncedMl))} logged from the widget while Deno was closed. ${waterView(state).label} today.`, "ok");
  }
  pushTotalToWidget();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
