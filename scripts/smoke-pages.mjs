// Walk every page in headless Chromium and fail loud on console errors / 404s.
// Usage: node scripts/smoke-pages.mjs [base]
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4173";
const pages = [
  "/",
  "/pages/dashboard.html",
  "/pages/money.html",
  "/pages/diet.html",
  "/pages/insights.html",
  "/pages/settings.html",
  "/share-target.html",
];

const browser = await chromium.launch();
let failed = 0;

for (const path of pages) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  const bad = [];

  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.startsWith(base) && r.status() >= 400) bad.push(`${r.status()} ${u}`);
  });

  try {
    const res = await page.goto(base + path, { waitUntil: "networkidle", timeout: 20000 });
    if (!res || !res.ok()) {
      console.error(`× ${path} - HTTP ${res?.status() ?? "?"}`);
      failed++;
    } else if (errors.length || bad.length) {
      console.error(`× ${path}`);
      for (const e of errors) console.error(`    ${e}`);
      for (const b of bad) console.error(`    ${b}`);
      failed++;
    } else {
      console.log(`✓ ${path}`);
    }
  } catch (e) {
    console.error(`× ${path} - ${e.message}`);
    failed++;
  } finally {
    await ctx.close();
  }
}

await browser.close();
if (failed) {
  console.error(`\n${failed} page(s) failed`);
  process.exit(1);
}
console.log(`\nall ${pages.length} pages clean`);
