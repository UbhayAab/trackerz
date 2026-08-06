package com.ubhayaab.trackerz.water

// THE WIDGET'S MEMORY. Everything the home-screen widget and the Quick Settings
// tile know about water lives here, in SharedPreferences, because both of them
// run in a process that Android is free to kill between any two taps.
//
// WHY A DURABLE QUEUE AT ALL
// --------------------------
// A widget tap must count even when nothing else is available: no app running,
// no network, an expired sign-in. So a tap is TWO steps that cannot be reordered:
//   1. append it here and repaint (synchronous, cannot fail, cannot be "busy");
//   2. try to send it (may fail, may be retried forever).
// Step 1 is what makes the promise "a tap is never silently lost" true. Step 2 is
// best effort. This is the same shape as lib/water.mjs's pending/inflight/server
// split, for the same reason - a tap is a fact the user asserted, not a request.
//
// Each queued tap keeps its OWN timestamp. Sending them all stamped "now" would
// file a glass drunk at 11:40 pm as tomorrow's water the first time the phone
// synced after midnight, which is a silent wrong answer rather than a visible
// failure.
//
// UNTESTED ON HARDWARE.

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

internal object WaterStore {

    private const val PREFS = "deno_water_widget"

    // One tap = one glass, matching WATER_TAP_ML in lib/water.mjs. Two constants
    // for one number is how the button and the label end up disagreeing, so if
    // this changes, change it there too - tests/quick-log.test.mjs asserts they
    // are equal.
    const val TAP_ML = 250

    // The fallback daily goal: the diet scaffold's own water schedule summed up
    // (WATER_GOAL_SCAFFOLD_ML in lib/water.mjs). NOT a second hardcoded 3000.
    const val DEFAULT_GOAL_ML = 3450

    // A goal of 0 makes a percentage Infinity, which a ProgressBar renders as a
    // full bar forever. Refuse it here exactly as clampGoalMl does in JS.
    private const val GOAL_MIN_ML = 1
    private const val GOAL_MAX_ML = 10000

    private const val K_PENDING = "pending"        // JSONArray of { id, ml, at }
    private const val K_SEQ = "seq"
    private const val K_CONFIRMED = "confirmedMl"  // what the server is known to hold for today
    private const val K_DAY = "dayKey"
    private const val K_GOAL = "goalMl"
    private const val K_STATUS = "status"          // the one line the widget shows about itself
    private const val K_SYNCED_AT = "syncedAt"

    private const val K_SB_URL = "sbUrl"
    private const val K_SB_KEY = "sbKey"
    private const val K_TOKEN = "accessToken"
    private const val K_TOKEN_EXP = "accessTokenExpiresAtMs"
    private const val K_USER = "userId"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------ the day

    fun todayKey(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    /**
     * Local midnight boundaries for today, as PostgREST-ready ISO-8601 with a
     * real UTC offset. The web app's fetchHydrationTotal windows the day the same
     * way (local midnight to next local midnight), so the widget and the app can
     * never disagree about which glasses belong to "today".
     */
    fun dayBoundsIso(): Pair<String, String> {
        val cal = Calendar.getInstance()
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        val start = cal.time
        cal.add(Calendar.DATE, 1)
        val end = cal.time
        return Pair(iso(start.time), iso(end.time))
    }

    fun iso(epochMs: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(epochMs))

    /**
     * Drop yesterday's confirmed total when the date rolls over. Pending taps are
     * deliberately NOT dropped - they carry their own timestamps and still have to
     * be sent, they simply stop counting towards today's number.
     */
    @Synchronized
    fun rollDay(ctx: Context) {
        val p = prefs(ctx)
        val today = todayKey()
        if (p.getString(K_DAY, null) == today) return
        p.edit().putString(K_DAY, today).putInt(K_CONFIRMED, 0).apply()
    }

    // ---------------------------------------------------------------- the taps

    /** Append a tap. Returns the new displayed total. Cannot fail; cannot block. */
    @Synchronized
    fun addTap(ctx: Context, ml: Int): Int {
        rollDay(ctx)
        val p = prefs(ctx)
        val amount = if (ml > 0) ml else TAP_ML
        val seq = p.getInt(K_SEQ, 0) + 1
        val arr = pendingArray(ctx)
        arr.put(JSONObject().put("id", seq).put("ml", amount).put("at", System.currentTimeMillis()))
        // commit(), not apply(): the very next thing that happens is often the
        // process being killed (a widget's BroadcastReceiver is alive for seconds).
        // An asynchronous write is exactly the tap this whole file exists to keep.
        p.edit().putString(K_PENDING, arr.toString()).putInt(K_SEQ, seq).commit()
        return displayedMl(ctx)
    }

    fun pendingArray(ctx: Context): JSONArray =
        try { JSONArray(prefs(ctx).getString(K_PENDING, "[]")) } catch (_: Throwable) { JSONArray() }

    fun pendingMl(ctx: Context): Int {
        val arr = pendingArray(ctx)
        var sum = 0
        for (i in 0 until arr.length()) sum += arr.optJSONObject(i)?.optInt("ml", 0) ?: 0
        return sum
    }

    fun pendingCount(ctx: Context): Int = pendingArray(ctx).length()

    /**
     * Remove exactly the taps that landed, by id, and add their millilitres to the
     * confirmed total. By id and not "clear everything": a tap made WHILE the POST
     * was in the air has not been sent, and clearing the whole queue would drop it
     * silently - the same class of bug as the old busy-guard that ate five glasses.
     */
    @Synchronized
    fun confirmSent(ctx: Context, sentIds: Set<Int>, sentMl: Int) {
        val p = prefs(ctx)
        val kept = JSONArray()
        val arr = pendingArray(ctx)
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (!sentIds.contains(o.optInt("id", -1))) kept.put(o)
        }
        p.edit()
            .putString(K_PENDING, kept.toString())
            .putInt(K_CONFIRMED, p.getInt(K_CONFIRMED, 0) + sentMl)
            .putLong(K_SYNCED_AT, System.currentTimeMillis())
            .commit()
    }

    // ------------------------------------------------------------- the numbers

    fun confirmedMl(ctx: Context): Int = prefs(ctx).getInt(K_CONFIRMED, 0)

    /** What the widget shows: what the server holds plus everything we owe it. */
    fun displayedMl(ctx: Context): Int {
        rollDay(ctx)
        return confirmedMl(ctx) + pendingMl(ctx)
    }

    fun goalMl(ctx: Context): Int {
        val raw = prefs(ctx).getInt(K_GOAL, DEFAULT_GOAL_ML)
        return if (raw in GOAL_MIN_ML..GOAL_MAX_ML) raw else DEFAULT_GOAL_ML
    }

    /**
     * Percent of goal, 0..100, integer, never NaN and never Infinity whatever the
     * inputs - the Kotlin twin of pctOf() in lib/water.mjs. A goal of 0 used to
     * produce Infinity in the web meter; the widget must not re-import that bug.
     */
    fun pctOf(totalMl: Int, goalMl: Int): Int {
        if (goalMl <= 0) return 0
        val pct = Math.round(totalMl.toFloat() / goalMl.toFloat() * 100f)
        return pct.coerceIn(0, 100)
    }

    /** The app telling the widget the authoritative truth after a real read. */
    @Synchronized
    fun setToday(ctx: Context, ml: Int, goal: Int) {
        rollDay(ctx)
        val e = prefs(ctx).edit().putInt(K_CONFIRMED, maxOf(0, ml))
        if (goal in GOAL_MIN_ML..GOAL_MAX_ML) e.putInt(K_GOAL, goal)
        e.putLong(K_SYNCED_AT, System.currentTimeMillis()).apply()
    }

    // -------------------------------------------------------------- the status

    /**
     * The single line of text under the number. It is never blank and never
     * cheerful-by-default: the whole point is that "queued, not saved" looks
     * different from "saved" at a glance.
     */
    fun status(ctx: Context): String {
        val waiting = pendingCount(ctx)
        val stored = prefs(ctx).getString(K_STATUS, null)
        if (waiting > 0) {
            val ml = pendingMl(ctx)
            return "$ml ml waiting - tap here to sync" + (if (stored.isNullOrBlank()) "" else " ($stored)")
        }
        return stored ?: "tap to add ${TAP_ML} ml"
    }

    fun setStatus(ctx: Context, text: String) {
        prefs(ctx).edit().putString(K_STATUS, text).apply()
    }

    // ------------------------------------------------------------- the session
    //
    // Cached by WaterWidgetPlugin every time the app is in the foreground, read
    // by WaterSync when nothing else is running. See WaterSync for why the refresh
    // token is deliberately NOT stored here.

    @Synchronized
    fun saveSession(ctx: Context, url: String, key: String, accessToken: String, expiresAtMs: Long, userId: String) {
        prefs(ctx).edit()
            .putString(K_SB_URL, url)
            .putString(K_SB_KEY, key)
            .putString(K_TOKEN, accessToken)
            .putLong(K_TOKEN_EXP, expiresAtMs)
            .putString(K_USER, userId)
            .apply()
    }

    fun supabaseUrl(ctx: Context): String =
        prefs(ctx).getString(K_SB_URL, null)?.takeIf { it.isNotBlank() } ?: WaterSync.DEFAULT_SUPABASE_URL

    fun supabaseKey(ctx: Context): String =
        prefs(ctx).getString(K_SB_KEY, null)?.takeIf { it.isNotBlank() } ?: WaterSync.DEFAULT_SUPABASE_ANON_KEY

    fun accessToken(ctx: Context): String? = prefs(ctx).getString(K_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun userId(ctx: Context): String? = prefs(ctx).getString(K_USER, null)?.takeIf { it.isNotBlank() }

    /**
     * A token is usable only with a minute of life left. Sending one that expires
     * mid-flight returns a 401, which is indistinguishable from "you were signed
     * out" and would make the widget shout about sign-in for no reason.
     */
    fun tokenUsable(ctx: Context): Boolean {
        val token = accessToken(ctx) ?: return false
        if (userId(ctx) == null) return false
        val exp = prefs(ctx).getLong(K_TOKEN_EXP, 0L)
        return token.isNotBlank() && exp > System.currentTimeMillis() + 60_000L
    }

    @Synchronized
    fun clearSession(ctx: Context) {
        prefs(ctx).edit().remove(K_TOKEN).remove(K_TOKEN_EXP).remove(K_USER).apply()
    }
}
