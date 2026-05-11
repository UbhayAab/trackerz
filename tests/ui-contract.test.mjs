import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync("index.html", "utf8");
const css =
  readFileSync("styles.css", "utf8") +
  readdirSync("styles")
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join("styles", file), "utf8"))
    .join("\n");
const app = readFileSync("app.js", "utf8");
const srcFiles = readdirSync("src", { recursive: true })
  .map((file) => String(file).replaceAll("\\", "/"))
  .filter((file) => file.endsWith(".js"));

for (const id of [
  "captureText",
  "fileInput",
  "voiceButton",
  "submitCapture",
  "routePreview",
  "flowList",
  "monthlyCost",
  "chart",
]) {
  assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
}

for (const text of ["Bank Excel", "Diet voice", "Screenshot dump", "DOD", "WOW", "MOM", "Trajectory"]) {
  assert.ok(html.includes(text), `missing UI label ${text}`);
}

for (const selector of [".capture-panel", ".route-preview", ".flow-card", ".bottom-nav"]) {
  assert.ok(css.includes(selector), `missing CSS ${selector}`);
}

assert.ok(app.includes("./src/main.js"), "app.js should delegate to modular src/main.js");
assert.ok(srcFiles.length >= 12, `expected modular src scaffold, got ${srcFiles.length} files`);

for (const file of [
  "ui/capture-panel.js",
  "ui/operational-tables.js",
  "ui/flow-lab.js",
  "services/capture-router.js",
  "data/table-data.js",
]) {
  assert.ok(srcFiles.includes(file), `missing src/${file}`);
}

console.log("ui contract tests passed");
