package com.ubhayaab.trackerz.water

// QUICK SETTINGS TILE. The same 250 ml, one drag and one tap from any screen,
// including the lock screen shade - closer to hand than the home screen widget
// when the phone is already in use.
//
// It shares WaterStore and WaterSync with the widget, so tapping the tile and
// tapping the widget are literally the same write. The tile's subtitle carries
// today's total and, when something is queued, says so - a tile that always read
// "Water" would tell the user nothing about whether the tap worked.
//
// TileService is API 24+; this module's minSdk is 26 (see android/variables.gradle),
// so no version guard is needed for the class itself. `subtitle` however is API 29+
// and is set behind a guard - on older devices the label carries the number instead,
// rather than silently dropping it.
//
// UNTESTED ON HARDWARE.

import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.ubhayaab.trackerz.R

class WaterTileService : TileService() {

    // Tile.updateTile() belongs to the main thread. The sync runs on a background
    // thread, so its repaint has to come back here rather than touching the tile
    // from wherever the network happened to finish.
    private val main = Handler(Looper.getMainLooper())

    override fun onStartListening() {
        super.onStartListening()
        paint()
    }

    override fun onClick() {
        super.onClick()
        // Step 1: the tap is a fact, committed before anything that can fail.
        WaterStore.addTap(applicationContext, WaterStore.TAP_ML)
        WaterStore.setStatus(applicationContext, "saving…")
        paint()

        // Step 2: best effort, off the main thread. A tile click gets no goAsync,
        // so the service is kept alive only as long as the system feels like -
        // which is exactly why the tap was written to disk first.
        val app = applicationContext
        Thread {
            try {
                WaterSync.flush(app)
            } catch (_: Throwable) {
                WaterStore.setStatus(app, "sync failed - still queued")
            } finally {
                WaterWidgetProvider.refreshAll(app)
                // Back to the main thread. The tile may also already be gone (the
                // shade was closed), which is why paint() returns early on a null
                // qsTile rather than assuming one is there.
                main.post { try { paint() } catch (_: Throwable) {} }
            }
        }.start()
    }

    private fun paint() {
        val tile: Tile = qsTile ?: return
        val ctx = applicationContext
        val total = WaterStore.displayedMl(ctx)
        val waiting = WaterStore.pendingCount(ctx)

        tile.state = Tile.STATE_ACTIVE
        tile.icon = Icon.createWithResource(ctx, R.drawable.ic_water_drop)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.label = "Water +${WaterStore.TAP_ML}ml"
            tile.subtitle = if (waiting > 0) "${WaterWidgetProvider.fmtMl(total)} · $waiting waiting" else WaterWidgetProvider.fmtMl(total)
        } else {
            // Pre-Q has no subtitle, so the number goes in the label. Better a
            // cramped tile than a tile that hides whether the tap counted.
            tile.label = "Water ${WaterWidgetProvider.fmtMl(total)}"
        }
        tile.updateTile()
    }
}
