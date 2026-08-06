# Deno Android app (Capacitor shell)

Deno is a static PWA, but a browser **cannot** read Android Health Connect
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

## Installing it

You do **not** install Android Studio, the JDK, or the Android SDK. Every tool
comes from the GitHub Actions runner or from `npx`.

**On the phone, in a normal browser tab:**

1. Open the app, go to **Settings**, and tap **Download the Android app**.
   (It opens in the browser deliberately - see "The pause/resume trap" below.)
2. When the download finishes, tap it. Or open **Files → Downloads → `trackerz.apk`**.
3. Android asks once for permission to install from that app. Allow it.

Direct link, if you would rather not go through the app:
`https://github.com/UbhayAab/trackerz/releases/download/android-latest/trackerz.apk`

Each build also publishes an immutable `trackerz-1.0.<build>.apk` next to it,
plus a `latest.json` carrying the version, byte size and SHA-256 - so a
half-finished download is provable rather than a mystery.

### The pause/resume trap

If the download sticks at ~6.9 MB offering only pause/resume, **the file is
almost certainly already on the phone and complete.** 6,886,605 bytes renders as
"6.89 MB", and the published asset has verified clean.

What actually breaks is *where the download was started*. The web app is
`display: standalone`, and `github.com` is out of its scope, so tapping the link
from the installed PWA opens a Custom Tab **inside** the app. The progress bar
and the "Open" button live in that tab - dismiss it and the finished download
has nowhere to appear. Fix: **Files → Downloads → tap the APK.** The in-app link
now forces a real browser tab, so this should not recur.

Two other silent blockers worth knowing:

- **Signature mismatch.** Builds before 2026-07-31 used a random per-run debug
  key. Android refuses to replace an app whose signature differs and reports it
  as a bare "App not installed". Uninstall the old build first; all data lives
  in Supabase, so nothing is lost.
- **Play Protect.** It auto-blocks sideloaded binaries that request sensitive
  permissions, and this app requests `READ_SMS`. Play Store → profile → Play
  Protect → Settings → turn scanning off, install, turn it back on.

Also note permission to install unknown apps is granted **per installing app**.
Granting it to Chrome does nothing when you open the APK from Files.

## Release-signed, with a pinned key

The workflow runs `./gradlew assembleRelease`, signed with a fixed sideload
keystore held in the `ANDROID_KEYSTORE_B64` repository secret, with v1+v2+v3
signing all enabled. CI **hard-fails** unless the signer SHA-256 matches the
pinned fingerprint, so a randomly-keyed build can never reach the download link -
that is precisely what caused the original "cannot install" problem.

`versionCode` is the CI run number, so it increases monotonically and updates
install straight over the previous build with no uninstall.

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
cd android && ./gradlew assembleRelease
```

`android/` is committed (it holds the Kotlin Health Connect plugin), so CI only
runs `cap sync`; the `cap add` path is a fallback for a checkout missing it.
