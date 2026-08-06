import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync("index.html", "utf8");
const pageHtml = [
  "pages/money.html",
  "pages/gym.html",
  "pages/analytics.html",
  "pages/settings.html",
].map((file) => readFileSync(file, "utf8")).join("\n");
const css =
  readFileSync("styles.css", "utf8") +
  readdirSync("styles")
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join("styles", file), "utf8"))
    .join("\n");
const srcFiles = readdirSync("src", { recursive: true })
  .map((file) => String(file).replaceAll("\\", "/"))
  .filter((file) => file.endsWith(".js"));

for (const id of [
  "captureText",
  "fileInput",
  "voiceButton",
  "submitCapture",
  "routePreview",
  "agentStatus",
  "agentStageList",
  "parseLog",
  "jobEta",
  "monthlyCost",
  "dashboardViews",
  "bottomNav",
  "clearWorkspace",
  "dataStatus",
]) {
  assert.ok((html + pageHtml).includes(`id="${id}"`), `missing #${id}`);
}

for (const id of ["monthlyMoneyBudget", "weeklyMoneyBudget", "dailyCaloriesBudget", "dailyProteinBudget", "nightlySummaryToggle"]) {
  assert.ok(pageHtml.includes(`id="${id}"`), `missing settings/budget #${id}`);
}

for (const text of ["Trajectory"]) {
  assert.ok((html + pageHtml).includes(text), `missing UI label ${text}`);
}

// #degradedBanner is the one id in this contract that is NOT in any HTML file.
// It is created and prepended at runtime by src/ui/degraded-banner.js so a page
// adopts it with an import and no markup change. It exists because a page whose
// money read failed and a page with no spending look identical - and because
// "Something went wrong" is the same disease one level up: it reports that a
// failure happened without saying what is now missing from the screen.
{
  const banner = readFileSync(join("src", "ui", "degraded-banner.js"), "utf8");
  assert.ok(banner.includes('BANNER_ID = "degradedBanner"'), "missing #degradedBanner id in src/ui/degraded-banner.js");
  assert.ok(/role", "status"/.test(banner), "#degradedBanner must be role=status");
  assert.ok(/aria-live", "polite"/.test(banner), "#degradedBanner must be aria-live=polite");
  // It has to NAME the failing sources. A banner that cannot say "money and
  // reminders" is the generic sentence with extra steps.
  assert.ok(/could not be loaded\. Numbers on this page may be incomplete\./.test(banner), "#degradedBanner must name the failing sources and warn the numbers are incomplete");
  // Comments stripped: the module's header names the "Something went wrong"
  // anti-pattern it exists to replace, and that prose must not trip the check.
  const bannerCode = banner.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  assert.ok(!/something went wrong/i.test(bannerCode), "#degradedBanner must never fall back to a generic failure sentence");
}

for (const hardcoded of ["live mock", "Rs 1,430", "Rs 52.4k", "86 / 130g", "40+ flows"]) {
  assert.ok(!(html + pageHtml).includes(hardcoded), `hardcoded page data still present: ${hardcoded}`);
}

const srcCodeFiles = readdirSync("src", { recursive: true })
  .map((file) => String(file).replaceAll("\\", "/"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(join("src", file), "utf8"))
  .join("\n");
const hardcodedDataPatterns = [
  /Rs\s*1[,.]?430/,
  /Rs\s*52[,.]?4/,
  /poha\s*\+\s*chai/,
  /\bzomato\s+rs\s+240\b/i,
  /HDFC-May\.xlsx/,
];
for (const pat of hardcodedDataPatterns) {
  assert.ok(!pat.test(srcCodeFiles), `hardcoded sample data still present in src/: ${pat}`);
}

for (const selector of [".capture-panel", ".route-preview", ".agent-console", ".stage-dot", ".table-action", ".flow-card", ".settings-panel", ".bottom-nav", ".local-auth-box", ".auth-card"]) {
  assert.ok(css.includes(selector), `missing CSS ${selector}`);
}

for (const sourceText of ["Continue locally", "signInLocal", "yyoewdcijplkhxleejtm.supabase.co"]) {
  assert.ok(srcCodeFiles.includes(sourceText), `missing auth/config source text ${sourceText}`);
}

assert.ok(html.includes("./src/pages/capture.js"), "index.html should load capture page module");
assert.ok(srcFiles.length >= 12, `expected modular src scaffold, got ${srcFiles.length} files`);

for (const file of [
  "pages/capture.js",
  "pages/money.js",
  "pages/gym.js",
  "pages/analytics.js",
  "pages/settings.js",
  "ui/capture-panel.js",
  "ui/operational-tables.js",
  "ui/navigation.js",
  "ui/agent-status.js",
  "ui/budget-inputs.js",
  "ui/data-controls.js",
  "ui/jarvis-settings.js",
  "ui/auth-gate.js",
  "ui/degraded-banner.js",
  "services/jarvis.js",
  "services/push.js",
  "state/app-state.js",
  "ai/job-runner.js",
  "ai/capture-parser.js",
  "services/capture-router.js",
  "services/auth.js",
]) {
  assert.ok(srcFiles.includes(file), `missing src/${file}`);
}

console.log("ui contract tests passed");
