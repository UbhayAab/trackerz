# Trackerz Android APK (Capacitor shell)

Trackerz is a static PWA, but a browser **cannot** read Android Health Connect
(sleep / steps / movement) — there is no Web API for it, and a Trusted Web
Activity renders in a Custom Tab with no JS↔native bridge. So the phone data
requires a real Android app. This is that app: a **Capacitor** shell that loads
the *exact same* web app in a WebView and adds a typed bridge to Kotlin for the
Health Connect reads.

No fork, no second copy of the UI. `capacitor.config.json` points `webDir` at
`www/`, and CI mirrors the repo's own web files (`index.html`, `pages/`, `src/`,
`lib/`, `vendor/`, `styles/`, `icons/`, `sw.js`, manifest, share-target) into
`www/` verbatim at build time. (`webDir` can't literally be `.` — the Capacitor
CLI rejects `"."`, `"./"`, `".."` — so the mirror step is how "ships unchanged"
is achieved.)

## The owner installs nothing

You do **not** install Android Studio, the JDK, or the Android SDK. Every tool
comes from the GitHub Actions runner or from `npx`.

1. Push to `main`, or open **Actions → Build Android APK → Run workflow**.
2. When the run finishes (green check), open it — **on the phone is fine**.
3. Scroll to **Artifacts** and download **`trackerz-debug-apk`** (a zip).
4. Unzip on the phone and tap the `.apk` to install.
5. Android will show an **"install from unknown source"** prompt. That is
   expected for any sideloaded app — allow it for your browser/Files app and
   continue. There is no malware check being bypassed beyond Play Store review.

## Why a debug-signed APK (and why that needs no secrets)

The workflow runs `./gradlew assembleDebug`, producing a **debug-signed** APK
signed with the auto-generated Android debug key. For a **personal sideload**
this is correct:

- It installs and runs fine; the only difference from a release build is the
  signing identity and the one-time "unknown source" prompt.
- It needs **no keystore and no repository secret**, so the whole pipeline works
  on a fresh fork with zero configuration.

A release (upload-key) signature is only needed to publish on the Play Store,
which this project deliberately does not do.

## Health Connect permissions

The app requests Health Connect read permissions at runtime; grant them when
asked. If Health Connect returns nothing, or permission is denied, the app must
**say so** — it must never invent a 0-hour sleep row or a 0-step day. (That exact
fabrication bug is why this shell was built.)

## UNVERIFIED ON HARDWARE

Neither the author of this workflow nor the review had an Android device. CI
proves the project **assembles** into an APK; it does **not** prove that Health
Connect reads work on a real OnePlus phone/watch. Treat the first on-device run
as the real test.

## Local commands (optional, for a machine that has the Android SDK)

```bash
npm install --no-save @capacitor/core@^6 @capacitor/cli@^6 @capacitor/android@^6
# stage the web app into www/ yourself, then:
npm run android:sync      # npx cap sync android
cd android && ./gradlew assembleDebug
```

`android/` is committed (it holds the Kotlin Health Connect plugin), so CI only
runs `cap sync`; the `cap add` path is a fallback for a checkout missing it.
