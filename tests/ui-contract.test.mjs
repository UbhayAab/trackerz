import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("styles.css", "utf8");
const app = readFileSync("app.js", "utf8");

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

for (const symbol of ["classifyCaptureInput", "routeModelForCapture", "renderFlows", "calculateCost"]) {
  assert.ok(app.includes(symbol), `missing app symbol ${symbol}`);
}

console.log("ui contract tests passed");
