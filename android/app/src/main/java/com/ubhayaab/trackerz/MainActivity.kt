package com.ubhayaab.trackerz

// Capacitor host activity. Renders the SAME web app the repo already ships - the
// files copied into android/app/src/main/assets/public by `npx cap copy`. No
// fork, no second UI.
//
// The ONLY thing this adds over Capacitor's generated stub (the MainActivity.java
// that `cap add android` writes) is registerPlugin(): app-local plugins are not
// auto-discovered, so without this line window.Capacitor.Plugins.HealthConnect is
// undefined and src/services/health-sync.js correctly falls back to "browser /
// no bridge". Registering here is what makes the bridge real.
//
// IMPORTANT: this Kotlin file REPLACES the generated MainActivity.java. If both
// exist the build fails on a duplicate class. `cap add`/`cap sync` may re-create
// the .java stub - if it comes back, delete it and keep this one.
//
// UNTESTED ON HARDWARE.

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import com.getcapacitor.BridgeActivity
import com.ubhayaab.trackerz.health.HealthConnectPlugin
import com.ubhayaab.trackerz.sms.SmsReaderPlugin
import com.ubhayaab.trackerz.notify.NotifyReaderPlugin
import com.ubhayaab.trackerz.water.WaterWidgetPlugin
import com.ubhayaab.trackerz.speech.SpeechPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate(): the bridge is constructed there and only
        // exposes plugins registered by that point.
        registerPlugin(HealthConnectPlugin::class.java)
        registerPlugin(SmsReaderPlugin::class.java)
        registerPlugin(NotifyReaderPlugin::class.java)
        // WaterWidget is registered for its LIFECYCLE, not only for the two
        // methods quick-log.html calls: its handleOnResume/handleOnPause copy the
        // signed-in access token out of the WebView so the home-screen widget and
        // the Quick Settings tile can write to Supabase while the app is closed.
        // Without this line the widget still never loses a tap - it just queues
        // every one of them until someone opens the app.
        registerPlugin(WaterWidgetPlugin::class.java)
        // Native dictation. The Web Speech API does not exist in an Android
        // WebView at all, so without this the app has no live transcription -
        // only record-and-upload, which is slower and was silently producing
        // nothing until the WAV conversion landed.
        registerPlugin(SpeechPlugin::class.java)
        super.onCreate(savedInstanceState)
        handOffDownloadsToTheBrowser()
    }

    /**
     * WHY THE APK DOWNLOAD LINK DID NOTHING INSIDE THE APP.
     *
     * An Android WebView with no DownloadListener SILENTLY DISCARDS any
     * navigation that turns out to be a download. GitHub serves release assets
     * with `Content-Disposition: attachment`, so tapping "Download the Android
     * app" - or the update banner's "Install 1.0.48" - inside the installed app
     * produced no download, no error, no progress, nothing at all. There is no
     * exception to catch and no console message; the tap just does not happen.
     *
     * The evidence: builds 1.0.46 and 1.0.47 have downloads against them, both
     * fetched while he was still on the web app. 1.0.48 - published 2026-08-08
     * and linked from exactly the same two places - has ZERO, on both the
     * versioned asset and the floating trackerz.apk. The request never left the
     * phone. The link is fine: it answers 200 with a valid, correctly-signed zip.
     *
     * So hand every download to the system browser, which has the notification,
     * the progress bar and the "Open" button that install an APK. This is the
     * same reasoning as the target="_blank" note in src/ui/apk-link.js - that fix
     * addressed the PWA custom-tab trap and could not have helped here, because
     * inside the APK the navigation never becomes a request in the first place.
     *
     * Deliberately generic: it fixes every download the app will ever offer (a
     * CSV export, a statement, a backup), not just the APK.
     */
    private fun handOffDownloadsToTheBrowser() {
        val webView = bridge?.webView ?: return
        webView.setDownloadListener { url, _, _, _, _ ->
            try {
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: ActivityNotFoundException) {
                // Say it out loud. A download that cannot be handed anywhere is
                // the exact failure this method exists to stop being silent.
                Toast.makeText(this, "No app on this phone can open that download.", Toast.LENGTH_LONG).show()
            }
        }
    }
}
