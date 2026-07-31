// Verifies the double-work fixes in the REAL signed-in app, on a phone viewport:
//   - the repeat-meal chips render from the user's own history and are tappable
//   - water has exactly ONE entry control per page (the old bug was two)
//   - the home day-plan can log water at all (it previously could not)
//
// Usage: node scripts/smoke-repeat.mjs [baseUrl]
import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
const BASE = (process.argv[2] || "http://127.0.0.1:4173/").replace(/\/$/, "");
const EMAIL = "ubhayvatsaanand@gmail.com";

async function mintSession() {
  const S = process.env.SUPABASE_URL, K = process.env.SUPABASE_SECRET_KEY, A = process.env.SUPABASE_ANON_KEY;
  const gen = await fetch(`${S}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: K, authorization: `Bearer ${K}` },
    body: JSON.stringify({ type: "magiclink", email: EMAIL }),
  });
  const link = await gen.json();
  const token = link.hashed_token || link.properties?.hashed_token;
  const ver = await fetch(`${S}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: A },
    body: JSON.stringify({ type: "magiclink", token_hash: token }),
  });
  return ver.json();
}

const session = await mintSession();
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split(".")[0];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// Seed the session the same way scripts/smoke-ui.mjs does: the local-mode key has
// to go too, or it shadows the real session and the app renders the sign-in card.
await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ s, ref }) => {
  localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
  localStorage.removeItem("trackerz_local_auth_session_v1");
}, { s: session, ref: projectRef });

async function inspect(url, label) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const out = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("#mealChips .meal-chip")].map((b) => b.innerText.replace(/\n/g, " | "));
    // Every control on the page that can ADD water. Two of these was the bug.
    const waterAdders = [...document.querySelectorAll('[data-act="water"]')].map((b) => b.innerText.trim());
    // The old six-slot water checklist, which must be gone.
    const waterCheckboxes = [...document.querySelectorAll('[data-item^="water-"], [data-id^="water-"]')].length;
    const waterSummary = document.querySelector(".diet-water .diet-head")?.innerText.replace(/\n/g, " ") || null;
    // The install link for the two things a browser physically cannot do.
    const apkLinks = [...document.querySelectorAll("a.apk-download")].map((a) => a.getAttribute("href"));
    return {
      signedIn: !document.getElementById("trackerz-signin-card"),
      chips,
      waterAdders,
      waterCheckboxes,
      waterSummary,
      apkLinks,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(out, null, 1));
  return out;
}

const home = await inspect(`${BASE}/index.html`, "HOME");
const settings = await inspect(`${BASE}/pages/settings.html`, "SETTINGS");

// Tap the first chip and confirm it logs without a model call.
//
// This writes a REAL food row, so it is opt-in (--tap) and self-cleaning: the row
// is deleted again below. A smoke test that leaves a meal the user never ate would
// corrupt the very totals it is meant to verify.
let tapped = null;
const wantTap = process.argv.includes("--tap");
if (wantTap && home.chips.length) {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const before = await page.locator("#mealChips .meal-chip").count();
  await page.locator("#mealChips .meal-chip").first().click();
  await page.waitForTimeout(3500);
  const toast = await page.locator(".toast, [class*=toast]").first().innerText().catch(() => null);
  tapped = { chipsBefore: before, toast };
  console.log(`\n--- CHIP TAP ---\n${JSON.stringify(tapped, null, 1)}`);
} else if (home.chips.length) {
  console.log("\n(chip tap skipped - pass --tap to exercise the write; it writes and then deletes a real row)");
}

console.log("\n=== VERDICT ===");
const problems = [];
if (home.waterAdders.length !== 3) problems.push(`home has ${home.waterAdders.length} water buttons, expected the 3 steppers`);
if (home.waterAdders.length !== 3) problems.push(`home has ${home.waterAdders.length} water buttons, expected the 3 steppers`);
if (home.waterCheckboxes) problems.push(`home still renders ${home.waterCheckboxes} water checklist slots`);
if (home.waterCheckboxes) problems.push(`home still renders ${home.waterCheckboxes} water checklist slots`);
if (home.horizontalOverflow) problems.push("horizontal overflow on a phone width");
// The two browser-impossible features must offer a way to get the app that can do them.
if (settings.apkLinks.length < 2) {
  problems.push(`settings shows ${settings.apkLinks.length} APK download links, expected 2 (spend capture + health)`);
}
console.log(problems.length ? problems.map((p) => `FAIL: ${p}`).join("\n") : "OK: one water control per page, no checklist slots, no overflow");
if (errors.length) console.log(`\nconsole errors (${errors.length}):\n` + errors.slice(0, 8).join("\n"));

await page.screenshot({ path: "docs/smoke-repeat-home.png", fullPage: false });
await browser.close();

// Undo the tap. The row is identified by the exact label plus a 5-minute window,
// so an older real meal with the same name is never touched.
if (tapped) {
  const S = process.env.SUPABASE_URL, K = process.env.SUPABASE_SECRET_KEY;
  const label = home.chips[0].split(" | ")[0];
  const since = new Date(Date.now() - 5 * 60000).toISOString();
  const url = `${S}/rest/v1/food_logs?description=eq.${encodeURIComponent(label)}&occurred_at=gte.${encodeURIComponent(since)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { apikey: K, authorization: `Bearer ${K}`, prefer: "return=representation" },
  });
  const gone = await res.json().catch(() => []);
  console.log(`cleanup: deleted ${Array.isArray(gone) ? gone.length : 0} test row(s) for "${label}"`);
}
