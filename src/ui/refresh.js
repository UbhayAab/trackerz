// REFRESH AFTER A WRITE, OUT LOUD.
//
// Nine call sites did `await hydrateStateFromSupabase().catch(() => {})` after
// writing a row. The write is the important part, so swallowing the refresh
// looks harmless - and it is the opposite of harmless, because of what the user
// then sees:
//
//   the row IS saved, and the screen does NOT change.
//
// Which is indistinguishable from "my tap did nothing". So they tap again. That
// is how a single workout became two rows on 2026-07-22, and it is the same
// shape as every other bug in this codebase's history: something is computed
// correctly and then never surfaced.
//
// A failed refresh is not a failed write and must never be reported as one. It
// is "saved, but I could not reload" - a different sentence, with a different
// action attached.

import { hydrateStateFromSupabase } from "../state/sync.js";
import { showToast } from "./toast.js";
import { classify } from "../../lib/failure.mjs";

let warnedAt = 0;
// One warning per 30 s. A burst of quick actions during an outage would
// otherwise stack six identical toasts, which is its own kind of noise.
const WARN_COOLDOWN_MS = 30000;

/**
 * Reload app state after a successful write.
 *
 * @param {string} what - what was just saved, for the message ("water", "the workout")
 * @returns {Promise<boolean>} true if the refresh succeeded
 */
export async function refreshAfterWrite(what = "that") {
  try {
    await hydrateStateFromSupabase();
    return true;
  } catch (err) {
    const kind = classify(err);
    console.error(`[refresh] ${what} saved but the reload failed:`, err);
    const now = Date.now();
    if (now - warnedAt > WARN_COOLDOWN_MS) {
      warnedAt = now;
      showToast(
        kind === "offline"
          ? `Saved ${what}. You're offline, so the screen may be out of date.`
          : `Saved ${what}, but couldn't refresh the screen. Pull down or reopen to see it.`,
        { kind: "error", duration: 5000 },
      );
    }
    return false;
  }
}
