package com.ubhayaab.trackerz.notify

// Capacitor plugin that lets the web app (1) check whether notification access is
// granted, (2) open the settings screen to grant it, and (3) drain the buffered
// payment notifications that PaymentNotificationListenerService collected.
//
// Drain-based (not a live event stream): the listener buffers durably to
// SharedPreferences, so draining on app open + on resume recovers every payment
// notification, including ones posted while the WebView was closed. Nothing is lost
// to a missed live event.
//
// UNTESTED ON HARDWARE.

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import org.json.JSONArray

@com.getcapacitor.annotation.CapacitorPlugin(name = "NotifyReader")
class NotifyReaderPlugin : Plugin() {

    /** isEnabled() -> { enabled }. True when the user has granted notification access. */
    @PluginMethod
    fun isEnabled(call: PluginCall) {
        val out = JSObject()
        out.put("enabled", isListenerEnabled())
        call.resolve(out)
    }

    /**
     * openSettings() opens the system "notification access" screen so the user can
     * toggle Trackerz on. There is no runtime-permission dialog for this - it is a
     * dedicated Settings page. Resolves once the intent is launched.
     */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (err: Exception) {
            call.reject("Could not open notification-access settings: ${err.message ?: err.toString()}")
        }
    }

    /**
     * drain() -> { notifications:[{ package, title, text, body, trusted, dateIso }],
     * count }. Returns and clears the buffered financial notifications.
     */
    @PluginMethod
    fun drain(call: PluginCall) {
        val raw = PaymentNotificationListenerService.drain(context)
        val notifications = JSArray()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val item = JSObject()
                item.put("package", o.optString("package"))
                item.put("title", o.optString("title"))
                item.put("text", o.optString("text"))
                item.put("body", o.optString("body"))
                item.put("trusted", o.optBoolean("trusted", false))
                item.put("dateIso", java.time.Instant.ofEpochMilli(o.optLong("ts", 0L)).toString())
                notifications.put(item)
            }
        } catch (_: Throwable) {
            // A corrupt buffer resolves empty rather than throwing - the next drain
            // starts clean (the buffer was already cleared).
        }
        val out = JSObject()
        out.put("notifications", notifications)
        out.put("count", notifications.length())
        call.resolve(out)
    }

    private fun isListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(context, PaymentNotificationListenerService::class.java)
        // The setting is a colon-separated list of flattened ComponentNames.
        return flat.split(":").any {
            val cn = ComponentName.unflattenFromString(it)
            cn != null && cn.packageName == me.packageName
        }
    }
}
