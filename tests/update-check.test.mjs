import assert from "node:assert/strict";
import {
  CHECK_INTERVAL_MS, FLOATING_APK_URL, latestBuildFromRelease, shouldCheck,
  updateDecision, versionCodeFromAssetName, versionLabel,
} from "../lib/update-check.mjs";

// --- reading a build number out of an asset name ----------------------------
{
  assert.equal(versionCodeFromAssetName("trackerz-1.0.45.apk"), 45);
  assert.equal(versionCodeFromAssetName("trackerz-1.0.34.apk"), 34);
  assert.equal(versionCodeFromAssetName("trackerz-1.0.7.apk"), 7);
  // THE TRAP: the floating pointer has no version in its name. Parsing it as
  // build 0 would make every installed phone look newer than the release, and
  // the update banner would never fire again.
  assert.equal(versionCodeFromAssetName("trackerz.apk"), null);
  assert.equal(versionCodeFromAssetName("latest.json"), null);
  assert.equal(versionCodeFromAssetName(""), null);
  assert.equal(versionCodeFromAssetName(undefined), null);
  assert.equal(versionCodeFromAssetName("trackerz-1.0.45.apk.sig"), null);
}

// --- the newest build in a real release payload -----------------------------
{
  // Shaped exactly like the live android-latest release: eleven immutable
  // per-build assets, the floating pointer, and the update manifest.
  const release = {
    name: "Deno Android app (build 43)", // deliberately STALE, see below
    assets: [
      { name: "latest.json", browser_download_url: "u/latest.json" },
      { name: "trackerz-1.0.34.apk", browser_download_url: "u/34" },
      { name: "trackerz-1.0.40.apk", browser_download_url: "u/40" },
      { name: "trackerz-1.0.45.apk", browser_download_url: "u/45" },
      { name: "trackerz.apk", browser_download_url: "u/floating" },
    ],
  };
  const best = latestBuildFromRelease(release);
  assert.equal(best.versionCode, 45);
  assert.equal(best.versionName, "1.0.45");
  assert.equal(best.url, "u/45");
  // The title said 43 while the assets held 45. The publish step edits the title
  // LAST, so a cancelled run leaves the title behind the binary. Trusting the
  // title would have hidden a real update.
  assert.notEqual(best.versionCode, 43);

  assert.equal(latestBuildFromRelease({ assets: [] }), null);
  assert.equal(latestBuildFromRelease({}), null);
  assert.equal(latestBuildFromRelease(null), null);
  // A release carrying ONLY the floating asset tells us nothing about versions.
  assert.equal(latestBuildFromRelease({ assets: [{ name: "trackerz.apk" }] }), null);
}

// --- THE REAL BUG: eleven builds behind, and nothing said so ----------------
{
  // The owner's actual situation on 2026-08-08.
  const d = updateDecision({ installedVersionCode: 34, latestVersionCode: 45, isNative: true });
  assert.equal(d.state, "behind");
  assert.equal(d.behindBy, 11);
  assert.equal(d.message, "You are 11 builds behind.");
}

{
  const one = updateDecision({ installedVersionCode: 44, latestVersionCode: 45, isNative: true });
  assert.equal(one.state, "behind");
  assert.equal(one.behindBy, 1);
  assert.equal(one.message, "A newer build is ready.", "one build behind must not read '1 builds'");
}

// --- never assert absent data as a measurement ------------------------------
{
  // An APK built before CI stamped build-info.json. We do NOT know what is
  // installed. Saying "up to date" here is the precise lie this module exists to
  // prevent, so assert against it explicitly.
  const d = updateDecision({ installedVersionCode: null, latestVersionCode: 45, isNative: true });
  assert.equal(d.state, "unknown-installed");
  assert.notEqual(d.state, "current");
  assert.match(d.message, /Cannot tell which build/);

  // Same for undefined, empty string, and junk - none of them mean "build 0".
  for (const bad of [undefined, "", "n/a", NaN, -1]) {
    assert.equal(
      updateDecision({ installedVersionCode: bad, latestVersionCode: 45, isNative: true }).state,
      "unknown-installed",
      `installed=${String(bad)} must not resolve to a number`,
    );
  }
}

{
  // GitHub unreachable: offline, rate-limited, or DNS blocked. Unknown, not current.
  const d = updateDecision({ installedVersionCode: 45, latestVersionCode: null, isNative: true });
  assert.equal(d.state, "unknown-latest");
  assert.notEqual(d.state, "current");
}

// --- states that must stay quiet -------------------------------------------
{
  assert.equal(updateDecision({ installedVersionCode: 45, latestVersionCode: 45, isNative: true }).state, "current");
  // A locally-built debug APK can be ahead of the release. Not an error.
  assert.equal(updateDecision({ installedVersionCode: 99, latestVersionCode: 45, isNative: true }).state, "current");
  // In a browser there is no install to be behind on. Never nag.
  assert.equal(updateDecision({ installedVersionCode: null, latestVersionCode: 45, isNative: false }).state, "not-applicable");
  assert.equal(updateDecision({ installedVersionCode: 34, latestVersionCode: 45, isNative: false }).state, "not-applicable");
  assert.equal(updateDecision({}).state, "not-applicable");
}

// --- the badge has to CHANGE when the build changes -------------------------
{
  // The whole point. "v17" stayed on screen across eleven builds, so a correct
  // update was indistinguishable from a failed one.
  assert.equal(versionLabel({ buildInfo: { versionCode: 45, versionName: "1.0.45" } }), "app 1.0.45");
  assert.equal(versionLabel({ buildInfo: { versionCode: 46, versionName: "1.0.46" } }), "app 1.0.46");
  assert.notEqual(
    versionLabel({ buildInfo: { versionCode: 45, versionName: "1.0.45" } }),
    versionLabel({ buildInfo: { versionCode: 46, versionName: "1.0.46" } }),
    "two different builds must never print the same badge",
  );
  // A versionName missing from the manifest still yields a build-specific badge.
  assert.equal(versionLabel({ buildInfo: { versionCode: 45 } }), "app 1.0.45");
  // In the browser there is no build number, so the hand-written label is all
  // there is - and that is fine, because Pages redeploys on every push.
  assert.equal(versionLabel({ buildInfo: null, fallback: "v17 · plan changes" }), "v17 · plan changes");
  assert.equal(versionLabel({}), "web");
}

// --- how often to ask GitHub ------------------------------------------------
{
  const now = 1_754_600_000_000;
  assert.equal(shouldCheck({ lastCheckedAt: 0, now }), true, "never checked -> check");
  assert.equal(shouldCheck({ lastCheckedAt: null, now }), true);
  assert.equal(shouldCheck({ lastCheckedAt: now - 60_000, now }), false, "a minute ago -> do not hammer");
  assert.equal(shouldCheck({ lastCheckedAt: now - CHECK_INTERVAL_MS, now }), true);
  assert.equal(shouldCheck({ lastCheckedAt: now - CHECK_INTERVAL_MS - 1, now }), true);
  // A clock that jumped backwards must not park the next check in the future
  // forever. Phones do this on timezone and NTP corrections.
  assert.equal(shouldCheck({ lastCheckedAt: now + 86_400_000, now }), true);
  assert.equal(shouldCheck({ lastCheckedAt: "garbage", now }), true);
}

// --- the link must be the one that actually serves a file -------------------
{
  assert.match(FLOATING_APK_URL, /^https:\/\/github\.com\/UbhayAab\/trackerz\/releases\/download\/android-latest\/trackerz\.apk$/);
}

console.log("update-check: ok");
