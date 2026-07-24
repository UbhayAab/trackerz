package com.ubhayaab.trackerz.notify

// Passive spend capture, the first-principles way: the user NEVER changes how they
// pay. Whether they pay from the Zepto app (which opens GPay), a website on their
// laptop, an in-store UPI QR, or a card swipe, the payment lands as a NOTIFICATION
// on this phone - a GPay/PhonePe "You paid Rs 250 to Zepto", or a bank-app alert.
// This service listens for those notifications and buffers the financial ones for
// the web app to turn into expenses. The user does nothing.
//
// WHY A LISTENER SERVICE (not a plugin): NotificationListenerService is a system
// service the OS binds after the user grants "notification access" in Settings. It
// is the only way to read notifications from OTHER apps. It runs in our process but
// independently of the WebView, so it buffers to SharedPreferences (durable across
// process death); NotifyReaderPlugin drains that buffer when the web app is up.
//
// PRIVACY: only notifications that look like a transaction (an amount + a
// debit/credit word, and either a known UPI app or a banking word) are buffered.
// Everything else - chats, news, OTPs - is ignored and never stored or sent.
//
// UNTESTED ON HARDWARE.

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

class PaymentNotificationListenerService : NotificationListenerService() {

    companion object {
        const val PREFS = "trackerz_notify_buffer"
        const val KEY_BUFFER = "buffer"
        const val MAX_BUFFER = 300
        private val LOCK = Any()

        // Pure P2P/merchant UPI apps - a notification from one of these is TRUSTED
        // (a bare "paid Rs X to Y" is a real payment, no banking word required).
        // Deliberately EXCLUDES CRED/Freecharge/BharatPe: their notifications are
        // credit-card-bill payments and wallet loads, which would double-count the
        // underlying card swipes / wallet spend. Those pass only if they also carry a
        // banking word, and cc_bill text is dropped downstream anyway.
        val UPI_PACKAGES: Set<String> = setOf(
            "com.google.android.apps.nbu.paisa.user", // Google Pay
            "com.phonepe.app",                        // PhonePe
            "net.one97.paytm",                        // Paytm
            "in.org.npci.upiapp"                      // BHIM
        )

        private val AMOUNT = Regex("(?:rs|inr|₹)\\.?\\s*[\\d,]+(?:\\.\\d{1,2})?", RegexOption.IGNORE_CASE)
        private val DIRECTION = Regex("\\b(debit(?:ed)?|spent|paid|sent|purchase|credit(?:ed)?|received|refund(?:ed)?)\\b", RegexOption.IGNORE_CASE)
        private val BANKWORD = Regex("\\b(a/c|ac|account|card|upi|bank|bal|txn|wallet)\\b", RegexOption.IGNORE_CASE)

        /** Read and clear the buffer. Returns a JSON array string of {package,title,text,ts}. */
        fun drain(context: Context): String {
            synchronized(LOCK) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val raw = prefs.getString(KEY_BUFFER, "[]") ?: "[]"
                prefs.edit().putString(KEY_BUFFER, "[]").apply()
                return raw
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        try {
            val pkg = sbn.packageName ?: return
            val extras = sbn.notification?.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val textShort = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val textBig = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val text = if (textBig.isNotBlank()) textBig else textShort
            val body = listOf(title, text).filter { it.isNotBlank() }.joinToString(" - ")
            if (body.isBlank()) return

            val isUpiApp = pkg in UPI_PACKAGES
            // Buffer ONLY financial-looking notifications: an amount + a direction
            // word, and (from a UPI app) OR (has a banking word). This drops chats,
            // news and OTP notifications before anything is stored.
            val financial = AMOUNT.containsMatchIn(body) && DIRECTION.containsMatchIn(body) &&
                (isUpiApp || BANKWORD.containsMatchIn(body))
            if (!financial) return

            val item = JSONObject()
            item.put("package", pkg)
            item.put("title", title)
            item.put("text", text)
            item.put("body", body)
            item.put("trusted", isUpiApp)
            item.put("ts", sbn.postTime)
            append(item)
        } catch (_: Throwable) {
            // A bad notification must never crash the listener. The next payment is
            // still captured; a lost one is recovered by nothing here, but this path
            // is best-effort by design.
        }
    }

    private fun append(item: JSONObject) {
        synchronized(LOCK) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try { JSONArray(prefs.getString(KEY_BUFFER, "[]")) } catch (_: Throwable) { JSONArray() }
            arr.put(item)
            // Cap the buffer so a long offline stretch cannot grow it without bound;
            // drop the oldest entries first.
            val trimmed = if (arr.length() > MAX_BUFFER) {
                val out = JSONArray()
                for (i in (arr.length() - MAX_BUFFER) until arr.length()) out.put(arr.get(i))
                out
            } else arr
            prefs.edit().putString(KEY_BUFFER, trimmed.toString()).apply()
        }
    }
}
