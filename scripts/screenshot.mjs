// Reusable screenshot helper. Copy to <repo>/scripts/screenshot.mjs.
//
// Usage:
//   node scripts/screenshot.mjs --url http://127.0.0.1:4173/ --out screenshots/home.png
//   node scripts/screenshot.mjs --url http://127.0.0.1:4173/pages/money.html --out s/money.png --full-page
//   node scripts/screenshot.mjs --url http://127.0.0.1:4173/ --out s/dark.png --dark --device "iPhone 13 Pro"
//
// Requires: `npm i -D playwright` and `npx playwright install chromium` once.

import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.url || !args.out) {
  console.error("usage: node scripts/screenshot.mjs --url <URL> --out <PATH.png> [--width N] [--height N] [--full-page] [--device NAME] [--dark] [--wait ms] [--selector CSS]");
  process.exit(2);
}

const url = args.url;
const outPath = resolve(args.out);
const width = Number(args.width || 390);
const height = Number(args.height || 844);
const fullPage = Boolean(args["full-page"]);
const wait = Number(args.wait || 600);
const dark = Boolean(args.dark);
const deviceName = typeof args.device === "string" ? args.device : null;
const selector = typeof args.selector === "string" ? args.selector : null;

await mkdir(dirname(outPath), { recursive: true });

const browser = await chromium.launch();
const contextOptions = deviceName
  ? { ...devices[deviceName], colorScheme: dark ? "dark" : "light" }
  : { viewport: { width, height }, colorScheme: dark ? "dark" : "light", deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const context = await browser.newContext(contextOptions);
const page = await context.newPage();

const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(wait);
  if (selector) {
    const el = await page.locator(selector).first();
    await el.screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage });
  }
  console.log(`wrote ${outPath}`);
  if (consoleLines.length) {
    console.log("--- page console ---");
    for (const l of consoleLines) console.log(l);
  }
} catch (err) {
  console.error("screenshot failed:", err.message);
  if (consoleLines.length) {
    console.error("--- page console ---");
    for (const l of consoleLines) console.error(l);
  }
  process.exit(1);
} finally {
  await context.close();
  await browser.close();
}
