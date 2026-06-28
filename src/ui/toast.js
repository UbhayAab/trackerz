// Slide-up confirmation chips. Reusable across the app for success/error
// feedback on an action ("Imported 128 rows", "Saved", "Couldn't reach server").
// Pure DOM, no deps. Mirrors the .toast styles in styles/theme-premium.css.

let host = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.className = "toast-host";
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

/**
 * Show a slide-up toast.
 * @param {string} message
 * @param {{kind?: "success"|"error", duration?: number}} [opts]
 * @returns {() => void} dismiss fn
 */
export function showToast(message, { kind = "success", duration = 3200 } = {}) {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast is-error" : "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(message)}</span>`;
  ensureHost().appendChild(el);

  // next frame so the entry transition runs
  requestAnimationFrame(() => el.classList.add("is-in"));

  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    el.classList.remove("is-in");
    const remove = () => el.remove();
    el.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 450);
  };
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}
