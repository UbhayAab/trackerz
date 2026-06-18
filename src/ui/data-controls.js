import { resetWorkspace } from "../state/app-state.js";
import { exportCsv, exportAllJson } from "../services/export-service.js";
import { deleteAllUserData } from "../services/supabase-data.js";
import { isPrivacyOn, togglePrivacyMode } from "../services/privacy-mode.js";
import { isLocalSession } from "../services/auth.js";

export function bindDataControls() {
  const status = document.querySelector("#dataStatus");

  const clearButton = document.querySelector("#clearWorkspace");
  if (clearButton && status) {
    clearButton.addEventListener("click", () => {
      resetWorkspace("empty");
      status.textContent = "cleared";
    });
  }

  document.querySelector("#exportAllJson")?.addEventListener("click", async (e) => {
    await runExport(e.currentTarget, status, "Exported all (JSON)", () => exportAllJson());
  });
  document.querySelector("#exportLedgerCsv")?.addEventListener("click", async (e) => {
    await runExport(e.currentTarget, status, "Exported expenses (CSV)", () => exportCsv("ledger"));
  });
  document.querySelector("#exportFoodCsv")?.addEventListener("click", async (e) => {
    await runExport(e.currentTarget, status, "Exported food (CSV)", () => exportCsv("food_logs"));
  });

  const deleteButton = document.querySelector("#deleteAllData");
  if (deleteButton) {
    deleteButton.addEventListener("click", async () => {
      if (isLocalSession()) {
        if (status) status.textContent = "Sign in to delete server data (local demo has none).";
        return;
      }
      const ok = globalThis.confirm?.("Permanently delete ALL your Trackerz data (expenses, food, metrics, imports, media)? This cannot be undone.");
      if (!ok) return;
      deleteButton.disabled = true;
      if (status) status.textContent = "Deleting…";
      try {
        const { errors } = await deleteAllUserData();
        if (status) status.textContent = errors.length ? `Deleted with ${errors.length} error(s)` : "All data deleted";
      } catch (err) {
        if (status) status.textContent = `Delete failed: ${err?.message || err}`;
      } finally {
        deleteButton.disabled = false;
      }
    });
  }

  const privacyToggle = document.querySelector("#privacyToggle");
  if (privacyToggle) {
    privacyToggle.checked = isPrivacyOn();
    privacyToggle.addEventListener("change", () => {
      const on = togglePrivacyMode();
      if (status) status.textContent = on ? "privacy on" : "privacy off";
    });
  }
}

async function runExport(button, status, label, fn) {
  button.disabled = true;
  try {
    const count = await fn();
    if (status) status.textContent = `${label}: ${count} rows`;
  } catch (err) {
    if (status) status.textContent = `Export failed: ${err?.message || err}`;
  } finally {
    button.disabled = false;
  }
}
