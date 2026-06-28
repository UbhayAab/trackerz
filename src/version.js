// Single human-visible build version. BUMP THIS on every deploy.
//
// It's stamped on every page (top-right badge). After you push + Pages deploys,
// the badge must change. If it does NOT change, it's a browser/Pages cache issue
// (tap the badge to force-clear caches + reload), not a code-didn't-ship issue.
// The service worker cache name (sw.js) mirrors this so old caches are purged.
export const APP_VERSION = "v15 · dark fixes + readability";
