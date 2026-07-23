// Proves the bottom nav is present, fixed, and tappable on EVERY page - including
// with JavaScript completely disabled, which is the regression that stranded the
// owner (the nav used to be injected from inside an auth callback).
//
// Usage: node scripts/smoke-nav.mjs [baseUrl]
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:4173/";
const PAGES = [
  "index.html", "pages/money.html", "pages/diet.html", "pages/gym.html",
  "pages/analytics.html", "pages/settings.html", "pages/diagnostics.html", "pages/audit.html",
];

async function probe(page, url) {
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const nav = document.querySelector("#bottomNav");
    if (!nav) return { present: false };
    const cs = getComputedStyle(nav);
    const box = nav.getBoundingClientRect();
    const links = [...nav.querySelectorAll("a.nav-item")];
    return {
      present: true,
      tabs: links.length,
      labels: links.map((a) => a.textContent.trim()),
      active: links.filter((a) => a.classList.contains("active")).map((a) => a.textContent.trim()),
      position: cs.position,
      visible: cs.display !== "none" && cs.visibility !== "hidden" && box.height > 0,
      // Fixed to the bottom of the viewport, and fully on screen.
      atBottom: Math.abs(box.bottom - window.innerHeight) < 2,
      onScreen: box.left >= -1 && box.right <= window.innerWidth + 1,
      minTap: Math.min(...links.map((a) => Math.round(a.getBoundingClientRect().height))),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

let failures = 0;
function check(label, r) {
  const ok = r.present && r.visible && r.tabs === 6 && r.position === "fixed"
    && r.atBottom && r.onScreen && r.minTap >= 44 && !r.overflow;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} tabs=${r.tabs ?? 0} pos=${r.position ?? "-"} bottom=${r.atBottom} tap=${r.minTap ?? 0}px active=[${(r.active || []).join(",")}]${r.overflow ? " OVERFLOW" : ""}`);
}

const browser = await chromium.launch();

// 1. Normal, JS enabled. Also the smallest phone width we care about.
for (const w of [320, 414]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 780 } });
  const page = await ctx.newPage();
  console.log(`\n--- ${w}px viewport, JS on ---`);
  for (const url of PAGES) check(`${w}px ${url}`, await probe(page, url));
  await ctx.close();
}

// 2. JS DISABLED. This is the real test: the nav must survive a module that
// never loads, which is exactly what happened on the phone.
const noJs = await browser.newContext({ viewport: { width: 414, height: 780 }, javaScriptEnabled: false });
const page2 = await noJs.newPage();
console.log("\n--- JS DISABLED (the failure mode being fixed) ---");
for (const url of PAGES) check(`no-js ${url}`, await probe(page2, url));
await noJs.close();

// 3. Tapping a tab actually navigates.
const ctx3 = await browser.newContext({ viewport: { width: 414, height: 780 } });
const page3 = await ctx3.newPage();
await page3.goto(BASE + "pages/money.html", { waitUntil: "domcontentloaded" });
await page3.click('#bottomNav a.nav-item:has-text("Diet")');
await page3.waitForLoadState("domcontentloaded");
const landed = new URL(page3.url()).pathname.endsWith("/pages/diet.html");
console.log(`\n${landed ? "PASS" : "FAIL"}  tapping Diet from Money navigates -> ${page3.url()}`);
if (!landed) failures += 1;
await ctx3.close();

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall nav checks passed");
process.exitCode = failures ? 1 : 0;
