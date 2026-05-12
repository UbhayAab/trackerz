import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

function jsFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
}

const srcFiles = jsFiles("src");
const styleFiles = readdirSync("styles").filter((file) => file.endsWith(".css"));

assert.ok(srcFiles.length >= 45, `expected at least 45 src modules, got ${srcFiles.length}`);
assert.ok(styleFiles.length >= 8, `expected layered CSS files, got ${styleFiles.length}`);

for (const directory of ["agent", "ai", "analytics", "data", "domain/diet", "domain/money", "domain/wellness", "duplicates", "imports", "pages", "services", "state", "ui", "utils"]) {
  assert.ok(srcFiles.some((file) => file.startsWith(`${directory}/`)), `missing src/${directory}`);
}

console.log(`architecture tests passed: ${srcFiles.length} src modules, ${styleFiles.length} style layers`);
