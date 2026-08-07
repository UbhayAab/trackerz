// WHICH BUILD IS THIS, AND IS THERE A NEWER ONE?
//
// The APK freezes the whole web app at build time, so "fixed on main" and
// "fixed on the phone" are different facts. Nothing in the app ever compared
// them. See lib/update-check.mjs for the full account; this module is the I/O.
//
// Two reads, both cheap, neither allowed to break a page:
//   1. ./build-info.json - written into www/ by CI, so it ships INSIDE the APK
//      and describes the running build. Absent in a browser (Pages serves the
//      repo tree, which does not contain it) and absent in any APK built before
//      2026-08-08.
//   2. The GitHub release, for the newest published build.
//
// Every failure here is an Err() with a named kind, never a null that reads like
// data. "Could not reach GitHub" and "you are on the newest build" are opposite
// facts and the caller has to be able to tell them apart - collapsing them is
// exactly the disease tests/no-swallowed-errors.test.mjs exists to stop.

import { Err, Ok, classify } from "../../lib/failure.mjs";
import {
  RELEASE_API_URL, latestBuildFromRelease, shouldCheck, updateDecision,
} from "../../lib/update-check.mjs";

const LAST_CHECK_KEY = "trackerz.update_check_at";
const CACHED_LATEST_KEY = "trackerz.update_latest";

// Storage failures (private mode, quota, a disabled localStorage) are not worth
// breaking a page over, but they are worth being able to SEE, so the last one is
// kept for the diagnostics page instead of vanishing into a bare catch.
let lastStorageFailure = null;

/** What went wrong in the parts of this module that are allowed to degrade. */
export function updateCheckDiagnostics() {
  return { lastStorageFailure };
}

// Same base logic the nav uses: "./" from the site root, "../" from /pages/.
function appBase() {
  const path = globalThis.location?.pathname || "";
  return path.includes("/pages/") ? "../" : "./";
}

/**
 * The build stamped into this bundle by CI.
 *
 * Ok(info)          - we know exactly which build is running
 * Err("empty")      - no bundle manifest: a browser, or an APK built before CI
 *                     started stamping one. NOT "build 0", NOT "up to date".
 * Err(<kind>)       - the read itself failed
 */
export async function readInstalledBuild() {
  try {
    // Cache-bust: the service worker must never answer this with a previous
    // build's manifest, which would report the old build as current forever.
    const res = await fetch(`${appBase()}build-info.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return Err("empty", null, { source: "build-info.json", status: res.status });
    const info = await res.json();
    if (!info || !Number.isFinite(Number(info.versionCode))) {
      return Err("schema", null, { source: "build-info.json" });
    }
    return Ok(info, { source: "build-info.json" });
  } catch (e) {
    return Err(classify(e), e, { source: "build-info.json" });
  }
}

/**
 * Are we inside the Android shell?
 *
 * Capacitor injects its global into the WebView before any app code runs, so
 * this is the primary witness. A bundled build-info.json is the second: it
 * exists only inside an APK.
 */
export function isNativeShell() {
  const cap = globalThis.Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === "function") {
    try {
      return Boolean(cap.isNativePlatform());
    } catch (e) {
      // An injected bridge that throws is still an injected bridge.
      lastStorageFailure = { where: "Capacitor.isNativePlatform", kind: classify(e) };
      return true;
    }
  }
  return Boolean(cap.platform && cap.platform !== "web");
}

/**
 * The newest published build.
 *
 * Uses the public releases API, which sends `Access-Control-Allow-Origin: *`
 * (verified against the live endpoint) so the WebView can read it cross-origin.
 * The release DOWNLOAD host redirects to storage and is not CORS-safe, which is
 * why metadata comes from the API and the download URL is only ever handed to
 * the browser as a link.
 */
export async function fetchLatestBuild() {
  try {
    const res = await fetch(RELEASE_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    // 403 here is nearly always the unauthenticated rate limit, not a real
    // permission problem, but either way it is a failed check and says so.
    if (!res.ok) return Err(res.status >= 500 ? "server" : "unauthorized", null, { source: "github release", status: res.status });
    const build = latestBuildFromRelease(await res.json());
    if (!build) return Err("empty", null, { source: "github release" });
    return Ok(build, { source: "github release" });
  } catch (e) {
    return Err(classify(e), e, { source: "github release" });
  }
}

function readCachedLatest() {
  try {
    const raw = globalThis.localStorage?.getItem(CACHED_LATEST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(Number(v?.versionCode)) ? v : null;
  } catch (e) {
    lastStorageFailure = { where: "readCachedLatest", kind: classify(e) };
    return null;
  }
}

function writeCachedLatest(latest) {
  try {
    if (latest) globalThis.localStorage?.setItem(CACHED_LATEST_KEY, JSON.stringify(latest));
    globalThis.localStorage?.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch (e) {
    lastStorageFailure = { where: "writeCachedLatest", kind: classify(e) };
  }
}

function readLastCheckedAt() {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_CHECK_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    lastStorageFailure = { where: "readLastCheckedAt", kind: classify(e) };
    return 0;
  }
}

/**
 * The full answer for the UI: what is installed, what is published, and the
 * honest verdict between them.
 *
 * Rate-limited to one network call per CHECK_INTERVAL_MS; between calls the last
 * known release is reused. `force` skips the throttle for a manual re-check.
 */
export async function checkForUpdate({ force = false } = {}) {
  // NATIVE CHECK FIRST, AND ONLY THEN ANY NETWORK.
  //
  // This used to read build-info.json before deciding whether it mattered. In a
  // browser that file does not exist by design, so every page load fired a 404 -
  // and `scripts/smoke-ui.mjs`, which the repo uses to spot real breakage, duly
  // reported it among its "failed requests". A diagnostic that cries wolf on its
  // own noise is worse than no diagnostic, and this module exists to stop
  // exactly that class of bug, so it does not get to create one.
  const isNative = isNativeShell();
  if (!isNative) {
    return {
      buildInfo: null, isNative, latest: null, installedRes: null, latestRes: null,
      decision: updateDecision({ isNative: false }),
    };
  }
  const installedRes = await readInstalledBuild();
  const buildInfo = installedRes.ok ? installedRes.value : null;

  let latest = readCachedLatest();
  let latestRes = latest ? Ok(latest, { source: "cache" }) : null;

  if (force || shouldCheck({ lastCheckedAt: readLastCheckedAt(), now: Date.now() })) {
    latestRes = await fetchLatestBuild();
    if (latestRes.ok) {
      latest = latestRes.value;
      writeCachedLatest(latest);
    } else if (force) {
      // A forced check that failed must REPORT the failure, not quietly fall
      // back to a cached answer and look like a successful "up to date".
      latest = null;
    }
  }

  return {
    buildInfo,
    isNative,
    latest,
    installedRes,
    latestRes,
    decision: updateDecision({
      installedVersionCode: buildInfo?.versionCode,
      latestVersionCode: latest?.versionCode,
      isNative: true,
    }),
  };
}
