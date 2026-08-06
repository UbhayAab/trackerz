// Drives the real app in a real browser as the real user, and asserts the
// things the owner reported: that you can get in, that the one-tap row exists
// and works, and that NOTHING is wider than the phone. Prints every console
// error and failed request, because silent failures are the actual disease here.
//
// Usage: node scripts/smoke-ui.mjs [baseUrl]
//        node scripts/smoke-ui.mjs --overflow-only        (skip the water tap)
//
// ---------------------------------------------------------------------------
// WHY THE OVERFLOW CHECK LOOKS THE WAY IT DOES
//
// This file used to answer the question with one line:
//
//     horizontalOverflow: document.documentElement.scrollWidth
//                       > document.documentElement.clientWidth + 1
//
// It reported `false` for months while the owner was looking at content running
// off the right edge of his phone. It was not unlucky, it was structurally
// incapable of ever saying true: styles/theme-premium.css sets
// `html, body { overflow-x: hidden }`, root overflow PROPAGATES to the viewport,
// and a clipped viewport clamps documentElement.scrollWidth to clientWidth by
// definition. `.app-shell { overflow-x: clip }` does the same one level down.
// Measured on pages/diagnostics.html at 320px: scrollWidth read 320 while the
// page actually laid out at 390 - 70px of it clipped, invisibly, under a green
// check. A guard that reports green while the user sees the bug is worse than
// no guard, so this one:
//
//   1. switches both clips OFF before it measures,
//   2. walks the DOM and names the FIRST offending element by selector, with
//      its scrollWidth, its clientWidth and how far past the viewport it sits,
//   3. does it at 320 / 360 / 390 / 414 CSS px, on every page,
//   4. with realistic content typed in - a long unbroken URL, which is what a
//      pasted order link or UPI reference actually looks like,
//   5. and exits non-zero when it finds something.
//
// Elements inside a deliberate horizontal scroller (`overflow-x: auto|scroll`)
// are exempt: a carousel is allowed to be wider than the screen. Everything
// else is not.
// ---------------------------------------------------------------------------
import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
const args = process.argv.slice(2);
const OVERFLOW_ONLY = args.includes("--overflow-only");
const BASE = args.find((a) => !a.startsWith("--")) || "http://127.0.0.1:4173/";
const EMAIL = "ubhayvatsaanand@gmail.com";

// 320 is the narrowest phone still in use; 360 is the most common Android
// width; 390/414 are the iPhone and large-Android widths. The bug the owner
// reported was invisible at the single 414 this file used to test at.
const WIDTHS = [320, 360, 390, 414];
const PAGES = [
  "index.html",
  "pages/money.html",
  "pages/gym.html",
  "pages/analytics.html",
  "pages/settings.html",
  "pages/audit.html",
  "pages/diagnostics.html",
  // ?do=sync, NEVER a bare quick-log.html. That page's contract is "the URL IS
  // the action": loading it with no query logs 250 ml of water on sight, which
  // is the whole point of the launcher shortcut and exactly wrong for a check
  // that opens it four times per run. An earlier version of this sweep wrote 20
  // phantom glasses into the live day before anyone noticed. `sync` renders the
  // identical layout and writes nothing.
  "quick-log.html?do=sync",
];

// A real pasted link. No spaces, 123 characters, nothing to break at.
const LONG_URL =
  "https://www.zomato.com/bangalore/order/checkout?orderId=8827361926354019283746&utm_source=whatsapp_share_button_long";
const REALISTIC_INPUT = `paid 240 zomato ${LONG_URL} and 6 boiled eggs`;

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

// Runs in the page. Returns the first element sticking out past the viewport
// once the shell's clipping is switched off, plus every element whose own
// content is wider than its box while its overflow is `visible` (which means
// the content is spilling, not scrolling).
const OVERFLOW_PROBE = `(() => {
  const un = document.createElement("style");
  un.id = "__smoke_unclip";
  un.textContent =
    "html,body,.app-shell,.page-shell{overflow-x:visible !important;max-width:none !important}";
  document.head.appendChild(un);

  const describe = (el) => {
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList.length) s += "." + [...el.classList].slice(0, 3).join(".");
    return s;
  };
  // A carousel is allowed to be wider than the screen.
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return describe(p);
    }
    return null;
  };

  const vw = document.documentElement.clientWidth;
  const past = [];
  const spilling = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (inScroller(el)) continue;
    if (r.right > vw + 1) {
      past.push({
        selector: describe(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: Math.round(r.right),
        overhang: Math.round(r.right - vw),
      });
    } else if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "visible" && el.clientWidth > 0) {
      spilling.push({ selector: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
  }

  const out = {
    viewportWidth: vw,
    // The truth, with the clip switched off. This is the number the old
    // one-liner could never see.
    contentWidth: document.documentElement.scrollWidth,
    first: past[0] || spilling[0] || null,
    pastViewport: past.length,
    spilling: spilling.length,
    worst: past.slice(0, 4),
  };
  un.remove();
  return out;
})()`;

const session = await mintSession();
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split(".")[0];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 414, height: 896 }, // phone
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

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

// A page can navigate or re-render under us (auth gate, service worker); retry
// rather than crash the whole run on one destroyed execution context.
async function probe() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await page.evaluate(OVERFLOW_PROBE);
      if (r) return r;
    } catch { /* context destroyed - settle and retry */ }
    await page.waitForTimeout(1000);
  }
  return null;
}

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
  };
});

console.log(JSON.stringify(report, null, 1));

// ---------------------------------------------------------------------------
// THE OVERFLOW SWEEP
// ---------------------------------------------------------------------------
console.log("\nhorizontal overflow sweep (clip switched off, long URL typed in)");
console.log("page                    width  content  first offender");
const offenders = [];
for (const path of PAGES) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => null);
    await page.waitForTimeout(1500);
    // Realistic content, in every text field the page has.
    await page.evaluate((text) => {
      for (const box of document.querySelectorAll("textarea, input[type='search'], input[type='text']")) {
        box.value = text;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, REALISTIC_INPUT).catch(() => null);
    await page.waitForTimeout(400);

    const r = await probe();
    if (!r) { console.log(`${path.padEnd(23)} ${String(width).padEnd(6)} (could not measure)`); continue; }
    const bad = r.contentWidth > r.viewportWidth + 1 || r.pastViewport > 0 || r.spilling > 0;
    const first = r.first
      ? `${r.first.selector} scrollWidth=${r.first.scrollWidth} clientWidth=${r.first.clientWidth}` +
        (r.first.overhang ? ` (+${r.first.overhang}px past the screen)` : " (spilling its own box)")
      : "-";
    console.log(`${path.padEnd(23)} ${String(width).padEnd(6)} ${String(r.contentWidth).padEnd(8)} ${bad ? first : "ok"}`);
    if (bad) {
      offenders.push({ page: path, width, contentWidth: r.contentWidth, viewportWidth: r.viewportWidth, first: r.first, worst: r.worst });
    }
  }
}

if (offenders.length) {
  console.log(`\n${offenders.length} HORIZONTAL OVERFLOW(S):`);
  for (const o of offenders) {
    console.log(`  ${o.page} @ ${o.width}px - page lays out at ${o.contentWidth}px`);
    for (const w of o.worst.length ? o.worst : [o.first]) {
      if (w) console.log(`      ${w.selector}  scrollWidth=${w.scrollWidth} clientWidth=${w.clientWidth}${w.overhang ? ` overhang=${w.overhang}px` : ""}`);
    }
  }
} else {
  console.log("\nno horizontal overflow at any width on any page");
}

// Back to the home page for the interaction checks and the screenshot.
await page.setViewportSize({ width: 414, height: 896 });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Actually press a water button and confirm the total moves.
if (report.quickActionsPresent && !OVERFLOW_ONLY) {
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

// The narrowest phone, which is where the overflow shows first and where no
// screenshot existed before.
await page.setViewportSize({ width: 320, height: 844 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1800);
await page.screenshot({ path: "docs/smoke-home-320.png", fullPage: true });
console.log("screenshot -> docs/smoke-home-320.png");

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console errors:`);
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`  ${e.slice(0, 220)}`);
}
if (failedRequests.length) {
  console.log(`\n${failedRequests.length} failed requests:`);
  for (const r of [...new Set(failedRequests)].slice(0, 12)) console.log(`  ${r.slice(0, 220)}`);
}

await browser.close();

// A guard that only prints is a guard that gets ignored.
if (offenders.length) process.exitCode = 1;
