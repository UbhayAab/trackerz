// Drives the signed-in money page in a real browser and prints the numbers it
// actually renders, plus every console error.
//
// This exists because a statement import can succeed at the database level and
// still be invisible or wrong on screen - which is the failure mode that makes
// the app quietly lie about how much was spent.
//
// Usage: node scripts/smoke-money.mjs [baseUrl]
import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
const BASE = process.argv[2] || "http://127.0.0.1:4173/";
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
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(({ s, ref }) => {
  localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
  localStorage.removeItem("trackerz_local_auth_session_v1");
}, { s: session, ref: projectRef });

await page.goto(new URL("pages/money.html", BASE).href, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const report = await page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim().replace(/\s+/g, " ") || null;
  const rows = [...document.querySelectorAll("table tbody tr")].slice(0, 8)
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(" | "));
  return {
    signedIn: !document.getElementById("trackerz-signin-card"),
    tiles: [...document.querySelectorAll("[class*='stat'],[class*='tile'],[class*='metric']")]
      .map((el) => el.textContent.trim().replace(/\s+/g, " "))
      .filter((t) => t && t.length < 120)
      .slice(0, 12),
    ledgerRows: rows,
    bodyHasUndefined: /undefined|NaN|\[object Object\]/.test(document.body.innerText),
    importerPresent: Boolean(document.getElementById("statementInput")),
    acceptsMultiple: document.getElementById("statementInput")?.multiple ?? null,
  };
});

console.log(JSON.stringify(report, null, 1));
console.log(consoleErrors.length ? `\n${consoleErrors.length} console error(s):` : "\nno console errors");
for (const e of consoleErrors) console.log(`  ${e}`);

await page.screenshot({ path: "docs/smoke-money.png", fullPage: true });
console.log("\nscreenshot -> docs/smoke-money.png");
await browser.close();
