import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync("index.html", "utf8");
const pageHtml = [
  "pages/dashboard.html",
  "pages/money.html",
  "pages/diet.html",
  "pages/insights.html",
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
  "flowList",
  "monthlyCost",
  "chart",
  "clearWorkspace",
  "dataStatus",
]) {
  assert.ok((html + pageHtml).includes(`id="${id}"`), `missing #${id}`);
}

for (const id of ["monthlyMoneyBudget", "weeklyMoneyBudget", "dailyCaloriesBudget", "dailyProteinBudget", "nightlySummaryToggle"]) {
  assert.ok(pageHtml.includes(`id="${id}"`), `missing settings/budget #${id}`);
}

for (const text of ["Bank Excel", "Diet voice", "Screenshot dump", "DOD", "WOW", "MOM", "Trajectory", "12 AM daily summary"]) {
  assert.ok((html + pageHtml).includes(text), `missing UI label ${text}`);
}

for (const hardcoded of ["live mock", "Rs 1,430", "Rs 52.4k", "86 / 130g", "40+ flows"]) {
  assert.ok(!(html + pageHtml).includes(hardcoded), `hardcoded page data still present: ${hardcoded}`);
}

for (const selector of [".capture-panel", ".route-preview", ".agent-console", ".stage-dot", ".table-action", ".flow-card", ".settings-panel", ".bottom-nav"]) {
  assert.ok(css.includes(selector), `missing CSS ${selector}`);
}

assert.ok(html.includes("./src/pages/capture.js"), "index.html should load capture page module");
assert.ok(srcFiles.length >= 12, `expected modular src scaffold, got ${srcFiles.length} files`);

for (const file of [
  "pages/capture.js",
  "pages/dashboard.js",
  "pages/money.js",
  "pages/diet.js",
  "pages/insights.js",
  "pages/settings.js",
  "ui/capture-panel.js",
  "ui/operational-tables.js",
  "ui/summary-rail.js",
  "ui/agent-status.js",
  "ui/budget-inputs.js",
  "ui/data-controls.js",
  "ui/nightly-schedule.js",
  "ui/settings-panel.js",
  "ui/flow-lab.js",
  "state/app-state.js",
  "ai/job-runner.js",
  "ai/capture-parser.js",
  "services/capture-router.js",
  "data/table-data.js",
]) {
  assert.ok(srcFiles.includes(file), `missing src/${file}`);
}

console.log("ui contract tests passed");
