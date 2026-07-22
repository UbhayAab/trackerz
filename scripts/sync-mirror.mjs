// Copies the JARVIS-BRIEF mirror block from lib/jarvis-brief.mjs into the jarvis
// edge function, so the two never drift. tests/mirror-parity.test.mjs is the
// guard; this is the tool that makes satisfying it a one-liner instead of a
// hand-merge.
//
// Usage: node scripts/sync-mirror.mjs
import { readFileSync, writeFileSync } from "node:fs";

const EDGE = "supabase/functions/jarvis/index.ts";
const BLOCKS = [
  { lib: "lib/jarvis-brief.mjs", start: "JARVIS-BRIEF MIRROR START", end: "JARVIS-BRIEF MIRROR END" },
  { lib: "lib/email-template.mjs", start: "EMAIL-TEMPLATE MIRROR START", end: "EMAIL-TEMPLATE MIRROR END" },
];

function block(src, file, START, END) {
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error(`mirror markers missing in ${file}`);
  const lineStart = src.lastIndexOf("\n", s) + 1;
  const lineEnd = src.indexOf("\n", e) + 1;
  return { body: src.slice(lineStart, lineEnd), lineStart, lineEnd };
}

let edge = readFileSync(EDGE, "utf8");
let changed = 0;

for (const { lib: LIB, start: START, end: END } of BLOCKS) {
  const libSrc = readFileSync(LIB, "utf8");
  const libBlock = block(libSrc, LIB, START, END);
  const edgeBlock = block(edge, EDGE, START, END);

  // Only the marker comment lines differ (each names the other file); rebuild
  // the edge block from the lib body with the edge's own markers restored.
  const libLines = libBlock.body.split("\n");
  const edgeLines = edgeBlock.body.split("\n");
  libLines[0] = edgeLines[0];
  libLines[libLines.length - 2] = edgeLines[edgeLines.length - 2];

  const next = edge.slice(0, edgeBlock.lineStart) + libLines.join("\n") + edge.slice(edgeBlock.lineEnd);
  if (next !== edge) {
    edge = next;
    changed += 1;
    console.log(`synced ${libLines.length} lines from ${LIB}`);
  }
}

if (changed) {
  writeFileSync(EDGE, edge);
  console.log(`wrote ${EDGE}`);
} else {
  console.log("mirrors already in sync");
}
