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

import android.os.Bundle
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
    }
}
