// Privacy mode: blur amounts/notes on screen so you can show the app to someone
// without exposing figures. Persisted in localStorage; applied app-wide via a
// body class that styles/components.css targets.
const KEY = "trackerz.privacy_mode";

export function isPrivacyOn() {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function applyPrivacyMode() {
  globalThis.document?.body?.classList.toggle("privacy-on", isPrivacyOn());
}

export function setPrivacyMode(on) {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    // ignore persistence errors
  }
  applyPrivacyMode();
}

export function togglePrivacyMode() {
  setPrivacyMode(!isPrivacyOn());
  return isPrivacyOn();
}
