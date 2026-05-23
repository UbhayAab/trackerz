// Smoke test the Gemini key with text + vision + structured output.
// Run: node tests/e2e-gemini-vision.test.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.local" });

async function getKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const url = process.env.SUPABASE_DB_URL.replace(/\?sslmode=require/, "");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`select value from public.app_secrets where name = 'GEMINI_API_KEY'`);
  await c.end();
  return rows[0]?.value;
}

const key = await getKey();
assert.ok(key, "GEMINI_API_KEY not available");

async function call(parts) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(json)}`);
  return json.candidates[0].content.parts[0].text;
}

// 1) text only — instruction-following with no ambiguity
const r1 = await call([{ text: "What is 17 + 25? Reply with just the number." }]);
assert.match(r1.trim(), /\b42\b/, `expected 42, got: ${r1}`);
console.log("✓ text round-trip");

// 2) tiny 1x1 red png
const redPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0xb1, 0xa5, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);
const r2 = await call([
  { text: "Dominant color of this image? One word." },
  { inline_data: { mime_type: "image/png", data: redPng.toString("base64") } },
]);
assert.match(r2.trim(), /red/i, `expected red, got: ${r2}`);
console.log("✓ vision round-trip");

// 3) structured JSON output (the exact pattern the edge function uses)
const r3 = await call([
  {
    text: `Extract one expense from: "paid 240 zomato lunch upi". Output ONLY valid JSON with keys: amount (number), merchant (string), payment_mode (string). No prose, no fences.`,
  },
]);
const cleaned = r3.replace(/^```(?:json)?|```$/g, "").trim();
const parsed = JSON.parse(cleaned);
assert.equal(parsed.amount, 240);
assert.match(parsed.merchant, /zomato/i);
console.log("✓ structured JSON extraction");

console.log("\nall gemini smoke tests passed");
