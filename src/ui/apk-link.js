// THE INSTALL LINK.
//
// Two features in this app are physically impossible in a browser - reading payment
// notifications / bank SMS, and reading watch sleep and steps out of Health Connect.
// Both were fully built, both correctly said "Android app only"... and nothing
// anywhere in the app told the user where to get the Android app. The health panel
// even pointed at "Settings -> download the APK", which was not a thing that existed.
// So the one feature the user actually asked for ("when I pay it should get locked
// in") sat behind a door with no handle.
//
// WHY target="_blank" IS LOAD-BEARING (2026-08-06).
//
// The download "stopped at 6.89 MB and only ever offered pause/resume". The APK
// was never the problem: the published asset is exactly 6,886,605 bytes - which
// Chrome renders as "6.89 MB" - the zip verifies clean, v1+v2+v3 signatures are
// present and the signer fingerprint matches the CI pin. The file was complete
// and had already downloaded four times.
//
// The failure is the launch context. manifest.webmanifest sets display:standalone,
// and github.com is out of scope for the installed PWA, so tapping a plain
// same-tab link opens a CUSTOM TAB INSIDE the WebAPK. The download progress and
// the "Open" button live in that custom tab; dismiss it or background the app and
// the completed download has nowhere to surface, which is exactly what
// "pause/resume forever" looks like. Opening in the real browser gives the
// download back its normal notification and Open affordance.
//
// A `download` attribute would not help: Chrome has ignored it for cross-origin
// URLs since Chrome 65.

const OWNER_REPO = "UbhayAab/trackerz";

// The floating pointer, kept for muscle memory and for anyone with the old link.
export const APK_URL = `https://github.com/${OWNER_REPO}/releases/download/android-latest/trackerz.apk`;

// Where to look when a download misbehaves: the release page lists every build
// with its size, so a truncated file is visible rather than a mystery.
export const APK_RELEASE_PAGE = `https://github.com/${OWNER_REPO}/releases/tag/android-latest`;

/**
 * A callout with the download link. `reason` says what installing actually buys,
 * in the words of the thing the user was trying to do when they hit the wall.
 */
export function apkCalloutHtml(reason) {
  return `
    <div class="apk-callout">
      <p class="apk-reason">${reason}</p>
      <a class="primary-button apk-download" href="${APK_URL}" target="_blank" rel="noopener noreferrer">Download the Android app</a>
      <p class="apk-note">Opens in your browser. When it finishes, tap the download to install - or find <strong>trackerz.apk</strong> in Files &rarr; Downloads. Android asks once for permission to install from your browser.</p>
      <details class="apk-help">
        <summary>Download finished but nothing happens?</summary>
        <ol class="apk-steps">
          <li>Open <strong>Files &rarr; Downloads</strong> and tap <strong>trackerz.apk</strong>. The download is usually already there.</li>
          <li>If it says <em>App not installed</em>, uninstall any Trackerz or Deno build from before 31 Jul 2026 first - those were signed with a different key and Android refuses to replace them. Your data is in the cloud, nothing is lost.</li>
          <li>If Play Protect blocks it: Play Store &rarr; profile &rarr; Play Protect &rarr; Settings &rarr; turn scanning off, install, turn it back on.</li>
          <li>Permission to install is granted <em>per app</em>. Granting it to Chrome does not cover Files, so allow whichever one you are opening it from.</li>
          <li>Still stuck: <a href="${APK_RELEASE_PAGE}" target="_blank" rel="noopener noreferrer">open the release page</a> and check the file size matches.</li>
        </ol>
      </details>
    </div>`;
}
