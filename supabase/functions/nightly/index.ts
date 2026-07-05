// deno-lint-ignore-file no-explicit-any
// Trackerz "nightly" proactive brain. pg_cron (via pg_net) POSTs here twice a
// day with a shared-secret header — nothing is signed in when cron runs, so this
// endpoint is NOT JWT-gated for the cron path. For every user with
// profiles.briefing_enabled it:
//   1. pulls their recent ledger/food/wellness/body/plan rows with service role,
//   2. runs the SAME pure insight detectors + briefing composer the app runs
//      (imported from ../_shared — byte-identical copies of src/analytics +
//      src/domain, enforced by tests/nightly-parity.test.mjs),
//   3. upserts a briefings row (so the app is fresh even if never opened), and
//   4. sends a real Web Push notification to every registered device.
//
// Ops (POST JSON body):
//   { op: "vapid" }                    -> { publicKey } (public info, no auth)
//   { slot?: "morning"|"evening" }     + x-nightly-secret header -> cron fan-out
//   { op: "run-self", slot? }          + user JWT -> generate + push own briefing
//   { op: "test-push" }                + user JWT -> push a test notification
//
// Secrets (env first, then public.app_secrets): NIGHTLY_SECRET,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional mailto:).

import { createClient } from "npm:@supabase/supabase-js@2.74.0";
import webpush from "npm:web-push@3.6.7";

import { buildInsightFeed } from "../_shared/src/analytics/insights-engine.js";
import { buildBriefing } from "../_shared/src/analytics/briefing.js";
import { resolveDietTargets } from "../_shared/src/domain/goals.js";
import {
  planForDate, localDateKey, parsePlanScope,
  setDietPlanOverride, setGymPlanOverride, setDatedPlanOverrides,
} from "../_shared/src/domain/diet/plan.js";
import { isPlanDelta } from "../_shared/lib/plan-merge.mjs";
import { historyFromBriefings, filterNovel, insightSignature } from "../_shared/lib/habituation.mjs";
import { wander } from "../_shared/lib/mind-wander.mjs";
import { consolidate } from "../_shared/lib/consolidate.mjs";
import { calibrate } from "../_shared/lib/calibration.mjs";

const APP_URL = Deno.env.get("APP_URL") || "https://ubhayaab.github.io/trackerz/";
const DEFAULT_TZ = "Asia/Kolkata";

// -------- env / clients (same pattern as the agent function) --------

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

const _secretCache = new Map<string, string>();
async function resolveSecret(name: string): Promise<string> {
  const fromEnv = Deno.env.get(name);
  if (fromEnv) return fromEnv;
  if (_secretCache.has(name)) return _secretCache.get(name)!;
  const admin = adminClient();
  const { data, error } = await admin.from("app_secrets").select("value").eq("name", name).maybeSingle();
  if (error) throw new Error(`app_secrets read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Missing secret ${name} (env + app_secrets both empty)`);
  _secretCache.set(name, data.value);
  return data.value;
}
async function resolveSecretOptional(name: string): Promise<string | null> {
  try { return await resolveSecret(name); } catch { return null; }
}

// -------- timezone: everything runs in the USER's wall clock --------
// The detectors/composer compare dates with plain `new Date(iso)` local-time
// getters, and this isolate runs in UTC. So we re-express every timestamp as the
// user's WALL-CLOCK time ("sv-SE" gives sortable "YYYY-MM-DD HH:mm:ss") and hand
// those to the pure layer — all comparisons then happen in one consistent frame.

function wallClock(iso: string | Date, tz: string): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleString("sv-SE", { timeZone: tz });
}
function wallNow(tz: string): Date {
  return new Date(wallClock(new Date(), tz));
}
function shiftRows<T extends { occurred_at?: string }>(rows: T[], tz: string): T[] {
  return (rows || []).map((r) => r.occurred_at ? { ...r, occurred_at: wallClock(r.occurred_at, tz) } : r);
}

// -------- per-user data --------

async function fetchUserRows(supabase: ReturnType<typeof adminClient>, userId: string) {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const q = (table: string, cols: string, opts: { sinceDays?: number; limit?: number; extra?: (b: any) => any } = {}) => {
    let b = supabase.from(table).select(cols).eq("user_id", userId).order("occurred_at", { ascending: false });
    if (opts.sinceDays) b = b.gte("occurred_at", since(opts.sinceDays));
    if (opts.extra) b = opts.extra(b);
    return b.limit(opts.limit || 400).then(({ data }: any) => data || []);
  };
  const [ledger, foodLogs, wellnessLogs, bodyMetrics, workoutLogs] = await Promise.all([
    q("ledger_entries", "id, occurred_at, merchant, description, amount, currency, direction, is_discretionary, tags, duplicate_state", { sinceDays: 60, limit: 800 }),
    q("food_logs", "id, occurred_at, meal_name, meal_slot, description, calories_estimate, protein_g, carbs_g, fat_g", { sinceDays: 30 }),
    q("wellness_logs", "id, occurred_at, note, mood_score, energy_score, stress_score", { sinceDays: 30, limit: 200 }),
    q("body_metrics", "id, occurred_at, metric_type, value, unit", { limit: 400 }),
    q("workout_logs", "id, occurred_at, description, duration_min, intensity", { sinceDays: 14, limit: 100 }),
  ]);
  const [{ data: budgets }, { data: subscriptions }, { data: userPlans }, { data: pushSubs }] = await Promise.all([
    supabase.from("budgets").select("id, kind, period, amount, starts_on").eq("user_id", userId),
    supabase.from("subscriptions").select("id, merchant, cadence_days, median_amount, next_expected_at, is_active").eq("user_id", userId).eq("is_active", true),
    supabase.from("user_plans").select("id, kind, scope, payload, active, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
    supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId),
  ]);
  // Cognitive inputs: durable memory, open threads, and recent briefings (the
  // habituation history — what was already said in the last few days).
  const [{ data: memoryFacts }, { data: notes }, { data: recentBriefings }] = await Promise.all([
    supabase.from("memory_facts").select("key, value, kind, confidence, source, updated_at").eq("user_id", userId).limit(100),
    supabase.from("notes").select("id, body, kind, domain, status, occurred_at, created_at").eq("user_id", userId).neq("status", "archived").order("occurred_at", { ascending: false }).limit(50),
    supabase.from("briefings").select("kind, for_date, body, payload, seen").eq("user_id", userId).order("for_date", { ascending: false }).limit(10),
  ]);
  return {
    ledger, foodLogs, wellnessLogs, bodyMetrics, workoutLogs,
    budgets: budgets || [], subscriptions: subscriptions || [],
    userPlans: userPlans || [], pushSubs: pushSubs || [],
    memoryFacts: memoryFacts || [], notes: notes || [], recentBriefings: recentBriefings || [],
  };
}

// ---- the sleep cycle: consolidation + forgetting -----------------------------
// Evening runs compress the trailing weeks into memory_facts patterns and decay
// the stale ones (see lib/consolidate.mjs). Deletes are audit-logged so the
// forgetting is inspectable.
async function runConsolidation(
  supabase: ReturnType<typeof adminClient>,
  userId: string, rows: any, now: Date,
) {
  const plan = consolidate(rows, rows.memoryFacts, now);
  for (const u of plan.upserts) {
    await supabase.from("memory_facts").upsert({
      user_id: userId, key: u.key, value: u.value, kind: u.kind,
      confidence: u.confidence, source: "ai", updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,key" });
  }
  for (const d of plan.decays) {
    await supabase.from("memory_facts")
      .update({ confidence: d.confidence, updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("key", d.key);
  }
  for (const del of plan.deletes) {
    await supabase.from("audit_log").insert({
      user_id: userId, action: "memory_decay", target_table: "memory_facts", target_id: null,
      before: { key: del.key, confidence: del.was }, after: null, source: "system",
    });
    await supabase.from("memory_facts").delete().eq("user_id", userId).eq("key", del.key);
  }
  return { upserted: plan.upserts.length, decayed: plan.decays.length, forgotten: plan.deletes.length };
}

// ---- weekly metacognition: was I wrong, and where? ---------------------------
// Sunday evenings: check which auto-applied writes from the last 7 days the
// user deleted, write the error profile into weekly_reviews, and hand back a
// one-line confession for the briefing.
async function runCalibration(
  supabase: ReturnType<typeof adminClient>,
  userId: string, now: Date,
) {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { data: actions } = await supabase.from("ai_actions")
    .select("tool_name, status, confidence, applied_record_table, applied_record_id, created_at")
    .eq("user_id", userId).eq("status", "auto_applied").gte("created_at", since).limit(500);
  const byTable = new Map<string, string[]>();
  for (const a of actions || []) {
    if (!a.applied_record_table || !a.applied_record_id) continue;
    if (!byTable.has(a.applied_record_table)) byTable.set(a.applied_record_table, []);
    byTable.get(a.applied_record_table)!.push(a.applied_record_id);
  }
  const survivingIds = new Set<string>();
  for (const [table, ids] of byTable) {
    const { data } = await supabase.from(table).select("id").in("id", ids);
    for (const r of data || []) survivingIds.add(r.id);
  }
  const result = calibrate({ actions: actions || [], survivingIds });
  const weekStart = new Date(now.getTime() - 6 * 86_400_000);
  await supabase.from("weekly_reviews").upsert({
    user_id: userId,
    week_start: localDateKey(weekStart),
    summary: { calibration: result, generated_by: "nightly" },
  }, { onConflict: "user_id,week_start" });
  return result;
}

// Hydrate the plan resolver's override registries from user_plans rows —
// mirrors the loop in src/state/sync.js (permanent full payloads win newest-
// first; date-scoped rows collect per date, folded oldest->newest).
function hydratePlans(userPlans: any[]) {
  let permanentDiet: any = null;
  let permanentGym: any = null;
  const datedDiet = new Map<string, any[]>();
  const datedGym = new Map<string, any[]>();
  for (const p of userPlans) {
    if (p.active === false) continue;
    const { kind: scopeKind, dates } = parsePlanScope(p.scope);
    if (scopeKind === "permanent") {
      if (p.kind === "diet" && !permanentDiet && !isPlanDelta(p.payload)) permanentDiet = p.payload;
      if (p.kind === "gym" && !permanentGym && !isPlanDelta(p.payload)) permanentGym = p.payload;
    } else if (scopeKind === "dates") {
      const target = p.kind === "gym" ? datedGym : datedDiet;
      for (const d of dates) { if (!target.has(d)) target.set(d, []); target.get(d)!.push(p.payload); }
    }
  }
  for (const m of [datedDiet, datedGym]) for (const [k, v] of m) m.set(k, v.slice().reverse());
  setDietPlanOverride(permanentDiet);
  setGymPlanOverride(permanentGym);
  setDatedPlanOverrides({ diet: datedDiet, gym: datedGym });
}

function sameWallDay(a: string, now: Date): boolean {
  if (!a) return false;
  const d = new Date(a);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Build the snapshot buildBriefing() consumes — the server-side twin of
// src/services/briefing.js snapshotFromState(), computed from rows not app state.
function buildSnapshot(rows: any, now: Date) {
  const plan = planForDate(now);
  const budgets = rows.budgets || [];
  const monthly = budgets.find((b: any) => b.kind === "monthly_spend")?.amount;
  const weekly = budgets.find((b: any) => b.kind === "weekly_spend")?.amount;
  const dailySpendCap = monthly != null ? Math.round(Number(monthly) / 30)
    : (weekly != null ? Math.round(Number(weekly) / 7) : null);
  const todayFoods = rows.foodLogs.filter((r: any) => sameWallDay(r.occurred_at, now));
  const proteinToday = todayFoods.reduce((s: number, r: any) => s + (Number(r.protein_g) || 0), 0);
  const caloriesToday = todayFoods.reduce((s: number, r: any) => s + (Number(r.calories_estimate) || 0), 0);
  const todaySpend = rows.ledger
    .filter((r: any) => r.direction === "expense" && sameWallDay(r.occurred_at, now))
    .reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
  const workoutLoggedToday = rows.workoutLogs.some((w: any) => sameWallDay(w.occurred_at, now));
  const targets = resolveDietTargets(budgets, plan.macroTargets);
  const plannedMeals = plan.meals?.length || 0;
  return {
    forDate: localDateKey(now),
    weekdayName: plan.weekdayName,
    dietLabel: plan.dietLabel,
    workoutName: plan.workout?.name,
    workoutKind: plan.workout?.kind,
    proteinToday,
    proteinTarget: targets.protein_g,
    caloriesToday,
    caloriesTarget: targets.calories,
    todaySpend,
    dailySpendCap,
    workoutLoggedToday,
    planItemsLeft: Math.max(0, plannedMeals - todayFoods.length),
    mealsLoggedToday: todayFoods.length,
  };
}

// -------- web push --------

let _vapidReady = false;
async function ensureVapid() {
  if (_vapidReady) return;
  const publicKey = await resolveSecret("VAPID_PUBLIC_KEY");
  const privateKey = await resolveSecret("VAPID_PRIVATE_KEY");
  const subject = (await resolveSecretOptional("VAPID_SUBJECT")) || "mailto:ubhayvatsaanand@gmail.com";
  webpush.setVapidDetails(subject, publicKey, privateKey);
  _vapidReady = true;
}

// Send to every device; prune subscriptions the push service says are gone.
async function pushToUser(
  supabase: ReturnType<typeof adminClient>,
  pushSubs: any[],
  payload: { title: string; body: string; url: string; tag: string },
): Promise<{ sent: number; pruned: number; errors: string[] }> {
  if (!pushSubs.length) return { sent: 0, pruned: 0, errors: [] };
  await ensureVapid();
  let sent = 0, pruned = 0;
  const errors: string[] = [];
  for (const sub of pushSubs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 12 * 3600 },
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode || 0;
      if (code === 404 || code === 410) {
        await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        pruned++;
      } else {
        errors.push(`push ${code}: ${String(err?.message || err).slice(0, 120)}`);
      }
    }
  }
  return { sent, pruned, errors };
}

// -------- the per-user run --------

function slotFor(now: Date): "morning" | "evening" {
  return now.getHours() < 12 ? "morning" : "evening";
}

async function runForUser(
  supabase: ReturnType<typeof adminClient>,
  user: { id: string; timezone?: string },
  slot?: "morning" | "evening",
) {
  const tz = user.timezone || DEFAULT_TZ;
  const now = wallNow(tz);
  const useSlot = slot || slotFor(now);
  const raw = await fetchUserRows(supabase, user.id);
  const rows = {
    ...raw,
    ledger: shiftRows(raw.ledger, tz),
    foodLogs: shiftRows(raw.foodLogs, tz),
    wellnessLogs: shiftRows(raw.wellnessLogs, tz),
    bodyMetrics: shiftRows(raw.bodyMetrics, tz),
    workoutLogs: shiftRows(raw.workoutLogs, tz),
  };

  hydratePlans(rows.userPlans);
  const snapshot = buildSnapshot(rows, now);
  const feed = buildInsightFeed({
    ledger: rows.ledger, foodLogs: rows.foodLogs, wellnessLogs: rows.wellnessLogs,
    bodyMetrics: rows.bodyMetrics, budgets: rows.budgets, subscriptions: rows.subscriptions,
    today: now, proteinTargetG: snapshot.proteinTarget || 130,
  });
  const brief = buildBriefing(useSlot, snapshot);

  // Habituation: what did the last few briefings already say? Repeats (except
  // critical ones) are suppressed so the brain never sounds like a broken
  // record. Then mind-wandering picks one novel thought and one question.
  // (Excluding this very slot's existing row — a same-day re-run must not
  // habituate against its own previous output and shrink to nothing.)
  const history = historyFromBriefings(
    rows.recentBriefings
      .filter((b: any) => !(b.kind === useSlot && b.for_date === brief.forDate))
      .map((b: any) => b.payload),
  );
  const { fresh: freshInsights } = filterNovel(feed.items, history);
  const candidates = wander(
    { ledger: rows.ledger, foodLogs: rows.foodLogs, workoutLogs: rows.workoutLogs, bodyMetrics: rows.bodyMetrics, notes: rows.notes },
    { seed: `${user.id}|${brief.forDate}|${useSlot}`, now },
  );
  const freshCandidates = candidates.filter((c: any) => !history.has(insightSignature(c.text)));
  const thought = freshCandidates.find((c: any) => c.kind === "wander" || c.kind === "dream") || null;
  const question = freshCandidates.find((c: any) => c.kind === "question") || null;

  // The sleep cycle: evening runs consolidate the day into durable memory and
  // decay what stopped being true; Sunday evening also runs calibration.
  let consolidation = null;
  let calibration: any = null;
  if (useSlot === "evening") {
    consolidation = await runConsolidation(supabase, user.id, rows, now).catch(() => null);
    if (now.getDay() === 0) calibration = await runCalibration(supabase, user.id, now).catch(() => null);
  }

  const payload: Record<string, unknown> = {
    ...brief.payload,
    insights: freshInsights.map((it: any) => it.text).slice(0, 6),
    ...(thought ? { thought: { kind: thought.kind, text: thought.text } } : {}),
    ...(question ? { question: question.text } : {}),
    ...(calibration ? { calibration: calibration.line } : {}),
    ...(consolidation ? { consolidation } : {}),
  };

  // Preserve a dismissed briefing's seen flag when a re-run produces the same
  // body — otherwise every cron retry resurfaces it.
  const existing = rows.recentBriefings.find((b: any) => b.kind === useSlot && b.for_date === brief.forDate);
  const seen = existing && existing.body === brief.body ? Boolean(existing.seen) : false;

  const { error: upsertErr } = await supabase.from("briefings").upsert({
    user_id: user.id, kind: useSlot, for_date: brief.forDate,
    body: brief.body, payload, seen,
  }, { onConflict: "user_id,kind,for_date" });
  if (upsertErr) throw new Error(`briefings upsert: ${upsertErr.message}`);

  const title = useSlot === "morning" ? "Trackerz — morning briefing" : "Trackerz — evening check-in";
  const extra = thought ? ` ${thought.text}` : (freshInsights[0] ? ` ${freshInsights[0].text}` : "");
  const push = await pushToUser(supabase, rows.pushSubs, {
    title,
    body: `${brief.body}${extra}`.slice(0, 240),
    url: APP_URL,
    tag: `briefing-${useSlot}-${brief.forDate}`,
  });
  return { userId: user.id, slot: useSlot, forDate: brief.forDate, body: brief.body, thought: thought?.text || null, question: question?.text || null, ...push };
}

// -------- handler --------

Deno.serve(async (req) => {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-nightly-secret",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({} as any));
    const op = String(body?.op || "");
    const slot = ["morning", "evening"].includes(body?.slot) ? body.slot : undefined;
    const supabase = adminClient();

    // Public: the client needs the VAPID public key to subscribe. Not a secret.
    if (op === "vapid") {
      const publicKey = await resolveSecretOptional("VAPID_PUBLIC_KEY");
      if (!publicKey) return Response.json({ ok: false, error: "vapid_not_configured" }, { status: 503, headers: corsHeaders });
      return Response.json({ ok: true, publicKey }, { headers: corsHeaders });
    }

    // Cron path: shared secret, fan out over every briefing-enabled user.
    const givenSecret = req.headers.get("x-nightly-secret") || "";
    if (givenSecret) {
      const expected = await resolveSecretOptional("NIGHTLY_SECRET");
      if (!expected || givenSecret !== expected) {
        return Response.json({ ok: false, error: "bad_secret" }, { status: 401, headers: corsHeaders });
      }
      const { data: users, error } = await supabase
        .from("profiles").select("id, timezone, briefing_enabled").eq("briefing_enabled", true);
      if (error) throw error;
      const results: any[] = [];
      for (const u of users || []) {
        try {
          const r = await runForUser(supabase, u, slot);
          results.push({ userId: r.userId, slot: r.slot, sent: r.sent, pruned: r.pruned, errors: r.errors });
        } catch (err) {
          results.push({ userId: u.id, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
        }
      }
      return Response.json({ ok: true, users: results.length, results }, { headers: corsHeaders });
    }

    // User path: JWT-verified, only ever acts on the caller's own rows.
    const auth = req.headers.get("authorization") || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!jwt) return Response.json({ ok: false, error: "missing_auth" }, { status: 401, headers: corsHeaders });
    const { data: userResp, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userResp?.user?.id) {
      return Response.json({ ok: false, error: "invalid_auth" }, { status: 401, headers: corsHeaders });
    }
    const userId = userResp.user.id;

    if (op === "test-push") {
      const { data: subs } = await supabase.from("push_subscriptions")
        .select("id, endpoint, p256dh, auth").eq("user_id", userId);
      const push = await pushToUser(supabase, subs || [], {
        title: "Trackerz — test notification",
        body: "Push is working. Jarvis can now reach you even when the app is closed.",
        url: APP_URL, tag: "test-push",
      });
      return Response.json({ ok: true, devices: (subs || []).length, ...push }, { headers: corsHeaders });
    }

    if (op === "run-self") {
      const { data: profile } = await supabase.from("profiles")
        .select("id, timezone").eq("id", userId).maybeSingle();
      const r = await runForUser(supabase, { id: userId, timezone: profile?.timezone }, slot);
      return Response.json({ ok: true, ...r }, { headers: corsHeaders });
    }

    return Response.json({ ok: false, error: "unknown_op" }, { status: 400, headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
