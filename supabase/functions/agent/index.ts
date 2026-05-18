// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Domain = "money" | "diet" | "fitness" | "wellness";
type SourceType = "text" | "image" | "audio" | "file" | "mixed";

type AgentRequest = {
  ingestionId: string;
  userId: string;
  sourceType: SourceType;
  text?: string;
  mode?: "auto" | Domain;
  mediaAssetIds?: string[];
};

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  confidence: number;
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_VISION_MODEL = "gemini-2.5-flash";

const ALLOWED_TOOLS = new Set([
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_statement_row_candidate",
  "create_food_log_candidate",
  "create_workout_log_candidate",
  "create_body_metric_candidate",
  "create_wellness_note_candidate",
  "link_duplicate_candidates",
  "request_user_review",
]);

const SYSTEM_PROMPT = `You convert messy personal logs into structured tool calls.
Return ONLY a JSON object: { "tool_calls": [ { name, arguments, confidence } ] }.
Allowed tool names: ${[...ALLOWED_TOOLS].join(", ")}.
Rules:
- Never invent amounts, dates, foods, merchants. If unsure, request_user_review.
- confidence in [0,1].
- create_expense_candidate.arguments: { amount, currency, merchant, description, payment_mode, occurred_at, is_discretionary }.
  is_discretionary=true for non-essential spend (eating out, entertainment, impulse shopping, subscriptions, food delivery).
  is_discretionary=false for groceries, fuel, utilities, rent, medical, transport.
- create_food_log_candidate.arguments: { meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g, occurred_at }.
- occurred_at must be ISO 8601. If only date given, use noon local.
- If the user says "yesterday" / "last X" normalize using the current date provided.
- One tool call per real event. Split mixed inputs into multiple calls.`;

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function adminClient() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

async function loadMediaInline(supabase: ReturnType<typeof adminClient>, mediaAssetIds: string[]) {
  if (!mediaAssetIds?.length) return [] as { mimeType: string; data: string }[];
  const { data, error } = await supabase
    .from("media_assets")
    .select("id, storage_bucket, storage_path, mime_type, media_kind")
    .in("id", mediaAssetIds);
  if (error) throw error;
  const inline: { mimeType: string; data: string }[] = [];
  for (const asset of data || []) {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(asset.storage_bucket)
      .download(asset.storage_path);
    if (dlErr || !blob) continue;
    const buf = new Uint8Array(await blob.arrayBuffer());
    const base64 = base64Encode(buf);
    inline.push({ mimeType: asset.mime_type, data: base64 });
  }
  return inline;
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function callGemini({
  text,
  inlineMedia,
  mode,
}: {
  text: string;
  inlineMedia: { mimeType: string; data: string }[];
  mode: string;
}) {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const startedAt = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const nowIso = new Date().toISOString();

  const userParts: any[] = [
    {
      text: `Current time: ${nowIso}.
Mode hint: ${mode}.
User input: ${text || "(no text; rely on attached media)"}.
Return ONLY JSON.`,
    },
    ...inlineMedia.map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.data } })),
  ];

  const response = await fetch(`${url}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: userParts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const json = await response.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const usage = json.usageMetadata || {};
  let parsed: { tool_calls?: ToolCall[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { tool_calls: [{ name: "request_user_review", arguments: { reason: "Model returned non-JSON", raw }, confidence: 0.5 }] };
  }
  const toolCalls = (parsed.tool_calls || []).filter(validateToolCall);
  return {
    toolCalls,
    latencyMs,
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    raw,
  };
}

function validateToolCall(tc: ToolCall): boolean {
  if (!tc || typeof tc.name !== "string") return false;
  if (!ALLOWED_TOOLS.has(tc.name)) return false;
  if (typeof tc.confidence !== "number" || tc.confidence < 0 || tc.confidence > 1) return false;
  if (!tc.arguments || typeof tc.arguments !== "object") return false;
  return true;
}

function estimateCostUsd(promptTokens?: number, outputTokens?: number) {
  // Gemini 2.5 Flash approx pricing per 1M tokens.
  const inUsd = ((promptTokens || 0) / 1_000_000) * 0.075;
  const outUsd = ((outputTokens || 0) / 1_000_000) * 0.3;
  return Number((inUsd + outUsd).toFixed(6));
}

async function persistRunAndActions(
  supabase: ReturnType<typeof adminClient>,
  req: AgentRequest,
  runInfo: { latencyMs: number; promptTokens?: number; outputTokens?: number; toolCalls: ToolCall[] },
) {
  const cost = estimateCostUsd(runInfo.promptTokens, runInfo.outputTokens);
  const { data: aiRun, error: runErr } = await supabase
    .from("ai_runs")
    .insert({
      user_id: req.userId,
      ingestion_id: req.ingestionId,
      provider: "google",
      model: GEMINI_MODEL,
      purpose: "capture_to_tool_calls",
      prompt_tokens: runInfo.promptTokens ?? null,
      output_tokens: runInfo.outputTokens ?? null,
      estimated_cost_usd: cost,
      latency_ms: runInfo.latencyMs,
      status: "completed",
    })
    .select()
    .single();
  if (runErr) throw runErr;

  for (const tc of runInfo.toolCalls) {
    await supabase.from("ai_actions").insert({
      user_id: req.userId,
      ai_run_id: aiRun.id,
      ingestion_id: req.ingestionId,
      tool_name: tc.name,
      arguments: tc.arguments,
      confidence: tc.confidence,
      status: tc.confidence >= 0.9 ? "auto_applied" : "proposed",
    });

    if (tc.confidence >= 0.9) {
      await applyTool(supabase, req.userId, req.ingestionId, tc);
    }
  }

  await supabase
    .from("raw_ingestions")
    .update({ status: "processed" })
    .eq("id", req.ingestionId);

  return aiRun.id;
}

async function applyTool(
  supabase: ReturnType<typeof adminClient>,
  userId: string,
  ingestionId: string,
  tc: ToolCall,
) {
  const args = tc.arguments as any;
  const occurredAt = args.occurred_at || new Date().toISOString();
  switch (tc.name) {
    case "create_expense_candidate":
      await supabase.from("ledger_entries").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        amount: args.amount,
        currency: args.currency || "INR",
        direction: "expense",
        merchant: args.merchant || null,
        description: args.description || null,
        payment_mode: args.payment_mode || null,
        occurred_at: occurredAt,
        confidence: tc.confidence,
        is_discretionary: Boolean(args.is_discretionary),
        tags: Array.isArray(args.tags) ? args.tags : [],
      });
      break;
    case "create_income_candidate":
      await supabase.from("ledger_entries").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        amount: args.amount,
        currency: args.currency || "INR",
        direction: "income",
        merchant: args.source || null,
        description: args.description || null,
        occurred_at: occurredAt,
        confidence: tc.confidence,
      });
      break;
    case "create_transfer_candidate":
      await supabase.from("ledger_entries").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        amount: args.amount,
        currency: args.currency || "INR",
        direction: "transfer",
        description: args.description || null,
        occurred_at: occurredAt,
        confidence: tc.confidence,
      });
      break;
    case "create_food_log_candidate":
      await supabase.from("food_logs").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        meal_name: args.meal_name || null,
        meal_slot: args.meal_slot || "other",
        description: args.description || "",
        calories_estimate: args.calories_estimate ?? null,
        protein_g: args.protein_g ?? null,
        carbs_g: args.carbs_g ?? null,
        fat_g: args.fat_g ?? null,
        confidence: tc.confidence,
        occurred_at: occurredAt,
      });
      break;
    case "create_body_metric_candidate":
      await supabase.from("body_metrics").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        metric_type: args.metric_type,
        value: args.value,
        unit: args.unit || "",
        occurred_at: occurredAt,
      });
      break;
    case "create_wellness_note_candidate":
      await supabase.from("wellness_logs").insert({
        user_id: userId,
        ingestion_id: ingestionId,
        note: args.note || "",
        mood_score: args.mood_score ?? null,
        energy_score: args.energy_score ?? null,
        stress_score: args.stress_score ?? null,
        occurred_at: occurredAt,
      });
      break;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const payload = (await req.json()) as AgentRequest;
    if (!payload?.ingestionId || !payload?.userId) {
      return Response.json({ ok: false, error: "ingestionId and userId required" }, { status: 400, headers: corsHeaders });
    }

    const supabase = adminClient();
    const inlineMedia = await loadMediaInline(supabase, payload.mediaAssetIds || []);
    const runInfo = await callGemini({
      text: payload.text || "",
      inlineMedia,
      mode: payload.mode || "auto",
    });
    const runId = await persistRunAndActions(supabase, payload, runInfo);

    return Response.json(
      { ok: true, aiRunId: runId, toolCalls: runInfo.toolCalls },
      { headers: corsHeaders },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
