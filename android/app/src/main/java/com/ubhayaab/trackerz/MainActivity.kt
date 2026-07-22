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

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate(): the bridge is constructed there and only
        // exposes plugins registered by that point.
        registerPlugin(HealthConnectPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
