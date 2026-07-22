// SPEND-PATTERNS mirror guard. The recurring-spend brain is copied verbatim into
// supabase/functions/agent/index.ts (Deno can't import repo lib/). This asserts
// the block between the markers is byte-identical, so a fix to the pure module
// can never silently leave the deployed suggestion logic behind. Same strategy
// as the JARVIS-BRIEF block check in tests/mirror-parity.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The agent edge fn is committed with CRLF line endings, the lib module with LF
// (repo convention - jarvis/index.ts happens to be LF, agent/index.ts is not).
// Normalise EOL so the guard catches real content drift, not a whitespace
// convention neither file should be reformatted over.
function mirrorBlock(src, file) {
  const start = src.indexOf("SPEND-PATTERNS MIRROR START");
  const end = src.indexOf("SPEND-PATTERNS MIRROR END");
  assert.ok(start !== -1 && end !== -1 && end > start, `spend-patterns mirror markers missing in ${file}`);
  const afterStartLine = src.indexOf("\n", start) + 1;
  const endLineStart = src.lastIndexOf("\n", end) + 1;
  return src.slice(afterStartLine, endLineStart).replace(/\r\n/g, "\n");
}

const libPath = "lib/spend-patterns.mjs";
const edgePath = "supabase/functions/agent/index.ts";
const lib = readFileSync(libPath, "utf8");
const edge = readFileSync(edgePath, "utf8");

assert.equal(
  mirrorBlock(edge, edgePath),
  mirrorBlock(lib, libPath),
  "DRIFT in SPEND-PATTERNS mirror block: lib/spend-patterns.mjs and the agent edge fn have diverged (run scripts/sync-mirror.mjs)",
);

console.log("spend-patterns mirror parity passed: lib/spend-patterns.mjs ↔ agent edge fn byte-identical");
