// Receives content from the OS share sheet (Android, ChromeOS, etc.).
// For browsers that POST the form, we cannot read the body from JS - so we
// stash it server-side via the service worker, which forwards the multipart
// payload into IndexedDB and redirects here. As a fallback (and for desktop
// drag-and-drop testing), we also accept query-string text/url/title.

import { bootWithAuth } from "./bootstrap.js";
import { runCapture } from "../services/agent-runner.js";
import { drainOfflineQueue, listOfflineQueue } from "../services/offline-queue.js";

const statusEl = document.getElementById("shareStatus");
const listEl = document.getElementById("shareList");
const processBtn = document.getElementById("shareProcess");

function addItem(label) {
  const li = document.createElement("li");
  li.textContent = label;
  listEl?.appendChild(li);
}

bootWithAuth(async () => {
  const url = new URL(globalThis.location.href);
  const qsText = url.searchParams.get("text") || "";
  const qsTitle = url.searchParams.get("title") || "";
  const qsUrl = url.searchParams.get("url") || "";

  const offlineRows = await listOfflineQueue();
  if (offlineRows.length) {
    addItem(`${offlineRows.length} queued capture(s) waiting from share sheet.`);
  }
  for (const row of offlineRows) {
    if (row.text) addItem(`text: ${row.text.slice(0, 80)}`);
    if (row.files?.length) addItem(`${row.files.length} file(s)`);
  }
  const combinedText = [qsTitle, qsText, qsUrl].filter(Boolean).join(" ").trim();
  if (combinedText) addItem(`text: ${combinedText.slice(0, 120)}`);

  if (!offlineRows.length && !combinedText) {
    statusEl.textContent = "Nothing to share. Use the Android share sheet or open the capture page.";
    return;
  }

  statusEl.textContent = "Ready to process. Tap below to send to AI.";
  processBtn.disabled = false;
  processBtn.addEventListener("click", async () => {
    processBtn.disabled = true;
    statusEl.textContent = "Processing...";
    try {
      if (combinedText) {
        await runCapture({ text: combinedText, files: [], captureType: "auto" });
      }
      await drainOfflineQueue(runCapture);
      statusEl.textContent = "Done. Opening capture page.";
      setTimeout(() => globalThis.location.assign("./index.html"), 600);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message || err}`;
      processBtn.disabled = false;
    }
  });
});
