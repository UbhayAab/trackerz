package com.ubhayaab.trackerz.water

// THE HOME-SCREEN WIDGET. "Whenever I tap on, it logs water", without the app.
//
// One big tap target that adds 250 ml, a number that moves on that tap, and a
// status line that is the honest half of the deal: it says "queued" when the
// water is only on the phone and "synced" when it is in the account. A widget
// that always looked happy would be worse than no widget, because you would
// believe it.
//
// THE TAP IS NOT A NETWORK CALL. onReceive appends to WaterStore (a synchronous
// commit) and repaints immediately, then hands the send to a background thread
// held open by goAsync(). Six taps in six seconds are six rows, because nothing
// in the tap path can be busy - the same rule lib/water.mjs enforces for the
// in-app button after a burst of taps once logged a single glass.
//
// Two tap targets, deliberately:
//   - the whole card logs 250 ml;
//   - the status line at the bottom opens quick-log.html?do=sync, which is the
//     escape hatch when the widget says "open Deno to sync". It syncs and does
//     NOT log another glass; opening ?do=water there would pour a phantom one.
//
// UNTESTED ON HARDWARE.

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import com.ubhayaab.trackerz.R

class WaterWidgetProvider : AppWidgetProvider() {

    companion object {
        // Namespaced with the applicationId so it can never collide with another
        // app's broadcast on the same device.
        const val ACTION_LOG = "com.ubhayaab.trackerz.water.LOG"
        const val EXTRA_ML = "ml"

        /**
         * Repaint every instance of the widget from whatever WaterStore holds.
         * Called after a tap, after a sync, and by the app through
         * WaterWidgetPlugin.setToday - so there is exactly one drawing routine and
         * the number cannot differ between the paths that update it.
         */
        fun refreshAll(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx) ?: return
            val ids = try {
                manager.getAppWidgetIds(ComponentName(ctx, WaterWidgetProvider::class.java))
            } catch (_: Throwable) {
                return
            }
            for (id in ids) manager.updateAppWidget(id, buildViews(ctx))
        }

        private fun buildViews(ctx: Context): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget_water)
            val total = WaterStore.displayedMl(ctx)
            val goal = WaterStore.goalMl(ctx)

            views.setTextViewText(R.id.widgetWaterTotal, fmtMl(total))
            views.setTextViewText(R.id.widgetWaterGoal, "of ${fmtMl(goal)}")
            // pctOf can never return NaN or Infinity, whatever the goal is - the
            // web meter shipped `width:Infinity%` once when a goal of 0 got saved.
            views.setProgressBar(R.id.widgetWaterMeter, 100, WaterStore.pctOf(total, goal), false)
            views.setTextViewText(R.id.widgetWaterStatus, WaterStore.status(ctx))

            // Tap the card -> log a glass.
            views.setOnClickPendingIntent(R.id.widgetWaterTap, logIntent(ctx))
            // Tap the status line -> open the app's quick-log page in sync mode.
            views.setOnClickPendingIntent(R.id.widgetWaterStatus, openSyncIntent(ctx))
            return views
        }

        /** "250ml" / "1.5L" - the Kotlin twin of fmtMl() in lib/water.mjs. */
        fun fmtMl(ml: Int): String {
            if (Math.abs(ml) < 1000) return "${ml}ml"
            val litres = ml / 1000.0
            val text = String.format(java.util.Locale.US, "%.1f", litres)
            return (if (text.endsWith(".0")) text.dropLast(2) else text) + "L"
        }

        private fun logIntent(ctx: Context): PendingIntent {
            val intent = Intent(ctx, WaterWidgetProvider::class.java).apply {
                action = ACTION_LOG
                putExtra(EXTRA_ML, WaterStore.TAP_ML)
            }
            // FLAG_IMMUTABLE is mandatory from Android 12 (S): a mutable
            // PendingIntent with no component check is refused outright, and the
            // widget would simply do nothing on tap with no error anywhere.
            return PendingIntent.getBroadcast(
                ctx, 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun openSyncIntent(ctx: Context): PendingIntent {
            // Deep-links into the Capacitor WebView. The app is served from
            // https://localhost by capacitor.config.json (server.androidScheme),
            // so this is the same quick-log.html the PWA shortcut opens.
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://localhost/quick-log.html?do=sync")).apply {
                setPackage(ctx.packageName)
                setClassName(ctx.packageName, "com.ubhayaab.trackerz.MainActivity")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            return PendingIntent.getActivity(
                ctx, 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }

    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, buildViews(ctx))
        // A freshly placed widget shows a stale number until something syncs, so
        // ask once. goAsync because onUpdate arrives inside a broadcast: without
        // it the process can be reaped mid-request and the widget sits on
        // yesterday's number with no explanation. It returns null if we are ever
        // called outside a broadcast, hence the safe call - a lost PendingResult
        // would NPE inside a thread nothing is watching.
        val pending = goAsync()
        syncInBackground(ctx) { pending?.finish() }
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action != ACTION_LOG) return

        // STEP 1: the tap is a fact. Committed to disk and on screen before
        // anything that can fail is attempted.
        val ml = intent.getIntExtra(EXTRA_ML, WaterStore.TAP_ML)
        WaterStore.addTap(ctx, ml)
        WaterStore.setStatus(ctx, "saving…")
        refreshAll(ctx)

        // STEP 2: best effort. goAsync keeps this receiver alive past onReceive so
        // the request is not killed halfway; the failure path is a queued tap and
        // a status line, never a lost glass.
        val pending = goAsync()
        syncInBackground(ctx) { pending?.finish() }
    }

    private fun syncInBackground(ctx: Context, onDone: (() -> Unit)?) {
        val app = ctx.applicationContext
        Thread {
            try {
                WaterSync.flush(app)
            } catch (_: Throwable) {
                WaterStore.setStatus(app, "sync failed - still queued")
            } finally {
                refreshAll(app)
                onDone?.invoke()
            }
        }.start()
    }
}
