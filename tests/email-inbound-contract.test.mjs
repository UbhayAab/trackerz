// EMAIL-INBOUND CONTRACT — source-scan guards for the edge function (it runs in
// Deno, so we assert its wiring the way agent-contract does). Locks: secret auth,
// dedupe-before-capture, capture shape, and that it reuses the agent pipeline via
// the trusted internal path rather than re-implementing it. Also locks the
// matching internal-auth branch on the agent function.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const inbound = readFileSync("supabase/functions/email-inbound/index.ts", "utf8");
const agent = readFileSync("supabase/functions/agent/index.ts", "utf8");

// --- email-inbound wiring ---------------------------------------------------
assert.ok(/from\s+"\.\.\/_shared\/lib\/email-normalize\.mjs"/.test(inbound), "must import the shared normalizer (no re-implementation)");
assert.ok(existsSync("supabase/functions/_shared/lib/email-normalize.mjs"), "shared normalizer mirror must exist");

assert.ok(inbound.includes("x-email-secret") && inbound.includes("EMAIL_SECRET"), "must gate on the x-email-secret / EMAIL_SECRET");
assert.ok(inbound.includes("invalid_secret"), "must reject a bad secret");

// dedupe row is reserved BEFORE the capture is created (idempotency).
const iDedupe = inbound.indexOf('from("email_messages")');
const iCapture = inbound.indexOf('from("raw_ingestions")');
assert.ok(iDedupe !== -1 && iCapture !== -1, "must touch both email_messages and raw_ingestions");
assert.ok(iDedupe < iCapture, "must reserve the dedupe key BEFORE inserting the capture");
assert.ok(inbound.includes('"23505"'), "must treat a unique-violation as a duplicate skip");

// capture shape matches a normal typed capture.
assert.ok(/source_type:\s*"text"/.test(inbound) && /capture_mode:\s*"email"/.test(inbound), "capture is source_type text / capture_mode email");

// reuses the agent pipeline over the internal path, never runs the model itself.
assert.ok(inbound.includes("/functions/v1/agent"), "must invoke the agent function");
assert.ok(inbound.includes("x-internal-secret") && inbound.includes("INTERNAL_INVOKE_SECRET"), "must use the internal-invoke secret");
assert.ok(!inbound.includes("deepseek") && !inbound.includes("gemini"), "must NOT call models directly — reuse the pipeline");
assert.ok(!inbound.includes("auth.getUser"), "server-to-server: no user-JWT validation here");

// --- agent internal-auth branch (the reuse hook) ----------------------------
assert.ok(agent.includes("x-internal-secret") && agent.includes("INTERNAL_INVOKE_SECRET"), "agent must accept the internal secret");
assert.ok(agent.includes("invalid_internal_secret"), "agent must reject a bad internal secret");
assert.ok(/userId\?:\s*string/.test(agent), "AgentRequest must carry an optional userId for internal calls");
// ownership check still applies to BOTH paths — a forged userId can't reach others' rows.
assert.ok(/ing\?\.user_id\s*!==\s*userId/.test(agent), "ingestion ownership check must remain for the internal path too");

console.log("email-inbound contract tests passed");
