// EMAIL INBOUND — turns a forwarded email (bank/UPI/card alert, etc.) into a
// capture and runs it through the EXISTING agent pipeline, which already knows how
// to parse HDFC/UPI alerts. It does NOT re-implement the pipeline: it inserts a
// raw_ingestions row (service role) and invokes the `agent` function over the
// trusted internal path (x-internal-secret + explicit userId).
//
// Auth: the caller (a Gmail Apps Script forwarder — see docs/email-ingestion-plan.md)
// presents x-email-secret == app_secrets.EMAIL_SECRET. Deploy with
// --no-verify-jwt (the caller holds no Supabase JWT); this function verifies the
// secret itself. Idempotency: public.email_messages(dedupe_key) is reserved BEFORE
// the capture is created, so a redelivered message is skipped.
import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeEmail } from "../_shared/lib/email-normalize.mjs";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function adminClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

const _secretCache = new Map<string, string>();
async function resolveSecret(admin: ReturnType<typeof adminClient>, name: string): Promise<string> {
  const fromEnv = Deno.env.get(name);
  if (fromEnv) return fromEnv;
  if (_secretCache.has(name)) return _secretCache.get(name)!;
  const { data, error } = await admin.from("app_secrets").select("value").eq("name", name).maybeSingle();
  if (error) throw new Error(`app_secrets read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Missing secret ${name} (env + app_secrets both empty)`);
  _secretCache.set(name, data.value);
  return data.value;
}

// The email owner. Single-user app -> the sole profile; set EMAIL_OWNER_USER_ID to
// disambiguate if more than one account ever exists.
async function resolveOwnerUserId(admin: ReturnType<typeof adminClient>): Promise<string> {
  const override = Deno.env.get("EMAIL_OWNER_USER_ID");
  if (override) return override;
  const { data, error } = await admin.from("profiles").select("id").order("created_at", { ascending: true }).limit(2);
  if (error) throw new Error(`profiles read failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no profiles exist");
  if (data.length > 1) throw new Error("multiple profiles — set EMAIL_OWNER_USER_ID");
  return data[0].id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const admin = adminClient();
  try {
    // 1. Verify the shared secret.
    const secret = req.headers.get("x-email-secret") || "";
    const expected = await resolveSecret(admin, "EMAIL_SECRET");
    if (!secret || secret !== expected) {
      return Response.json({ ok: false, error: "invalid_secret" }, { status: 401 });
    }

    // 2. Normalize the email into capture text + a stable dedupe key.
    const body = await req.json().catch(() => ({}));
    const norm = normalizeEmail(body);
    if (!norm.captureText) return Response.json({ ok: true, skipped: "empty" });

    const userId = await resolveOwnerUserId(admin);

    // 3. Reserve the dedupe key FIRST — a unique violation means "already ingested".
    const { error: dupErr } = await admin.from("email_messages").insert({
      user_id: userId, dedupe_key: norm.dedupeKey, sender: norm.sender, subject: norm.subject,
    });
    if (dupErr) {
      if ((dupErr as { code?: string }).code === "23505") return Response.json({ ok: true, skipped: "duplicate" });
      throw new Error(`email_messages insert failed: ${dupErr.message}`);
    }

    // 4. Create the capture (same shape a typed capture uses).
    const occurredAt = typeof body?.receivedAt === "string" && body.receivedAt ? body.receivedAt : null;
    const { data: ing, error: ingErr } = await admin.from("raw_ingestions").insert({
      user_id: userId, source_type: "text", capture_mode: "email",
      raw_text: norm.captureText, occurred_at: occurredAt, status: "queued",
    }).select("id").single();
    if (ingErr || !ing) throw new Error(`raw_ingestions insert failed: ${ingErr?.message}`);
    await admin.from("email_messages").update({ ingestion_id: ing.id }).eq("user_id", userId).eq("dedupe_key", norm.dedupeKey);

    // 5. Drive the SAME agent pipeline via the trusted internal path. verify_jwt is
    //    on for `agent`, so the gateway needs a valid key — the service_role key is
    //    a valid JWT; our x-internal-secret then selects the internal auth branch.
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const internalSecret = await resolveSecret(admin, "INTERNAL_INVOKE_SECRET");
    const agentUrl = `${requireEnv("SUPABASE_URL")}/functions/v1/agent`;
    const res = await fetch(agentUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ ingestionId: ing.id, userId, sourceType: "text", text: norm.captureText, mode: "auto" }),
    });
    const agentOut = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Capture is saved (status queued) even if reasoning failed — nothing lost.
      return Response.json({ ok: false, ingestion_id: ing.id, error: `agent ${res.status}`, detail: agentOut }, { status: 502 });
    }

    return Response.json({
      ok: true,
      ingestion_id: ing.id,
      sender: norm.sender,
      tool_calls: Array.isArray(agentOut?.toolCalls) ? agentOut.toolCalls.length : 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
