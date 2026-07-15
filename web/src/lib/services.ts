// UI-facing services: the capture pipeline (mirror of the old agent-runner) and
// the Home dashboard queries. All run in the browser against Supabase with the
// user's session, so RLS scopes every row to them.
import { getSupabase } from "./supabase";
import { RAW_MEDIA_BUCKET } from "./config";
import { startOfTodayIST } from "./format";

export type CaptureMode = "auto" | "money" | "diet" | "wellness";

function inferSourceType(text: string, files: File[]): string {
  if (!files.length) return "text";
  if (files.length > 1) return "mixed";
  const mime = files[0].type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function pickKind(file: File): string {
  const mime = file.type || "";
  if (mime === "application/pdf" || mime.includes("excel") || mime.includes("spreadsheet") || mime === "text/csv") return "statement";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export type CaptureResult = {
  ingestionId: string;
  degraded: boolean;
  reason?: string;
  toolCalls: number;
};

// Insert raw_ingestions → upload media → invoke the `agent` edge function. The
// edge fn runs the two-model pipeline + the deterministic gauntlet and persists
// rows itself; we just kick it off and report the outcome.
export async function runCapture(
  input: { text?: string; files?: File[]; mode?: CaptureMode },
): Promise<CaptureResult> {
  const supabase = getSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const text = (input.text || "").trim();
  const files = input.files || [];
  const mode = input.mode || "auto";
  const sourceType = inferSourceType(text, files);

  const { data: ing, error: ingErr } = await supabase
    .from("raw_ingestions")
    .insert({
      user_id: user.id,
      source_type: sourceType,
      capture_mode: mode,
      raw_text: text || null,
      occurred_at: new Date().toISOString(),
      status: "queued",
    })
    .select("id, user_id, created_at")
    .single();
  if (ingErr || !ing) throw new Error(ingErr?.message || "Could not save capture.");

  const mediaAssetIds: string[] = [];
  for (const file of files) {
    const path = `${user.id}/${ing.id}/${crypto.randomUUID()}-${file.name}`;
    const up = await supabase.storage.from(RAW_MEDIA_BUCKET).upload(path, file, { upsert: false });
    if (up.error) continue;
    const { data: asset } = await supabase
      .from("media_assets")
      .insert({
        user_id: user.id,
        ingestion_id: ing.id,
        storage_bucket: RAW_MEDIA_BUCKET,
        storage_path: path,
        mime_type: file.type || "application/octet-stream",
        original_name: file.name,
        byte_size: file.size,
        media_kind: pickKind(file),
      })
      .select("id")
      .single();
    if (asset) mediaAssetIds.push(asset.id);
  }

  let data: { ok?: boolean; toolCalls?: unknown[]; error?: string } | null = null;
  let fnErr: { message?: string } | null = null;
  try {
    const res = await supabase.functions.invoke("agent", {
      body: { ingestionId: ing.id, userId: user.id, sourceType, text, mode, mediaAssetIds },
    });
    data = res.data;
    fnErr = res.error;
  } catch (e) {
    fnErr = { message: e instanceof Error ? e.message : String(e) };
  }

  if (fnErr || !data?.toolCalls) {
    return {
      ingestionId: ing.id,
      degraded: true,
      reason: fnErr?.message || data?.error || "Agent unavailable; capture queued for review.",
      toolCalls: 0,
    };
  }
  return { ingestionId: ing.id, degraded: false, toolCalls: data.toolCalls.length };
}

// ---------------- Home dashboard ----------------

export type FeedItem = {
  id: string;
  kind: "expense" | "income" | "food" | "workout";
  title: string;
  subtitle: string;
  amount?: number;
  at: string;
};

export type HomeData = {
  spendToday: number;
  proteinToday: number;
  caloriesToday: number;
  workoutsToday: number;
  feed: FeedItem[];
};

export async function loadHome(): Promise<HomeData> {
  const supabase = getSupabase();
  const dayStartMs = new Date(startOfTodayIST()).getTime();

  const [ledgerRes, foodRes, workoutRes] = await Promise.all([
    supabase
      .from("ledger_entries")
      .select("id, amount, direction, merchant, description, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(40),
    supabase
      .from("food_logs")
      .select("id, description, meal_slot, calories_estimate, protein_g, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(40),
    supabase
      .from("workout_logs")
      .select("id, description, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(40),
  ]);

  const ledger = ledgerRes.data || [];
  const food = foodRes.data || [];
  const workouts = workoutRes.data || [];

  // Compare by epoch — occurred_at comes back UTC-offset while dayStart is +05:30,
  // so a string compare would be wrong across the offset boundary.
  const isToday = (iso: string) => new Date(iso).getTime() >= dayStartMs;

  const spendToday = ledger
    .filter((r) => r.direction === "expense" && isToday(r.occurred_at))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const proteinToday = food
    .filter((r) => isToday(r.occurred_at))
    .reduce((s, r) => s + Number(r.protein_g || 0), 0);
  const caloriesToday = food
    .filter((r) => isToday(r.occurred_at))
    .reduce((s, r) => s + Number(r.calories_estimate || 0), 0);
  const workoutsToday = workouts.filter((r) => isToday(r.occurred_at)).length;

  const feed: FeedItem[] = [
    ...ledger.map((r) => ({
      id: `l-${r.id}`,
      kind: (r.direction === "income" ? "income" : "expense") as FeedItem["kind"],
      title: r.merchant || r.description || (r.direction === "income" ? "Income" : "Expense"),
      subtitle: r.description || "",
      amount: Number(r.amount || 0),
      at: r.occurred_at,
    })),
    ...food.map((r) => ({
      id: `f-${r.id}`,
      kind: "food" as const,
      title: r.description || "Meal",
      subtitle: [r.meal_slot, r.protein_g ? `${Math.round(Number(r.protein_g))}g protein` : ""].filter(Boolean).join(" · "),
      at: r.occurred_at,
    })),
    ...workouts.map((r) => ({
      id: `w-${r.id}`,
      kind: "workout" as const,
      title: r.description || "Workout",
      subtitle: "Gym",
      at: r.occurred_at,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 24);

  return { spendToday, proteinToday, caloriesToday, workoutsToday, feed };
}
