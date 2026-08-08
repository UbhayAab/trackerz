// THE ONE PLACE THAT ALWAYS TELLS YOU WHICH BUILD YOU ARE ON AND HOW TO CHANGE IT.
//
// The download link existed in exactly two places - the health panel and the
// spend-capture panel - and BOTH of them only render their callout when there is
// no native bridge. So inside the installed app, which is the only place an
// update can be needed, Settings offered no way to get a newer build at all. The
// update banner covers the case where we successfully compared builds; this panel
// covers the case where we could not, and the case where he simply went looking.
//
// It renders in a browser too, because "how do I get the Android app" is a
// reasonable question to have on the settings page and the answer was nowhere.
import { APK_URL, APK_RELEASE_PAGE, apkCalloutHtml } from "./apk-link.js";
import { checkForUpdate } from "../services/build-info.js";
import { versionLabel } from "../../lib/update-check.mjs";
import { APP_VERSION } from "../version.js";

const HOST_ID = "installPanel";

// What the panel says before the network answers. Never a version number: a
// placeholder build string is indistinguishable from a real one.
function loadingHtml() {
  return `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">This app</p>
        <h2>Checking which build you are running…</h2>
      </div>
    </div>`;
}

function bodyHtml({ buildInfo, decision, latest, latestRes }) {
  const running = buildInfo
    ? `You are running <strong>${versionLabel({ buildInfo, fallback: APP_VERSION })}</strong>.`
    : "You are running the web app, not the installed Android app.";

  // The check itself can fail, and "could not ask" must never be printed as
  // "you are up to date" - that belief is what stranded eleven builds.
  const checkNote = latestRes && latestRes.ok === false
    ? `<p class="agent-detail">Couldn't check for a newer build (${latestRes.kind}). The link below always points at the newest one.</p>`
    : "";

  const newest = latest?.versionName
    ? `<p class="agent-detail">Newest published build: <strong>${latest.versionName}</strong>.</p>`
    : "";

  // "current" still gets the link. A user who came here on purpose wants the
  // file, not to be told they do not need it.
  const state = decision?.state === "behind"
    ? `<p class="apk-reason">${decision.message}</p>`
    : "";

  return `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">This app</p>
        <h2>Install or update the Android app</h2>
      </div>
    </div>
    <p class="agent-detail">${running}</p>
    ${newest}
    ${state}
    ${checkNote}
    ${apkCalloutHtml(
      "Watch sleep and steps, bank SMS and payment notifications only work in the installed app - a browser cannot read any of them.",
    )}
    <p class="agent-detail">Direct link, if you would rather paste it somewhere:
      <a href="${APK_URL}" target="_blank" rel="noopener noreferrer">trackerz.apk</a> ·
      <a href="${APK_RELEASE_PAGE}" target="_blank" rel="noopener noreferrer">all builds</a></p>`;
}

/**
 * Mount into #installPanel. Best-effort by construction: a failed update check
 * degrades to the panel WITHOUT a version comparison rather than to no panel,
 * because the download link is the part that must never disappear.
 */
export async function mountInstallPanel() {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  host.innerHTML = loadingHtml();
  try {
    const { buildInfo, decision, latest, latestRes } = await checkForUpdate();
    host.innerHTML = bodyHtml({ buildInfo, decision, latest, latestRes });
  } catch (err) {
    host.innerHTML = bodyHtml({ buildInfo: null, decision: null, latest: null, latestRes: { ok: false, kind: err?.message || "failed" } });
  }
}
