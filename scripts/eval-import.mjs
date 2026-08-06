// Turn real history into eval fixtures.
//
//   node scripts/eval-import.mjs                 # print candidates not yet in the corpus
//   node scripts/eval-import.mjs --limit 60
//   node scripts/eval-import.mjs --write out.json
//
// Reads `raw_ingestions` joined to `ai_actions` and emits case SKELETONS: the
// input text, and `model` set to what the brain actually emitted on that run.
//
// It deliberately does NOT fill in `expect`. Seeding the expectation from the
// recorded behaviour would encode every bug as the contract - the 540 kcal
// phantom meal and the 432 kcal note-as-food would both become "correct" and the
// suite would cheerfully protect them forever. `expect` is hand-written, once,
// per case; that is the whole point of a golden file.

import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) || 40 : 40;
const writeAt = args.indexOf("--write");
const OUT = writeAt >= 0 ? args[writeAt + 1] : null;

// Which captures are already covered, so this only ever shows new ground.
let known = new Set();
try {
  const corpus = JSON.parse(readFileSync("tests/corpus/cases.json", "utf8"));
  known = new Set(corpus.cases.map((c) => String(c.id).split("-")[0]));
} catch {
  console.warn("no existing corpus found - every capture will be listed as new");
}

const c = await connectDb();
const { rows } = await c.query(
  `select r.id,
          r.source_type,
          r.raw_text,
          r.created_at,
          coalesce(
            json_agg(
              json_build_object('name', a.tool_name, 'arguments', a.arguments, 'confidence', a.confidence)
              order by a.created_at
            ) filter (where a.tool_name is not null),
            '[]'
          ) as model
     from raw_ingestions r
     left join ai_actions a on a.ingestion_id = r.id
    where r.raw_text is not null and length(trim(r.raw_text)) > 0
    group by r.id, r.source_type, r.raw_text, r.created_at
    order by r.created_at desc
    limit $1`,
  [LIMIT],
);
await c.end();

const fresh = rows.filter((r) => !known.has(String(r.id).split("-")[0]));

const cases = fresh.map((r) => ({
  id: `${String(r.id).split("-")[0]}-TODO-name-me`,
  source: `live ${new Date(r.created_at).toISOString().slice(0, 16)}`,
  input: r.raw_text,
  // Strip the salvage marker so a fixture never silently re-asserts a phantom:
  // a call carrying _auto_expanded was synthesised by the deterministic layer,
  // not emitted by the brain, so replaying it as "model output" would double it.
  model: (r.model || []).filter((m) => !m?.arguments?._auto_expanded),
  expect: {
    must: [],
    must_not: [],
    _TODO: "Write the contract by hand. What SHOULD this capture do? Do not copy what it did.",
  },
  tags: ["imported"],
  weight: 1,
}));

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ cases }, null, 2));
  console.log(`wrote ${cases.length} skeleton case(s) -> ${OUT}`);
} else {
  console.log(`${rows.length} captures, ${fresh.length} not yet in the corpus:\n`);
  for (const r of fresh) {
    const tools = (r.model || []).map((m) => m.name).join(", ") || "(no actions)";
    const salvaged = (r.model || []).some((m) => m?.arguments?._auto_expanded) ? "  [had salvage]" : "";
    console.log(`  ${String(r.id).slice(0, 8)}  ${new Date(r.created_at).toISOString().slice(0, 16)}`);
    console.log(`    ${String(r.raw_text).replace(/\s+/g, " ").slice(0, 110)}`);
    console.log(`    did: ${tools}${salvaged}\n`);
  }
  console.log("Add the interesting ones to tests/corpus/cases.json, writing `expect` by hand.");
  console.log("Rule of thumb: every bug becomes a case here BEFORE it becomes a code change.");
}
