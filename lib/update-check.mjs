// IS THE APP ON THE PHONE THE APP WE BUILT?
//
// For six weeks the answer was "nobody knows", and that single gap made every
// other fix look broken. The APK bundles the whole web app at build time
// (capacitor webDir=www, staged in CI), so a fix landing on main does NOT reach
// the phone. It reaches the phone when someone downloads and installs a new APK.
// Between 1.0.34 and 1.0.45 that never happened: the immutable per-build release
// assets recorded exactly one download, on 1.0.34. Eleven builds of fixes sat on
// a release page nobody visited, while the owner used an app that predated them
// and reported the bugs they had already fixed.
//
// The one signal he had was the version badge, and it lied. `APP_VERSION` is a
// hand-typed string with a comment saying "BUMP THIS on every deploy"; it read
// "v17" while CI was publishing build 45. A stamp that does not change cannot
// tell you whether an update landed, so tapping "force refresh" and seeing "v17"
// again taught him the update had failed even when it had worked.
//
// This module is the pure half of the fix: compare what is installed against
// what is published, and be honest when we cannot tell.
//
// THE RULE THAT MATTERS HERE: never report absent data as a measurement. If the
// installed build is unknown (running in a browser, or an APK built before CI
// started stamping build-info.json), the answer is "unknown" - never "you are up
// to date". Silently claiming currency is the exact failure this module exists
// to end.

/** The release that always holds the newest APK. */
export const RELEASE_TAG = "android-latest";
export const OWNER_REPO = "UbhayAab/trackerz";

/** Public, CORS-open, and unauthenticated-rate-limited at 60/hr/IP. */
export const RELEASE_API_URL =
  `https://api.github.com/repos/${OWNER_REPO}/releases/tags/${RELEASE_TAG}`;

/** The floating asset, kept for muscle memory and old links. */
export const FLOATING_APK_URL =
  `https://github.com/${OWNER_REPO}/releases/download/${RELEASE_TAG}/trackerz.apk`;

/**
 * Pull the build number out of a published asset name.
 *
 * CI names each build `trackerz-1.0.<runNumber>.apk` and the run number IS the
 * android versionCode (see android-apk.yml: TRACKERZ_VERSION_CODE). The floating
 * `trackerz.apk` carries no version at all, which is why it is skipped rather
 * than parsed as zero - treating it as build 0 would make every phone look ahead
 * of the release.
 *
 * @returns {number|null} the versionCode, or null when the name carries none
 */
export function versionCodeFromAssetName(name) {
  const m = /^trackerz-(\d+)\.(\d+)\.(\d+)\.apk$/i.exec(String(name || "").trim());
  if (!m) return null;
  const code = Number(m[3]);
  return Number.isSafeInteger(code) && code >= 0 ? code : null;
}

/**
 * Reduce a GitHub release payload to the newest build it actually carries.
 *
 * Reads the ASSETS, not the release title. The title is set by a `gh release
 * edit` at the very end of the publish step, so a run cancelled mid-publish
 * leaves a stale title in front of a fresh binary. The assets are the artifact
 * itself and cannot disagree with themselves.
 *
 * @returns {{versionCode:number, versionName:string, url:string}|null}
 */
export function latestBuildFromRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  let best = null;
  for (const a of assets) {
    const code = versionCodeFromAssetName(a?.name);
    if (code === null) continue;
    if (!best || code > best.versionCode) {
      best = {
        versionCode: code,
        versionName: String(a.name).replace(/^trackerz-/i, "").replace(/\.apk$/i, ""),
        url: a.browser_download_url || a.url || FLOATING_APK_URL,
      };
    }
  }
  return best;
}

/**
 * The whole decision, in one honest shape.
 *
 * @param {object} p
 * @param {number|null|undefined} p.installedVersionCode  from the bundled build-info.json
 * @param {number|null|undefined} p.latestVersionCode     from the published release
 * @param {boolean} p.isNative  true only inside the Android shell
 */
export function updateDecision({ installedVersionCode, latestVersionCode, isNative } = {}) {
  const installed = normaliseCode(installedVersionCode);
  const latest = normaliseCode(latestVersionCode);

  // A browser always runs whatever GitHub Pages served a moment ago. There is no
  // "install" to be behind on, so nagging about an APK would be noise.
  if (!isNative) {
    return { state: "not-applicable", behindBy: 0, message: "" };
  }
  // Absent, not zero. An APK built before CI stamped build-info.json, or a fetch
  // that failed, both land here - and both must say so rather than reassure.
  if (installed === null) {
    return {
      state: "unknown-installed",
      behindBy: 0,
      message: "Cannot tell which build is installed. Reinstall from the release to be sure.",
    };
  }
  if (latest === null) {
    return {
      state: "unknown-latest",
      behindBy: 0,
      message: "Could not reach GitHub to check for a newer build.",
    };
  }
  if (latest > installed) {
    const behindBy = latest - installed;
    return {
      state: "behind",
      behindBy,
      message: behindBy === 1
        ? "A newer build is ready."
        : `You are ${behindBy} builds behind.`,
    };
  }
  // Ahead happens on a locally-built debug APK. Not an error, not an update.
  return { state: "current", behindBy: 0, message: "" };
}

function normaliseCode(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * What the version badge should read.
 *
 * The badge's job is to change when the build changes. A hand-maintained string
 * cannot do that, so the real build number wins whenever we have one, and the
 * hand-written label is demoted to a suffix that describes the release rather
 * than identifying it.
 */
export function versionLabel({ buildInfo, fallback } = {}) {
  const code = normaliseCode(buildInfo?.versionCode);
  if (code === null) return String(fallback || "").trim() || "web";
  const name = String(buildInfo?.versionName || `1.0.${code}`).trim();
  return `app ${name}`;
}

/**
 * Should we hit the network again yet?
 *
 * Once every six hours. The unauthenticated GitHub API allows 60 requests an
 * hour per IP and this check has no deadline, so there is nothing to buy by
 * asking more often - and a phone that opens the app forty times a day would
 * otherwise spend its rate limit on a question whose answer changes daily.
 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function shouldCheck({ lastCheckedAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  const last = Number(lastCheckedAt);
  const t = Number(now);
  if (!Number.isFinite(t)) return true;
  if (!Number.isFinite(last) || last <= 0) return true;
  // A clock that jumped backwards (timezone fix, NTP correction) must not park
  // the check forever in the future.
  if (last > t) return true;
  return t - last >= intervalMs;
}
