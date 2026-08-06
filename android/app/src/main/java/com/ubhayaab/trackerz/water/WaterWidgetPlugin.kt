package com.ubhayaab.trackerz.water

// THE BRIDGE BETWEEN THE WEB APP AND THE WIDGET.
//
// Two jobs, and the first one is the load-bearing one:
//
// 1. TOKEN HANDOFF. The widget and the tile run with no WebView, so they have no
//    Supabase session of their own. Every time the app is on screen this plugin
//    reads the session supabase-js has already persisted in the WebView's
//    localStorage and caches the access token where WaterSync can find it. That
//    is what turns a widget tap into a real row instead of a queued one.
//
//    It reads localStorage rather than being handed the token by a JS call on
//    purpose: no page module has to remember to call it, so a widget stays fed by
//    the user simply opening the app - including on pages this change does not
//    touch. The key is matched as /^sb-.+-auth-token$/ rather than being
//    hardcoded to the project ref, so pointing the app at another project (the
//    localStorage overrides in src/config.js) keeps working.
//
//    Only the ACCESS token is copied out. The refresh token is deliberately left
//    behind - see the long comment in WaterSync for why taking it would sign the
//    user out of the app.
//
// 2. NUMBERS BOTH WAYS. setToday() lets the app push the authoritative total into
//    the widget after a real read, and syncNow() lets quick-log.html flush
//    whatever the widget queued while the app was closed.
//
// UNTESTED ON HARDWARE.

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import org.json.JSONTokener

@CapacitorPlugin(name = "WaterWidget")
class WaterWidgetPlugin : Plugin() {

    // Reads localStorage and returns ONE JSON string, so the whole handoff is a
    // single WebView round trip. Wrapped in try/catch because localStorage throws
    // outright in some privacy modes, and a throw here would be reported to Kotlin
    // as the literal string "null" with no way to tell it from "no session".
    private val readSessionJs = """
        (function () {
          try {
            var out = { url: '', key: '', session: '' };
            try { out.url = localStorage.getItem('trackerz.supabase_url') || ''; } catch (e) {}
            try { out.key = localStorage.getItem('trackerz.supabase_anon_key') || ''; } catch (e) {}
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (k && /^sb-.+-auth-token${'$'}/.test(k)) { out.session = localStorage.getItem(k) || ''; break; }
            }
            return JSON.stringify(out);
          } catch (e) { return ''; }
        })()
    """.trimIndent()

    // ---------------------------------------------------------------- lifecycle

    override fun handleOnResume() {
        super.handleOnResume()
        // Every foregrounding re-caches a token good for roughly the next hour and
        // pays off anything the widget queued while the app was shut. This is why
        // "open Deno" is the honest fix the widget prints when it cannot sync.
        cacheSession { syncInBackground() }
    }

    override fun handleOnPause() {
        super.handleOnPause()
        // supabase-js auto-refreshes while the page is visible, so the token at
        // pause time is the freshest one this app will ever hold. Grab it on the
        // way out too - the resume copy could be an hour old by the time the user
        // leaves.
        cacheSession(null)
    }

    // ------------------------------------------------------------------ methods

    /**
     * status() -> { totalMl, goalMl, pendingMl, pendingCount, status, hasToken }.
     * What the widget currently believes, so a diagnostics screen can show it
     * without guessing.
     */
    @PluginMethod
    fun status(call: PluginCall) {
        val ctx = context
        val out = JSObject()
        out.put("totalMl", WaterStore.displayedMl(ctx))
        out.put("goalMl", WaterStore.goalMl(ctx))
        out.put("pendingMl", WaterStore.pendingMl(ctx))
        out.put("pendingCount", WaterStore.pendingCount(ctx))
        out.put("status", WaterStore.status(ctx))
        out.put("hasToken", WaterStore.tokenUsable(ctx))
        call.resolve(out)
    }

    /**
     * setToday({ ml, goalMl }) - the app handing the widget the authoritative
     * numbers after a real read. Resolves with what the widget will now display.
     */
    @PluginMethod
    fun setToday(call: PluginCall) {
        val ml = call.getInt("ml") ?: 0
        val goal = call.getInt("goalMl") ?: WaterStore.goalMl(context)
        WaterStore.setToday(context, ml, goal)
        WaterWidgetProvider.refreshAll(context)
        val out = JSObject()
        out.put("totalMl", WaterStore.displayedMl(context))
        out.put("goalMl", WaterStore.goalMl(context))
        call.resolve(out)
    }

    /**
     * syncNow() -> { ok, syncedMl, pendingMl, message }. Flush whatever the widget
     * or the tile queued while the app was closed. Never rejects on a normal
     * failure: "still queued, here is why" is an ANSWER, and rejecting would make
     * the page report a broken bridge instead of a waiting glass.
     */
    @PluginMethod
    fun syncNow(call: PluginCall) {
        val app = context.applicationContext
        Thread {
            val result = try {
                WaterSync.flush(app)
            } catch (err: Throwable) {
                WaterSync.Result(false, 0, WaterStore.pendingMl(app), err.message ?: "sync failed")
            }
            WaterWidgetProvider.refreshAll(app)
            val out = JSObject()
            out.put("ok", result.ok)
            out.put("syncedMl", result.syncedMl)
            out.put("pendingMl", result.pendingMl)
            out.put("message", result.message)
            call.resolve(out)
        }.start()
    }

    // ------------------------------------------------------------------ session

    private fun cacheSession(then: (() -> Unit)?) {
        try {
            // Bridge.eval, not webView.evaluateJavascript: eval already posts to
            // the main looper itself (Capacitor 6 Bridge.java), and
            // evaluateJavascript called off the UI thread throws instead of
            // returning a value. The callback therefore arrives on the main
            // thread, which is why `then` only ever starts a background thread and
            // never does the network work itself.
            val b = bridge ?: run { then?.invoke(); return }
            b.eval(readSessionJs) { raw ->
                applySessionJson(raw)
                then?.invoke()
            }
        } catch (_: Throwable) {
            // No WebView yet (very early in boot). The next resume retries; a
            // missing token only ever costs a delayed sync, never a lost tap.
            then?.invoke()
        }
    }

    private fun applySessionJson(raw: String?) {
        try {
            // evaluateJavascript hands back the value JSON-ENCODED, so a returned
            // JS string arrives wrapped in quotes and has to be decoded once
            // before it is itself parsed as JSON.
            val decoded = JSONTokener(raw ?: "").nextValue() as? String ?: return
            if (decoded.isBlank()) return
            val outer = JSONObject(decoded)

            val url = outer.optString("url", "").ifBlank { WaterSync.DEFAULT_SUPABASE_URL }
            val key = outer.optString("key", "").ifBlank { WaterSync.DEFAULT_SUPABASE_ANON_KEY }

            var sessionText = outer.optString("session", "")
            if (sessionText.isBlank()) {
                // Signed out. Drop the cached token so the widget says "open Deno"
                // instead of retrying a token that belongs to nobody.
                WaterStore.clearSession(context)
                return
            }
            // Future-proofing: newer @supabase/auth-js releases can store the
            // session as "base64-<payload>". 2.74.0 (the vendored copy) stores
            // plain JSON, but a silent format change here would look exactly like
            // "the widget stopped working" with nothing in any log.
            if (sessionText.startsWith("base64-")) {
                sessionText = String(
                    android.util.Base64.decode(sessionText.removePrefix("base64-"), android.util.Base64.DEFAULT),
                    Charsets.UTF_8
                )
            }
            val session = JSONObject(sessionText)
            val token = session.optString("access_token", "")
            val userId = session.optJSONObject("user")?.optString("id", "") ?: ""
            // expires_at is in SECONDS in the GoTrue payload. Reading it as
            // milliseconds would make every token look decades expired and the
            // widget would never sync once.
            val expiresAtMs = session.optLong("expires_at", 0L) * 1000L

            if (token.isBlank() || userId.isBlank() || expiresAtMs <= 0L) {
                WaterStore.clearSession(context)
                return
            }
            // A local test-mode session has a user id of "local:<email>", which
            // Postgres rejects as a uuid. Caching it would turn every widget tap
            // into a 400 the user can do nothing about.
            if (userId.startsWith("local:")) {
                WaterStore.clearSession(context)
                WaterStore.setStatus(context, "local test mode - not syncing")
                return
            }
            WaterStore.saveSession(context, url, key, token, expiresAtMs, userId)
        } catch (_: Throwable) {
            // A malformed session is the same as no session: keep the queue, keep
            // the old token if any, and let the next resume try again.
        }
    }

    private fun syncInBackground() {
        val app = context.applicationContext
        Thread {
            try { WaterSync.flush(app) } catch (_: Throwable) { /* stays queued */ }
            WaterWidgetProvider.refreshAll(app)
        }.start()
    }
}
