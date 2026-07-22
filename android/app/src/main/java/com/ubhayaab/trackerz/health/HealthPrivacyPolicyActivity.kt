package com.ubhayaab.trackerz.health

// Health Connect REQUIRES a reachable privacy-policy screen before it will show
// the permission sheet. Two entry points hit this activity:
//
//   Android 13 and lower - the Health Connect APK sends the intent action
//     androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE
//   Android 14 and up   - the platform sends
//     android.intent.action.VIEW_PERMISSION_USAGE
//     with category android.intent.category.HEALTH_PERMISSIONS
//
// Both are declared in AndroidManifest.xml pointing here. If this screen is
// missing the permission request silently fails, which looks exactly like the
// user denying it - the kind of ambiguity this whole app is being repaired to
// remove.
//
// The text is built in code rather than an XML layout so this activity has no
// res/ dependencies and cannot be broken by a regenerated resource folder.
//
// UNTESTED ON HARDWARE.

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class HealthPrivacyPolicyActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.START
            setBackgroundColor(Color.parseColor("#0b0f14"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        column.addView(heading("Trackerz and your health data"))
        for (paragraph in BODY) column.addView(body(paragraph))

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0b0f14"))
            addView(column)
        })
    }

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 22f
        setTextColor(Color.WHITE)
        setPadding(0, 0, 0, (12 * resources.displayMetrics.density).toInt())
    }

    private fun body(text: String) = TextView(this).apply {
        this.text = text
        textSize = 15f
        setTextColor(Color.parseColor("#c7d2de"))
        setPadding(0, 0, 0, (12 * resources.displayMetrics.density).toInt())
    }

    private companion object {
        val BODY = listOf(
            "What is read: sleep sessions, daily step totals, hydration, calories burned and " +
                "heart-rate summaries - read only. Trackerz never writes anything back into " +
                "Health Connect and never deletes anything there.",

            "When it is read: only while you have the app open and only when you tap Sync in " +
                "Settings. There is no background collection.",

            "Where it goes: into your own Trackerz account in your own Supabase database, under " +
                "your user id, protected by row-level security. Sleep rows are tagged " +
                "source='healthconnect' so you can always tell watch-derived data from what you " +
                "logged by hand, and delete it separately.",

            "Who else sees it: nobody. There is no analytics SDK, no ad SDK, and health data is " +
                "never sent to any AI model or third party.",

            "If a permission is denied, or Health Connect has no data for a day, Trackerz records " +
                "nothing for that day. It will never store a zero on your behalf.",

            "Revoking access: Health Connect > App permissions > Trackerz. Revoking stops all " +
                "future reads immediately; already-synced rows stay in your database until you " +
                "delete them from Settings."
        )
    }
}
