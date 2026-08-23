// Render the Gym page as a locally signed-in user and shoot the Home Protocol
// session panel, light and dark. Throwaway visual check for the protocol port -
// it opens the collapsed "Run today's session" details, which the normal
// screenshot script has no reason to know about.
//
//   node scripts/shot-protocol.mjs            (needs `npm run serve` running)

import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const LOCAL_SESSION = {
  user: { id: "local-user", email: "local@trackerz", user_metadata: { local: true } },
  access_token: "local", local: true,
};

for (const theme of ["light", "dark"]) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 1400 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.addInitScript(([session, mode]) => {
    localStorage.setItem("trackerz_local_auth_session_v1", JSON.stringify(session));
    localStorage.setItem("trackerz.theme", mode);
  }, [LOCAL_SESSION, theme]);

  await page.goto(`${BASE}/pages/gym.html`, { waitUntil: "networkidle" });
  await page.waitForSelector("#workoutLogWrap", { timeout: 10000 });
  await page.evaluate(() => { document.querySelector("#workoutLogWrap").open = true; });
  await page.waitForSelector(".wl-dial-btn", { timeout: 10000 });
  // Sunday resolves to the rest day, which has nothing to log - shoot a training
  // day instead by picking A off the dial (the same tap a user would make).
  await page.click('.wl-dial-btn[data-letter="A"]');
  await page.waitForSelector(".wl-load", { timeout: 10000 });
  // Put one lift at the wall so the ceiling callout is in the shot.
  await page.evaluate(() => {
    const input = document.querySelector(".wl-load");
    input.value = "25";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/shot-protocol-${theme}.png`, fullPage: true });

  const heading = await page.textContent(".wl-daymeta h2");
  const rows = await page.$$eval(".wl-ex", (n) => n.length);
  const ceiling = await page.$$eval(".wl-ceiling", (n) => n.length);
  console.log(`${theme}: "${heading}" · ${rows} exercise rows · ${ceiling} ceiling notice · ${errors.length} console errors`);
  errors.slice(0, 5).forEach((e) => console.log("   !", e));
  await browser.close();
}
