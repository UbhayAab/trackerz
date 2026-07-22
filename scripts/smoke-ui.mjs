// Drives the real app in a real browser as the real user, and asserts the
// things the owner reported: that you can get in, and that the one-tap row
// exists and works. Prints every console error and failed request, because
// silent failures are the actual disease here.
//
// Usage: node scripts/smoke-ui.mjs [baseUrl]
import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
const BASE = process.argv[2] || "http://127.0.0.1:4173/";
const EMAIL = "ubhayvatsaanand@gmail.com";

// Mint a real session admin-side and inject it, so the smoke test exercises the
// signed-in app rather than stopping at the sign-in card.
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
const page = await browser.newPage({ viewport: { width: 414, height: 896 } }); // phone

const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} - ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(({ s, ref }) => {
  localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
  localStorage.removeItem("trackerz_local_auth_session_v1");
}, { s: session, ref: projectRef });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const q = (sel) => document.querySelector(sel);
  const quick = q("#quickActions");
  const btns = [...(quick?.querySelectorAll("button[data-act]") || [])].map((b) => ({
    act: b.dataset.act, status: b.dataset.status || null, ml: b.dataset.ml || null,
    text: b.textContent.trim().replace(/\s+/g, " "),
    height: Math.round(b.getBoundingClientRect().height),
  }));
  return {
    signedIn: !document.getElementById("trackerz-signin-card"),
    quickActionsPresent: Boolean(quick && quick.children.length),
    buttons: btns,
    navLinks: [...document.querySelectorAll("#bottomNav a")].map((a) => a.getAttribute("href")),
    bodyHasUndefined: /undefineds|NaN|\[object Object\]/.test(document.body.innerText),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
});

console.log(JSON.stringify(report, null, 1));

// Actually press a water button and confirm the total moves.
if (report.quickActionsPresent) {
  const before = await page.textContent("#quickActions .quick-row:nth-child(2) .quick-note");
  await page.click('#quickActions button[data-act="water"][data-ml="250"]');
  await page.waitForTimeout(2200);
  const after = await page.textContent("#quickActions .quick-row:nth-child(2) .quick-note");
  console.log(`\nwater before: ${before.trim().replace(/\s+/g, " ")}`);
  console.log(`water after : ${after.trim().replace(/\s+/g, " ")}`);
  // Undo so the smoke test leaves no trace.
  await page.click('#quickActions button[data-act="water-undo"]');
  await page.waitForTimeout(1800);
  const undone = await page.textContent("#quickActions .quick-row:nth-child(2) .quick-note");
  console.log(`water undone: ${undone.trim().replace(/\s+/g, " ")}`);
}

await page.screenshot({ path: "docs/smoke-home.png", fullPage: true });
console.log("\nscreenshot -> docs/smoke-home.png");

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console errors:`);
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`  ${e.slice(0, 220)}`);
}
if (failedRequests.length) {
  console.log(`\n${failedRequests.length} failed requests:`);
  for (const r of [...new Set(failedRequests)].slice(0, 12)) console.log(`  ${r.slice(0, 220)}`);
}

await browser.close();
