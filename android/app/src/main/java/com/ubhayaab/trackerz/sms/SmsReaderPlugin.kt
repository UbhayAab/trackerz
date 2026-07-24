package com.ubhayaab.trackerz.sms

// Capacitor plugin that exposes the phone's SMS inbox + live incoming SMS to the
// Trackerz web app, so a bank/UPI transaction text ("Rs 250 debited... UPI") can
// become an expense with zero typing.
//
// WHY THIS EXISTS: there is no public GPay/UPI "read my transactions" API. The one
// thing every UPI payment DOES produce, regardless of which app sent it, is a bank
// SMS on this phone. Reading those SMS is the only device-side way to auto-capture
// spend. The parsing lives in JS (src/imports/sms-parser.js); this file is only the
// bridge that hands raw SMS text to it.
//
// UNTESTED ON HARDWARE. Nobody who wrote this has an Android phone. It compiles
// against the documented Telephony + ContentResolver surface and every failure
// path returns a NAMED state rather than a silent empty, but on-device behaviour
// (which addresses the carrier uses, how multipart SMS arrive) has never been seen.
//
// SCOPE (v1): backfill the recent inbox on demand (readRecent) and forward live
// SMS while the app is open (smsReceived event, via a runtime-registered receiver).
// Background delivery while the app is CLOSED would need a manifest receiver and is
// deliberately out of scope - the realistic flow is "open the app, spend syncs".
//
// PLAY NOTE: READ_SMS/RECEIVE_SMS are restricted permissions. This is a personal,
// debug-signed, sideloaded APK, so that restriction does not apply. A Play listing
// would need the SMS-permissions declaration form or a different capture route.

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.time.Instant

@CapacitorPlugin(
    name = "SmsReader",
    permissions = [
        Permission(alias = SmsReaderPlugin.SMS_ALIAS, strings = [Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS])
    ]
)
class SmsReaderPlugin : Plugin() {

    companion object {
        const val SMS_ALIAS = "sms"

        // reject() error codes - the JS side switches on these exact strings.
        const val ERR_PERMISSION_DENIED = "permission_denied"
        const val ERR_READ_FAILED = "read_failed"
        const val ERR_UNSUPPORTED = "unsupported"

        // The event JS listens on for a live incoming SMS.
        const val EVENT_SMS = "smsReceived"
    }

    private var receiver: BroadcastReceiver? = null

    // ---------------------------------------------------------------- lifecycle

    override fun load() {
        // A runtime receiver only fires while the app process is alive - exactly the
        // "app is open" scope this plugin promises. Registered once; torn down in
        // handleOnDestroy so we never leak it.
        val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                if (intent == null) return
                if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
                try {
                    // A single SMS can arrive as several PDUs (multipart). Concatenate
                    // the bodies of parts from the same sender into one message.
                    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
                    if (parts.isEmpty()) return
                    val address = parts[0].originatingAddress ?: ""
                    val body = parts.joinToString("") { it.messageBody ?: "" }
                    val whenMs = parts[0].timestampMillis
                    val out = JSObject()
                    out.put("address", address)
                    out.put("body", body)
                    out.put("dateIso", Instant.ofEpochMilli(whenMs).toString())
                    notifyListeners(EVENT_SMS, out)
                } catch (_: Throwable) {
                    // A malformed broadcast must never crash the host app. A dropped
                    // live SMS is recovered by the next readRecent backfill anyway.
                }
            }
        }
        // RECEIVER_NOT_EXPORTED: this receiver is for the platform's own broadcast,
        // never for other apps. ContextCompat version-gates the flag - the raw
        // 3-arg registerReceiver(receiver, filter, int) only exists on API 33+ and
        // would crash on older devices, so never call it directly.
        try {
            ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        } catch (_: Throwable) {
            receiver = null // registration failed; readRecent still works.
        }
    }

    override fun handleOnDestroy() {
        receiver?.let { try { context.unregisterReceiver(it) } catch (_: Throwable) {} }
        receiver = null
        super.handleOnDestroy()
    }

    // ---------------------------------------------------------------- availability

    /** availability() -> { supported, message }. Devices without telephony (tablets) say so. */
    @PluginMethod
    fun availability(call: PluginCall) {
        val hasTelephony = context.packageManager.hasSystemFeature("android.hardware.telephony")
        val out = JSObject()
        out.put("supported", hasTelephony)
        out.put(
            "message",
            if (hasTelephony) "This device can read SMS."
            else "This device has no telephony hardware, so there are no SMS to read."
        )
        call.resolve(out)
    }

    // ---------------------------------------------------------------- permissions

    /**
     * requestSmsPermission() -> { outcome }. outcome is granted | denied. Resolves
     * in every non-crash case (a denial is an answer, not an error) so the UI can
     * tell "you tapped Deny" apart from "something broke".
     */
    @PluginMethod
    fun requestSmsPermission(call: PluginCall) {
        if (getPermissionState(SMS_ALIAS) == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve(permissionResult("granted"))
            return
        }
        requestPermissionForAlias(SMS_ALIAS, call, "smsPermCallback")
    }

    @PermissionCallback
    private fun smsPermCallback(call: PluginCall) {
        val granted = getPermissionState(SMS_ALIAS) == com.getcapacitor.PermissionState.GRANTED
        call.resolve(permissionResult(if (granted) "granted" else "denied"))
    }

    /** checkSmsPermission() -> { outcome }, no UI. */
    @PluginMethod
    fun checkSmsPermission(call: PluginCall) {
        val granted = getPermissionState(SMS_ALIAS) == com.getcapacitor.PermissionState.GRANTED
        call.resolve(permissionResult(if (granted) "granted" else "denied"))
    }

    private fun permissionResult(outcome: String): JSObject {
        val out = JSObject()
        out.put("outcome", outcome)
        out.put("granted", outcome == "granted")
        out.put(
            "message",
            when (outcome) {
                "granted" -> "SMS permission granted."
                else -> "SMS permission denied. Nothing can be read until it is granted."
            }
        )
        return out
    }

    // ---------------------------------------------------------------- read inbox

    /**
     * readRecent({ sinceIso?, days?, limit? }) -> { messages:[{ id, address, body,
     * dateIso }], count }. Reads the SMS inbox for the given window (default: last 14
     * days, cap 500 rows). All parsing/filtering happens in JS; this returns raw text.
     */
    @PluginMethod
    fun readRecent(call: PluginCall) {
        if (getPermissionState(SMS_ALIAS) != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("SMS permission has not been granted, so nothing was read.", ERR_PERMISSION_DENIED)
            return
        }
        val sinceMs = resolveSince(call)
        val limit = (call.getInt("limit") ?: 500).coerceIn(1, 2000)

        try {
            val messages = JSArray()
            val uri = Telephony.Sms.Inbox.CONTENT_URI
            val cols = arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
            // date > ? , newest first, capped by LIMIT in the sort clause.
            val selection = "${Telephony.Sms.DATE} > ?"
            val args = arrayOf(sinceMs.toString())
            val order = "${Telephony.Sms.DATE} DESC LIMIT $limit"
            context.contentResolver.query(uri, cols, selection, args, order)?.use { c ->
                val iId = c.getColumnIndex(Telephony.Sms._ID)
                val iAddr = c.getColumnIndex(Telephony.Sms.ADDRESS)
                val iBody = c.getColumnIndex(Telephony.Sms.BODY)
                val iDate = c.getColumnIndex(Telephony.Sms.DATE)
                while (c.moveToNext()) {
                    val item = JSObject()
                    item.put("id", if (iId >= 0) c.getString(iId) else "")
                    item.put("address", if (iAddr >= 0) c.getString(iAddr) ?: "" else "")
                    item.put("body", if (iBody >= 0) c.getString(iBody) ?: "" else "")
                    val ms = if (iDate >= 0) c.getLong(iDate) else 0L
                    item.put("dateIso", Instant.ofEpochMilli(ms).toString())
                    messages.put(item)
                }
            }
            val out = JSObject()
            out.put("messages", messages)
            out.put("count", messages.length())
            call.resolve(out)
        } catch (err: SecurityException) {
            call.reject("SMS read refused: ${err.message ?: "permission denied"}", ERR_PERMISSION_DENIED, err)
        } catch (err: Exception) {
            call.reject("SMS read failed: ${err.message ?: err.toString()}", ERR_READ_FAILED, err)
        }
    }

    /** Default window: 14 days back. Accepts an explicit sinceIso or a days count. */
    private fun resolveSince(call: PluginCall): Long {
        call.getString("sinceIso")?.let { raw ->
            try { return Instant.parse(raw).toEpochMilli() } catch (_: Throwable) {}
        }
        val days = (call.getInt("days") ?: 14).coerceIn(1, 365)
        return System.currentTimeMillis() - days.toLong() * 24L * 3600L * 1000L
    }
}
