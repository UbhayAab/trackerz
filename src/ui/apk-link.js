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
// The CI workflow (.github/workflows/android-apk.yml) recreates the `android-latest`
// release on every push to main, which is what keeps this URL fixed and always
// pointing at the freshest build.

export const APK_URL = "https://github.com/UbhayAab/trackerz/releases/download/android-latest/trackerz.apk";

// A callout with the download link. `reason` says what installing actually buys,
// in the words of the thing the user was trying to do when they hit the wall.
export function apkCalloutHtml(reason) {
  return `
    <div class="apk-callout">
      <p class="apk-reason">${reason}</p>
      <a class="primary-button apk-download" href="${APK_URL}" rel="noopener">Download the Android app</a>
      <p class="apk-note">Sideload build: your phone will ask you to allow installs from the browser once. Sign in with the same account and everything you already have is there.</p>
    </div>`;
}
