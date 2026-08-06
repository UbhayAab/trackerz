package com.ubhayaab.trackerz.water

// The widget's only network code: PostgREST over plain HTTPS, as the signed-in
// user, straight into `hydration_logs`. Same table, same columns, same day
// window as src/services/supabase-data.js logHydrationBatch / fetchHydrationTotal.
//
// WHY THE WIDGET POSTS DIRECTLY INSTEAD OF LAUNCHING THE APP
// ---------------------------------------------------------
// The alternative was to have the widget start MainActivity at
// quick-log.html?do=water&ml=250 and let the web app do the write. That was
// rejected because it cannot be made invisible: a Capacitor BridgeActivity is a
// full-screen WebView, so every tap would throw the whole app in the user's face
// and leave them holding a back button. The owner asked for a widget precisely so
// that logging water does NOT mean opening the app.
//
// So the widget writes over HTTPS with the anon key plus the user's own access
// token, and the local queue in WaterStore is what makes that safe: if this file
// cannot send, nothing is lost - the tap simply stays queued and the widget says
// so out loud.
//
// WHY THERE IS NO REFRESH TOKEN HERE - READ BEFORE "IMPROVING" THIS
// ----------------------------------------------------------------
// A Supabase access token lasts an hour, so a tap made long after the app was
// last open finds no usable token and queues instead of syncing instantly. The
// obvious fix is to cache the refresh token and mint a new access token from
// native. Do not, without a plan for this: GoTrue rotates refresh tokens on use
// and detects reuse of a revoked one by revoking the whole family. The WebView is
// holding its own copy of that same refresh token. A native refresh therefore
// arms a landmine under the app's session: the next in-app refresh presents a
// revoked token and the user is signed out with no explanation, and everything
// looks exactly like "my data vanished". Trading a guaranteed sign-out risk for a
// faster widget is a bad trade in an app whose main sin has been silent wrong
// answers. The queue costs the user nothing except that the number catches up the
// next time they open Deno - and the widget SAYS the water is waiting.
//
// UNTESTED ON HARDWARE.

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

internal object WaterSync {

    // Kept in step with the PROD_URL / PROD_ANON_KEY constants in src/config.js,
    // which are the source of truth; tests/quick-log.test.mjs fails if they drift.
    // Only a fallback - if the user pointed the web app at a different project via
    // the localStorage overrides, WaterWidgetPlugin caches those instead.
    // The anon key is publishable: RLS is what protects the rows, not secrecy.
    const val DEFAULT_SUPABASE_URL = "https://yyoewdcijplkhxleejtm.supabase.co"
    const val DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_0AfWy1NnROvjW0P0Cj3KVA_m286sLXT"

    private const val TIMEOUT_MS = 15_000

    /**
     * @param ok        true only when everything queued is now on the server.
     * @param syncedMl  what actually landed this call.
     * @param pendingMl what is still owed afterwards.
     * @param message   the sentence the widget shows. Always specific, never blank.
     */
    data class Result(val ok: Boolean, val syncedMl: Int, val pendingMl: Int, val message: String)

    /**
     * Send everything queued as ONE insert, then re-read the day so the widget
     * shows the same number the app would. Safe to call from anywhere EXCEPT the
     * main thread - callers use a background thread or goAsync().
     */
    fun flush(ctx: Context): Result {
        WaterStore.rollDay(ctx)
        val queued = WaterStore.pendingArray(ctx)
        if (queued.length() == 0) {
            // Nothing owed. Still worth re-grounding the number if we can, so the
            // widget reflects water logged in the app or by Health Connect.
            val total = fetchTodayTotal(ctx)
            if (total != null) {
                WaterStore.setToday(ctx, total, WaterStore.goalMl(ctx))
                WaterStore.setStatus(ctx, "up to date")
                return Result(true, 0, 0, "up to date")
            }
            return Result(true, 0, 0, WaterStore.status(ctx))
        }

        if (!WaterStore.tokenUsable(ctx)) {
            // NOT an error and NOT a loss: the taps are on disk. Say the one thing
            // that actually fixes it.
            val msg = "open Deno to sync"
            WaterStore.setStatus(ctx, msg)
            return Result(false, 0, WaterStore.pendingMl(ctx), msg)
        }

        val userId = WaterStore.userId(ctx) ?: return Result(false, 0, WaterStore.pendingMl(ctx), "open Deno to sync")
        val ids = HashSet<Int>()
        var sendingMl = 0
        val rows = JSONArray()
        for (i in 0 until queued.length()) {
            val tap = queued.optJSONObject(i) ?: continue
            val ml = tap.optInt("ml", 0)
            if (ml <= 0) continue
            ids.add(tap.optInt("id", -1))
            sendingMl += ml
            rows.put(
                JSONObject()
                    .put("user_id", userId)
                    .put("ml", ml)
                    // Its OWN tap time, not now. A glass drunk at 11:40 pm and
                    // synced at 8 am tomorrow belongs to yesterday.
                    .put("occurred_at", WaterStore.iso(tap.optLong("at", System.currentTimeMillis())))
            )
        }
        if (rows.length() == 0) {
            WaterStore.confirmSent(ctx, ids, 0)
            return Result(true, 0, 0, WaterStore.status(ctx))
        }

        return try {
            val code = postRows(ctx, rows)
            when {
                code in 200..299 -> {
                    WaterStore.confirmSent(ctx, ids, sendingMl)
                    // Re-ground on the server's own arithmetic where possible, so a
                    // partially-synced history cannot leave the widget permanently
                    // ahead of or behind the app.
                    fetchTodayTotal(ctx)?.let { WaterStore.setToday(ctx, it, WaterStore.goalMl(ctx)) }
                    WaterStore.setStatus(ctx, "synced")
                    Result(true, sendingMl, WaterStore.pendingMl(ctx), "synced")
                }
                code == 401 || code == 403 -> {
                    // The token died or RLS refused. Keep every tap, drop the dead
                    // token so we stop retrying with it, and ask for the one thing
                    // that helps.
                    WaterStore.clearSession(ctx)
                    val msg = "sign-in expired - open Deno"
                    WaterStore.setStatus(ctx, msg)
                    Result(false, 0, WaterStore.pendingMl(ctx), msg)
                }
                else -> {
                    val msg = "server said $code - still queued"
                    WaterStore.setStatus(ctx, msg)
                    Result(false, 0, WaterStore.pendingMl(ctx), msg)
                }
            }
        } catch (_: Throwable) {
            // Offline, DNS, timeout. Nothing was written and nothing was lost.
            val msg = "offline - still queued"
            WaterStore.setStatus(ctx, msg)
            Result(false, 0, WaterStore.pendingMl(ctx), msg)
        }
    }

    private fun postRows(ctx: Context, rows: JSONArray): Int {
        val url = URL("${WaterStore.supabaseUrl(ctx).trimEnd('/')}/rest/v1/hydration_logs")
        val conn = url.openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.doOutput = true
            conn.setRequestProperty("apikey", WaterStore.supabaseKey(ctx))
            conn.setRequestProperty("Authorization", "Bearer ${WaterStore.accessToken(ctx)}")
            conn.setRequestProperty("Content-Type", "application/json")
            // return=minimal: we do not need the rows back, and asking for them
            // doubles the payload on a metered mobile connection for nothing.
            conn.setRequestProperty("Prefer", "return=minimal")
            conn.outputStream.use { it.write(rows.toString().toByteArray(Charsets.UTF_8)) }
            conn.responseCode
        } finally {
            try { conn.disconnect() } catch (_: Throwable) {}
        }
    }

    /**
     * Today's total in ml, or null if it could not be read. Windowed to the LOCAL
     * day exactly like fetchHydrationTotal, so the widget and the app cannot
     * disagree about which glasses are today's.
     */
    fun fetchTodayTotal(ctx: Context): Int? {
        if (!WaterStore.tokenUsable(ctx)) return null
        val (startIso, endIso) = WaterStore.dayBoundsIso()
        // The ISO strings carry a "+05:30" offset, and a raw + in a query string
        // means a space. Encoding is not optional here.
        val query = "select=ml" +
            "&occurred_at=gte." + URLEncoder.encode(startIso, "UTF-8") +
            "&occurred_at=lt." + URLEncoder.encode(endIso, "UTF-8")
        val url = URL("${WaterStore.supabaseUrl(ctx).trimEnd('/')}/rest/v1/hydration_logs?$query")
        val conn = url.openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "GET"
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.setRequestProperty("apikey", WaterStore.supabaseKey(ctx))
            conn.setRequestProperty("Authorization", "Bearer ${WaterStore.accessToken(ctx)}")
            conn.setRequestProperty("Accept", "application/json")
            if (conn.responseCode !in 200..299) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val arr = JSONArray(body)
            var sum = 0
            for (i in 0 until arr.length()) sum += arr.optJSONObject(i)?.optInt("ml", 0) ?: 0
            sum
        } catch (_: Throwable) {
            null
        } finally {
            try { conn.disconnect() } catch (_: Throwable) {}
        }
    }
}
