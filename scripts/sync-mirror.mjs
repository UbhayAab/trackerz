// Copies the JARVIS-BRIEF mirror block from lib/jarvis-brief.mjs into the jarvis
// edge function, so the two never drift. tests/mirror-parity.test.mjs is the
// guard; this is the tool that makes satisfying it a one-liner instead of a
// hand-merge.
//
// Usage: node scripts/sync-mirror.mjs
import { readFileSync, writeFileSync } from "node:fs";

const LIB = "lib/jarvis-brief.mjs";
const EDGE = "supabase/functions/jarvis/index.ts";
const START = "JARVIS-BRIEF MIRROR START";
const END = "JARVIS-BRIEF MIRROR END";

function block(src, file) {
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error(`mirror markers missing in ${file}`);
  const lineStart = src.lastIndexOf("\n", s) + 1;
  const lineEnd = src.indexOf("\n", e) + 1;
  return { body: src.slice(lineStart, lineEnd), lineStart, lineEnd };
}

const lib = readFileSync(LIB, "utf8");
const edge = readFileSync(EDGE, "utf8");

const libBlock = block(lib, LIB);
const edgeBlock = block(edge, EDGE);

// Only the marker comment lines differ (each names the other file); rebuild the
// edge block from the lib body with the edge's own marker lines restored.
const libLines = libBlock.body.split("\n");
const edgeLines = edgeBlock.body.split("\n");
libLines[0] = edgeLines[0];
libLines[libLines.length - 2] = edgeLines[edgeLines.length - 2];

const next = edge.slice(0, edgeBlock.lineStart) + libLines.join("\n") + edge.slice(edgeBlock.lineEnd);
if (next === edge) {
  console.log("mirror already in sync");
} else {
  writeFileSync(EDGE, next);
  console.log(`synced ${libLines.length} lines from ${LIB} -> ${EDGE}`);
}
