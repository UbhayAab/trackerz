// Copies each pure mirror block from its lib/ source into the edge function that
// re-declares it (Deno cannot import repo-relative lib/), so the two never drift.
// tests/mirror-parity.test.mjs is the guard; this makes satisfying it a one-liner.
//
// Usage: node scripts/sync-mirror.mjs
import { readFileSync, writeFileSync } from "node:fs";

const JARVIS = "supabase/functions/jarvis/index.ts";
const AGENT = "supabase/functions/agent/index.ts";
const BLOCKS = [
  { lib: "lib/jarvis-brief.mjs", edge: JARVIS, start: "JARVIS-BRIEF MIRROR START", end: "JARVIS-BRIEF MIRROR END" },
  { lib: "lib/email-template.mjs", edge: JARVIS, start: "EMAIL-TEMPLATE MIRROR START", end: "EMAIL-TEMPLATE MIRROR END" },
  { lib: "lib/sleep-window.mjs", edge: AGENT, start: "SLEEP-WINDOW MIRROR START", end: "SLEEP-WINDOW MIRROR END" },
];

function block(src, file, START, END) {
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error(`mirror markers missing in ${file}`);
  const lineStart = src.lastIndexOf("\n", s) + 1;
  const lineEnd = src.indexOf("\n", e) + 1;
  return { body: src.slice(lineStart, lineEnd), lineStart, lineEnd };
}

// Group blocks by their edge target so each file is read + written once.
const byEdge = new Map();
for (const b of BLOCKS) {
  if (!byEdge.has(b.edge)) byEdge.set(b.edge, []);
  byEdge.get(b.edge).push(b);
}

let totalChanged = 0;
for (const [edgeFile, blocks] of byEdge) {
  let edge = readFileSync(edgeFile, "utf8");
  let changed = 0;
  for (const { lib: LIB, start: START, end: END } of blocks) {
    const libBlock = block(readFileSync(LIB, "utf8"), LIB, START, END);
    const edgeBlock = block(edge, edgeFile, START, END);

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
      console.log(`synced ${libLines.length} lines from ${LIB} -> ${edgeFile}`);
    }
  }
  if (changed) { writeFileSync(edgeFile, edge); totalChanged += changed; }
}

console.log(totalChanged ? `wrote ${totalChanged} block(s)` : "mirrors already in sync");
