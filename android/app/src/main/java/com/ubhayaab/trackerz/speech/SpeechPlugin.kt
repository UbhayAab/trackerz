package com.ubhayaab.trackerz.speech

// Native dictation for the Android app.
//
// WHY THIS EXISTS: the Web Speech API does not exist in an Android WebView. It is
// a Chrome-the-browser feature, not a WebView feature, so inside the APK
// `window.SpeechRecognition` and `window.webkitSpeechRecognition` are both
// undefined and `isLiveTranscriptionSupported()` returns false. The app therefore
// fell back to recording audio and transcribing it server-side, which is slower
// and - until the WAV conversion landed - silently produced nothing at all,
// because the recorder's default container (audio/webm) is not a format the
// transcription API accepts.
//
// So on the phone, the one place voice matters most, there was no live text.
// SpeechRecognizer is the platform's own recogniser: it gives partial results as
// you speak, it works with the on-device language pack when one is installed, and
// it costs nothing.
//
// UNTESTED ON HARDWARE. This compiles against the documented SpeechRecognizer
// surface and every failure path returns a NAMED code rather than a silent empty,
// but on-device behaviour (which recogniser the OEM ships, how it handles Indian
// English) has never been observed.
//
// MANIFEST REQUIREMENTS, all of which are already in place:
//   - android.permission.RECORD_AUDIO      (without it the request is denied
//     instantly, with no dialog, and getUserMedia/SpeechRecognizer both fail)
//   - android.permission.MODIFY_AUDIO_SETTINGS
//   - <queries><intent><action android:name="android.speech.RecognitionService"/>
//     On API 30+ an app cannot SEE the recogniser package without this, so
//     isRecognitionAvailable() returns false on a phone that supports it fine.

import android.Manifest
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "Speech",
    permissions = [
        Permission(alias = SpeechPlugin.MIC_ALIAS, strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class SpeechPlugin : Plugin() {

    companion object {
        const val MIC_ALIAS = "mic"

        // reject() codes - the JS side switches on these exact strings, so they
        // are part of the contract and must not be reworded casually.
        const val ERR_PERMISSION_DENIED = "permission_denied"
        const val ERR_UNAVAILABLE = "unavailable"
        const val ERR_BUSY = "busy"
        const val ERR_START_FAILED = "start_failed"

        // Events the web layer listens on.
        const val EV_PARTIAL = "speechPartial"
        const val EV_FINAL = "speechFinal"
        const val EV_ERROR = "speechError"
        const val EV_STATE = "speechState"
    }

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    // Text from PREVIOUS recognition sessions in this dictation. Android ends a
    // session at every pause, so a long sentence arrives as several sessions; the
    // web layer expects one growing transcript, not a series of fragments.
    private var committed = ""

    // The newest partial hypothesis, which is ALWAYS ahead of `committed` while a
    // sentence is still being spoken. stop() used to resolve with `committed`
    // alone, so tapping Stop mid-sentence returned the transcript as it was at
    // the last pause and the words since were simply gone. Keeping the partial
    // means the stop result is never behind what the user watched appear.
    private var lastPartial = ""

    // The language this dictation was started with. restart() used to omit it,
    // so the second and every later segment of a long sentence was recognised
    // with the device default rather than en-IN.
    private var currentLang = "en-IN"

    /** Is there a usable recogniser on this device at all? */
    @PluginMethod
    fun available(call: PluginCall) {
        val ok = try {
            SpeechRecognizer.isRecognitionAvailable(context)
        } catch (e: Exception) {
            false
        }
        val ret = JSObject()
        ret.put("available", ok)
        // Say WHY when it is false, so the web layer can show something better
        // than a disabled button with no explanation.
        ret.put("reason", if (ok) "" else "no recognition service visible to this app")
        call.resolve(ret)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState(MIC_ALIAS) != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias(MIC_ALIAS, call, "micPermissionCallback")
            return
        }
        beginListening(call)
    }

    @PermissionCallback
    private fun micPermissionCallback(call: PluginCall) {
        if (getPermissionState(MIC_ALIAS) != com.getcapacitor.PermissionState.GRANTED) {
            // A denial is a NAMED state, not an empty result. The web layer shows
            // a struck-mic button and a route into app settings; reporting this as
            // a generic failure is what made a blocked mic look like a broken app.
            call.reject("Microphone permission denied", ERR_PERMISSION_DENIED)
            return
        }
        beginListening(call)
    }

    private fun beginListening(call: PluginCall) {
        if (listening) {
            call.reject("Already listening", ERR_BUSY)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            call.reject("No speech recognition on this device", ERR_UNAVAILABLE)
            return
        }
        val lang = call.getString("lang") ?: "en-IN"
        committed = ""
        lastPartial = ""
        currentLang = lang

        activity.runOnUiThread {
            try {
                recognizer?.destroy()
                recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                    setRecognitionListener(buildListener())
                }
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                    // The whole point: text as you speak, not only at the end.
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                }
                recognizer?.startListening(intent)
                listening = true
                emitState("listening")
                call.resolve()
            } catch (e: Exception) {
                listening = false
                call.reject(e.message ?: "could not start", ERR_START_FAILED)
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity.runOnUiThread {
            try {
                recognizer?.stopListening()
            } catch (e: Exception) {
                // Stopping a recogniser that already stopped is not a failure the
                // user can act on, and the transcript is already committed.
            }
            listening = false
            emitState("stopped")
            val ret = JSObject()
            // The partial is ahead of `committed` whenever the user stops
            // mid-sentence, which is the normal case. Returning `committed`
            // alone dropped every word spoken since the last pause.
            ret.put("text", if (lastPartial.length > committed.length) lastPartial else committed)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        activity.runOnUiThread {
            try {
                recognizer?.cancel()
            } catch (e: Exception) {
                // same as stop(): nothing actionable
            }
            listening = false
            committed = ""
            lastPartial = ""
            emitState("stopped")
            call.resolve()
        }
    }

    private fun buildListener() = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = emitState("listening")
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults) ?: return
            // ALWAYS the whole transcript, never a fragment. The web wrapper
            // treats every update as a REPLACE - appending is precisely the bug
            // that turned one spoken sentence into "I I went I went to the gym".
            lastPartial = join(committed, text)
            emitText(EV_PARTIAL, lastPartial)
        }

        override fun onResults(results: Bundle?) {
            val text = firstResult(results)
            if (!text.isNullOrBlank()) committed = join(committed, text)
            lastPartial = ""
            emitText(EV_FINAL, committed)
            // Android ends the session at a pause. If the user has not stopped,
            // restart so a sentence with a breath in it is still one transcript.
            if (listening) restart() else emitState("stopped")
        }

        override fun onError(error: Int) {
            when (error) {
                // Benign: the recogniser simply heard nothing this stretch. The
                // dictation is still live, so restart rather than reporting a
                // failure the user would read as "voice is broken".
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> if (listening) restart() else emitState("stopped")

                else -> {
                    listening = false
                    val payload = JSObject()
                    payload.put("code", codeFor(error))
                    payload.put("message", messageFor(error))
                    // Fatal or not, the text captured so far is NOT thrown away.
                    payload.put("text", committed)
                    notifyListeners(EV_ERROR, payload)
                    emitState("stopped")
                }
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun restart() {
        activity.runOnUiThread {
            try {
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, currentLang)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                }
                recognizer?.startListening(intent)
                emitState("listening")
            } catch (e: Exception) {
                listening = false
                emitState("stopped")
            }
        }
    }

    /**
     * Join two transcript fragments without duplicating an overlap.
     * Mirrors joinTranscript() in src/services/speech.js - a recogniser that
     * re-sends a growing prefix must not stack it.
     */
    private fun join(base: String, next: String): String {
        val a = base.trim()
        val b = next.trim()
        if (a.isEmpty()) return b
        if (b.isEmpty()) return a
        val aw = a.split(Regex("\\s+"))
        val bw = b.split(Regex("\\s+"))
        val low = { xs: List<String> -> xs.joinToString(" ") { it.lowercase() } }
        if (low(bw).startsWith(low(aw))) return b
        if (low(aw).endsWith(low(bw))) return a
        for (n in minOf(aw.size, bw.size) downTo 1) {
            if (low(aw.takeLast(n)) == low(bw.take(n))) {
                return (aw + bw.drop(n)).joinToString(" ")
            }
        }
        return "$a $b"
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun emitText(event: String, text: String) {
        val payload = JSObject()
        payload.put("text", text)
        notifyListeners(event, payload)
    }

    private fun emitState(state: String) {
        val payload = JSObject()
        payload.put("state", state)
        notifyListeners(EV_STATE, payload)
    }

    // Codes deliberately match src/services/speech.js's Web Speech error names,
    // so one set of user-facing copy serves both the browser and the app.
    private fun codeFor(error: Int) = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "audio-capture"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_CLIENT -> "aborted"
        else -> "speech_error"
    }

    private fun messageFor(error: Int) = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "No microphone found. Check your device."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone is blocked. Enable it in Settings."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            "Live text needs internet - still recording, we'll transcribe on send."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Something else is using the microphone."
        else -> "Voice stopped. Tap the mic to keep going - your text is safe."
    }

    override fun handleOnDestroy() {
        try {
            recognizer?.destroy()
        } catch (e: Exception) {
            // The activity is going away; there is nothing left to report to.
        }
        recognizer = null
        listening = false
    }
}
