package com.ubhayaab.trackerz.upi

// Capacitor plugin that starts a UPI payment from inside the app via the standard
// upi:// deep link, then reports back whatever the UPI app returned.
//
// WHY THIS AND NOT A REAL INTEGRATION: becoming a payment processor / PSP needs
// NPCI onboarding and a licensed sponsor bank - impossible for a personal app. The
// upi:// intent is the sanctioned way for any app to HAND OFF a payment to the
// user's own UPI app (GPay/PhonePe/Paytm): it opens that app with the payee and
// amount prefilled, the user approves in their app, and control returns here.
//
// The app does NOT move money and never sees the user's bank credentials. It only
// launches the intent and records the result. The authoritative ledger entry still
// comes from the bank SMS (SmsReaderPlugin) - this just makes paying one tap away
// and lets the JS layer pre-log a confirmed payment with its txn reference so the
// SMS capture dedupes against it instead of double-counting.
//
// UNTESTED ON HARDWARE. UPI apps are inconsistent about what (if anything) they
// return per the NPCI spec, so the result is reported as a NAMED status the JS can
// reason about, never asserted as a guaranteed success.

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "UpiPay")
class UpiPayPlugin : Plugin() {

    companion object {
        const val ERR_BAD_ARGS = "invalid_args"
        const val ERR_NO_UPI_APP = "no_upi_app"
        const val ERR_LAUNCH_FAILED = "launch_failed"
    }

    /** availability() -> { supported }. True if any app can handle a upi:// intent. */
    @PluginMethod
    fun availability(call: PluginCall) {
        val out = JSObject()
        out.put("supported", canHandleUpi())
        out.put(
            "message",
            if (canHandleUpi()) "A UPI app is installed and can be launched."
            else "No UPI app (GPay/PhonePe/Paytm) is installed to hand the payment to."
        )
        call.resolve(out)
    }

    /**
     * pay({ pa, pn?, am, tn?, tr? }) launches the user's UPI app with the payment
     * prefilled and resolves once they return:
     *   pa = payee VPA (required), pn = payee name, am = amount (required),
     *   tn = transaction note, tr = an app-supplied reference to correlate later.
     * Resolves { status, txnRef, approvalRef, responseCode, raw } where status is
     * one of: success | failure | submitted | unknown | cancelled.
     */
    @PluginMethod
    fun pay(call: PluginCall) {
        val pa = call.getString("pa")?.trim().orEmpty()
        val am = call.getString("am")?.trim().orEmpty()
        if (pa.isEmpty() || am.isEmpty()) {
            call.reject("pa (payee VPA) and am (amount) are required.", ERR_BAD_ARGS)
            return
        }
        val builder = Uri.parse("upi://pay").buildUpon()
            .appendQueryParameter("pa", pa)
            .appendQueryParameter("am", am)
            .appendQueryParameter("cu", "INR")
        call.getString("pn")?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("pn", it) }
        call.getString("tn")?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("tn", it) }
        call.getString("tr")?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("tr", it) }

        val intent = Intent(Intent.ACTION_VIEW, builder.build())
        if (intent.resolveActivity(context.packageManager) == null) {
            call.reject("No UPI app is installed to complete the payment.", ERR_NO_UPI_APP)
            return
        }
        try {
            // A chooser (not a bare ACTION_VIEW) so the user picks GPay vs PhonePe
            // when several are installed, and so a default is not silently assumed.
            val chooser = Intent.createChooser(intent, "Pay with")
            startActivityForResult(call, chooser, "onUpiResult")
        } catch (err: Exception) {
            call.reject("Could not launch the UPI app: ${err.message ?: err.toString()}", ERR_LAUNCH_FAILED, err)
        }
    }

    @ActivityCallback
    private fun onUpiResult(call: PluginCall?, result: ActivityResult?) {
        if (call == null) return
        val out = JSObject()
        if (result == null || result.resultCode == Activity.RESULT_CANCELED) {
            out.put("status", "cancelled")
            out.put("raw", "")
            call.resolve(out)
            return
        }
        // UPI apps return a "response" extra like:
        //   txnId=...&responseCode=00&Status=SUCCESS&txnRef=...&approvalRefNo=...
        // Some return nothing at all - then we can only say "unknown".
        val raw = result.data?.getStringExtra("response").orEmpty()
        val fields = parseResponse(raw)
        val status = when (fields["status"]?.lowercase()) {
            "success" -> "success"
            "failure", "fail" -> "failure"
            "submitted", "pending" -> "submitted"
            else -> if (raw.isBlank()) "unknown" else "unknown"
        }
        out.put("status", status)
        out.put("txnRef", fields["txnref"] ?: fields["txnid"] ?: "")
        out.put("approvalRef", fields["approvalrefno"] ?: "")
        out.put("responseCode", fields["responsecode"] ?: "")
        out.put("raw", raw)
        call.resolve(out)
    }

    /** Parse "a=b&c=d" into a lowercased-key map, tolerant of blanks. */
    private fun parseResponse(raw: String): Map<String, String> {
        if (raw.isBlank()) return emptyMap()
        return raw.split("&").mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else it.substring(0, i).trim().lowercase() to it.substring(i + 1).trim()
        }.toMap()
    }

    private fun canHandleUpi(): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("upi://pay"))
        return intent.resolveActivity(context.packageManager) != null
    }
}
