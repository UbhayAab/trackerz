import assert from "node:assert/strict";
import {
  toolDomain, actionOutcome, entryOutcome, buildAuditEntries,
  auditTotals, summarizeIngestion, formatCost, filterAuditEntries,
  groupByDay, auditEntryHtml, auditTotalsHtml,
  toolActionType, summarizeToolArgs, ACTION_FILTERS,
} from "../src/ui/audit-log.js";

const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} !~= ${b}`);

// ---- toolDomain: every tool + poly-domain branches ----
assert.equal(toolDomain("create_expense_candidate"), "money");
assert.equal(toolDomain("create_income_candidate"), "money");
assert.equal(toolDomain("create_transfer_candidate"), "money");
assert.equal(toolDomain("create_statement_row_candidate"), "money");
assert.equal(toolDomain("create_food_log_candidate"), "diet");
assert.equal(toolDomain("create_workout_log_candidate"), "gym");
assert.equal(toolDomain("create_body_metric_candidate"), "wellness");
assert.equal(toolDomain("create_wellness_note_candidate"), "wellness");
assert.equal(toolDomain("set_target_candidate", { kind: "monthly_spend" }), "money");
assert.equal(toolDomain("set_target_candidate", { kind: "weekly_spend" }), "money");
assert.equal(toolDomain("set_target_candidate", { kind: "daily_calories" }), "diet");
assert.equal(toolDomain("set_target_candidate", { kind: "daily_protein" }), "diet");
assert.equal(toolDomain("set_target_candidate", { kind: "weekly_calories" }), "diet");
assert.equal(toolDomain("set_target_candidate", { kind: "food_cap" }), "diet");
assert.equal(toolDomain("update_plan_candidate", { kind: "gym" }), "gym");
assert.equal(toolDomain("update_plan_candidate", { kind: "diet" }), "diet");
assert.equal(toolDomain("update_plan_candidate", {}), "diet");
assert.equal(toolDomain("create_note_candidate", { domain: "money" }), "money");
assert.equal(toolDomain("create_note_candidate", { domain: "wellness" }), "wellness");
assert.equal(toolDomain("create_note_candidate", { domain: "general" }), "general");
assert.equal(toolDomain("create_note_candidate", {}), "general");
assert.equal(toolDomain("create_note_candidate", { domain: "bogus" }), "general");
assert.equal(toolDomain("remember_fact"), "memory");
assert.equal(toolDomain("link_duplicate_candidates"), "money");
assert.equal(toolDomain("request_user_review"), "review");
assert.equal(toolDomain("totally_unknown_tool"), "other");
assert.equal(toolDomain(undefined), "other");

// ---- actionOutcome: every status ----
assert.equal(actionOutcome("auto_applied"), "applied");
assert.equal(actionOutcome("applied"), "applied");
assert.equal(actionOutcome("rejected"), "rejected");
assert.equal(actionOutcome("errored"), "errored");
assert.equal(actionOutcome("proposed"), "review");
assert.equal(actionOutcome("weird"), "other");
assert.equal(actionOutcome(undefined), "other");

// ---- entryOutcome: precedence ----
assert.equal(entryOutcome({ runs: [], actions: [], status: "queued" }), "queued");
assert.equal(entryOutcome({ runs: [{ status: "errored" }], actions: [], status: "processed" }), "errored");
assert.equal(entryOutcome({ runs: [{}], actions: [{ status: "proposed" }, { status: "auto_applied" }] }), "review",
  "review outranks applied");
assert.equal(entryOutcome({ runs: [{}], actions: [{ status: "auto_applied" }, { status: "rejected" }] }), "applied",
  "applied outranks a stray rejection");
assert.equal(entryOutcome({ runs: [{}], actions: [{ status: "rejected" }, { status: "rejected" }] }), "rejected",
  "all-rejected -> rejected");
assert.equal(entryOutcome({ runs: [{ status: "completed" }], actions: [] }), "no_action");
// a queued capture that nonetheless has runs is not "queued"
assert.equal(entryOutcome({ runs: [{ status: "completed" }], actions: [{ status: "auto_applied" }], status: "queued" }), "applied");

// ---- buildAuditEntries: the real join, with a realistic fixture ----
const fixture = {
  ingestions: [
    { id: "A", raw_text: "ate omelette for 70", source_type: "text", capture_mode: "auto", status: "processed", occurred_at: "2026-06-30T08:00:00Z", created_at: "2026-06-30T08:00:05Z" },
    { id: "B", raw_text: "bought paneer for 250", source_type: "text", capture_mode: "auto", status: "processed", created_at: "2026-06-30T07:30:00Z" },
    { id: "C", raw_text: "<script>alert('x')</script> grocery 250", source_type: "image", capture_mode: "auto", status: "processed", created_at: "2026-06-30T07:00:00Z" },
    { id: "E", raw_text: "how much did I spend this month?", source_type: "text", capture_mode: "auto", status: "processed", created_at: "2026-06-30T06:00:00Z" },
    { id: "D", raw_text: "voice note about lunch", source_type: "audio", capture_mode: "auto", status: "queued", created_at: "2026-06-30T05:00:00Z" },
    { id: "F", raw_text: "broken capture", source_type: "text", capture_mode: "auto", status: "processed", created_at: "2026-06-29T22:00:00Z" },
  ],
  runs: [
    // A processed by two runs (gemini extract + deepseek reason); deepseek first
    // in the array so it is the headline model. Costs/latency must SUM.
    { id: "rA1", ingestion_id: "A", provider: "deepseek", model: "deepseek-reasoner", prompt_tokens: "1200", output_tokens: 300, estimated_cost_usd: "0.0004", latency_ms: 800, status: "completed", created_at: "2026-06-30T08:00:05Z" },
    { id: "rA2", ingestion_id: "A", provider: "gemini", model: "gemini-2.5-flash", prompt_tokens: 50, output_tokens: 20, estimated_cost_usd: 0.0001, latency_ms: 200, status: "completed", created_at: "2026-06-30T08:00:04Z" },
    { id: "rB", ingestion_id: "B", provider: "deepseek", model: "deepseek-reasoner", estimated_cost_usd: 0.0002, latency_ms: 500, status: "completed" },
    { id: "rC", ingestion_id: "C", provider: "gemini", model: "gemini-2.5-flash", estimated_cost_usd: 0.0003, latency_ms: 900, status: "completed" },
    { id: "rE", ingestion_id: "E", provider: "deepseek", model: "deepseek-reasoner", estimated_cost_usd: 0.0001, latency_ms: 300, status: "completed" },
    { id: "rF", ingestion_id: "F", provider: "deepseek", model: "deepseek-reasoner", status: "errored", error_message: "timeout" },
    { id: "orphanRun", ingestion_id: "ZZZ", model: "ghost", estimated_cost_usd: 9, latency_ms: 9 }, // no matching ingestion -> ignored
    { id: "nullRun", ingestion_id: null, model: "ghost" }, // ignored
  ],
  actions: [
    // A: emitted out of created_at order to prove they get sorted ascending.
    { id: "aFood", ingestion_id: "A", ai_run_id: "rA1", tool_name: "create_food_log_candidate", arguments: { meal_slot: "breakfast" }, confidence: 0.62, status: "auto_applied", applied_record_table: "food_logs", applied_record_id: "f1", created_at: "2026-06-30T08:00:07Z" },
    { id: "aExp", ingestion_id: "A", ai_run_id: "rA1", tool_name: "create_expense_candidate", arguments: { amount: 70 }, confidence: 0.9, status: "auto_applied", applied_record_table: "ledger_entries", applied_record_id: "l1", created_at: "2026-06-30T08:00:06Z" },
    { id: "bExp", ingestion_id: "B", tool_name: "create_expense_candidate", arguments: { amount: 250, is_discretionary: false }, confidence: 0.88, status: "auto_applied", created_at: "2026-06-30T07:30:01Z" },
    { id: "cExp", ingestion_id: "C", tool_name: "create_expense_candidate", arguments: { amount: 250 }, confidence: 0.5, status: "rejected", created_at: "2026-06-30T07:00:01Z" },
    { id: "eRev", ingestion_id: "E", tool_name: "request_user_review", arguments: { reason: "query" }, confidence: 0, status: "proposed", created_at: "2026-06-30T06:00:01Z" },
    { id: "orphanAct", ingestion_id: "ZZZ", tool_name: "create_expense_candidate", status: "auto_applied" }, // ignored
    { id: "nullAct", ingestion_id: null, tool_name: "create_expense_candidate", status: "auto_applied" }, // ignored
  ],
};

const entries = buildAuditEntries(fixture);
const by = Object.fromEntries(entries.map((e) => [e.id, e]));

// input order preserved (newest first)
assert.deepEqual(entries.map((e) => e.id), ["A", "B", "C", "E", "D", "F"]);

// A: two applied actions, sorted by created_at, summed cost+latency, headline model
assert.equal(by.A.toolCount, 2);
assert.equal(by.A.appliedCount, 2);
assert.equal(by.A.rejectedCount, 0);
assert.equal(by.A.reviewCount, 0);
assert.deepEqual(by.A.actions.map((a) => a.id), ["aExp", "aFood"], "actions sorted ascending by created_at");
assert.deepEqual(by.A.domains, ["money", "diet"]);
assert.equal(by.A.model, "deepseek-reasoner");
approx(by.A.costUsd, 0.0005);
assert.equal(by.A.latencyMs, 1000);
assert.equal(by.A.outcome, "applied");
assert.equal(by.A.runs[0].promptTokens, 1200, "string token coerced to number");
assert.equal(by.A.appliedCount, by.A.actions.filter((a) => a.appliedTable).length);

// B: single applied money expense
assert.equal(by.B.outcome, "applied");
assert.deepEqual(by.B.domains, ["money"]);
approx(by.B.costUsd, 0.0002);

// C: rejected expense, HTML in raw text retained as data
assert.equal(by.C.outcome, "rejected");
assert.equal(by.C.rejectedCount, 1);
assert.equal(by.C.appliedCount, 0);
assert.equal(by.C.model, "gemini-2.5-flash");

// E: a question -> review, no domains (review is excluded from the domain list)
assert.equal(by.E.outcome, "review");
assert.equal(by.E.reviewCount, 1);
assert.deepEqual(by.E.domains, []);

// D: queued, edge offline -> no runs/actions
assert.equal(by.D.outcome, "queued");
assert.equal(by.D.runs.length, 0);
assert.equal(by.D.toolCount, 0);

// F: errored run, no actions
assert.equal(by.F.outcome, "errored");
assert.equal(by.F.runs[0].errorMessage, "timeout");

// orphans never leak in
assert.ok(!entries.some((e) => e.actions.some((a) => a.id === "orphanAct")));
assert.ok(!entries.some((e) => e.runs.some((r) => r.id === "orphanRun")));

// empty input is safe
assert.deepEqual(buildAuditEntries(), []);
assert.deepEqual(buildAuditEntries({}), []);

// ---- auditTotals ----
const totals = auditTotals(entries);
assert.equal(totals.queries, 6);
assert.equal(totals.toolCalls, 5);
assert.equal(totals.applied, 3);
assert.equal(totals.rejected, 1);
assert.equal(totals.review, 1);
approx(totals.costUsd, 0.0011);
assert.deepEqual(totals.byDomain, { money: 3, diet: 1 });

// ---- summarizeIngestion ----
assert.equal(summarizeIngestion(by.A), "2 tool calls · 2 applied · money, diet · deepseek-reasoner · $0.00050 · 1000ms");
assert.equal(summarizeIngestion(by.D), "queued - agent offline, nothing processed yet");
assert.equal(summarizeIngestion(by.F), "errored · deepseek-reasoner");
assert.equal(summarizeIngestion(by.E), "1 tool call · 1 to review · deepseek-reasoner · $0.00010 · 300ms");
assert.equal(summarizeIngestion(by.C), "1 tool call · 1 rejected · money · gemini-2.5-flash · $0.00030 · 900ms");
assert.equal(summarizeIngestion(null), "");

// ---- formatCost ----
assert.equal(formatCost(0), "$0");
assert.equal(formatCost(-5), "$0");
assert.equal(formatCost(0.0005), "$0.00050");
assert.equal(formatCost(0.5), "$0.500");
assert.equal(formatCost(2), "$2.000");

// ---- filterAuditEntries ----
const ids = (arr) => arr.map((e) => e.id);
assert.deepEqual(ids(filterAuditEntries(entries, { domain: "money" })), ["A", "B", "C"]);
assert.deepEqual(ids(filterAuditEntries(entries, { domain: "diet" })), ["A"]);
assert.deepEqual(ids(filterAuditEntries(entries, { outcome: "applied" })), ["A", "B"]);
assert.deepEqual(ids(filterAuditEntries(entries, { outcome: "queued" })), ["D"]);
assert.deepEqual(ids(filterAuditEntries(entries, { outcome: "rejected" })), ["C"]);
assert.deepEqual(ids(filterAuditEntries(entries, { outcome: "review" })), ["E"]);
assert.deepEqual(ids(filterAuditEntries(entries, { query: "paneer" })), ["B"]);
assert.deepEqual(ids(filterAuditEntries(entries, { query: "PANEER" })), ["B"], "search is case-insensitive");
assert.deepEqual(ids(filterAuditEntries(entries, { domain: "money", outcome: "applied" })), ["A", "B"]);
assert.deepEqual(ids(filterAuditEntries(entries, { domain: "diet", query: "paneer" })), []);
assert.deepEqual(ids(filterAuditEntries(entries, {})), entries.map((e) => e.id), "no filter = passthrough");

// ---- groupByDay ----
const groups = groupByDay(entries);
assert.deepEqual(groups.map((g) => g.day), ["2026-06-30", "2026-06-29"]);
assert.deepEqual(ids(groups[0].entries), ["A", "B", "C", "E", "D"]);
assert.deepEqual(ids(groups[1].entries), ["F"]);

// ---- auditEntryHtml: must escape raw user text (XSS) ----
const htmlC = auditEntryHtml(by.C);
assert.ok(!htmlC.includes("<script>"), "raw <script> must not survive into markup");
assert.ok(htmlC.includes("&lt;script&gt;"), "raw text is HTML-escaped");
assert.ok(htmlC.includes("rejected"), "outcome label rendered");
const htmlA = auditEntryHtml(by.A);
assert.ok(htmlA.includes("create_expense_candidate") && htmlA.includes("create_food_log_candidate"));
assert.ok(htmlA.includes("applied"));
// media capture with empty text shows a placeholder, not a blank line
const htmlMedia = auditEntryHtml({ ...by.D, rawText: "" });
assert.ok(htmlMedia.includes("media capture"));

// ---- auditTotalsHtml ----
const tHtml = auditTotalsHtml(totals);
assert.ok(tHtml.includes("6") && tHtml.includes("queries"));
assert.ok(tHtml.includes("$0.00110") || tHtml.includes("spent"));

// ---- toolActionType ----
assert.equal(toolActionType("create_expense_candidate"), "expense");
assert.equal(toolActionType("create_income_candidate"), "income");
assert.equal(toolActionType("create_food_log_candidate"), "food");
assert.equal(toolActionType("create_workout_log_candidate"), "workout");
assert.equal(toolActionType("update_plan_candidate"), "plan");
assert.equal(toolActionType("set_target_candidate"), "target");
assert.equal(toolActionType("create_note_candidate"), "note");
assert.equal(toolActionType("remember_fact"), "memory");
assert.equal(toolActionType("request_user_review"), "review");
assert.equal(toolActionType("mystery"), "other");
assert.ok(ACTION_FILTERS[0][0] === "all", "action filter starts with All");

// ---- summarizeToolArgs (the AI-output half of the chain) ----
assert.equal(summarizeToolArgs("create_expense_candidate", { amount: 70, merchant: "Zomato" }), "₹70 · Zomato");
assert.equal(summarizeToolArgs("create_food_log_candidate", { meal_slot: "lunch", description: "2 rotis dal" }), "lunch: 2 rotis dal");
assert.equal(summarizeToolArgs("set_target_candidate", { kind: "daily_calories", amount: 1800 }), "daily_calories → 1800");
assert.equal(summarizeToolArgs("update_plan_candidate", { kind: "diet", scope: "2026-06-30", payload: { op: "add_meal", meal: { name: "Salad bowl" } } }), "diet · add_meal Salad bowl · 2026-06-30");
assert.equal(summarizeToolArgs("update_plan_candidate", { kind: "gym", scope: "permanent", payload: { meals: [] } }), "gym · full plan · permanent");

// entries carry actionType / argsSummary / actionTypes
assert.equal(by.A.actions.find((a) => a.tool === "create_expense_candidate").actionType, "expense");
assert.equal(by.A.actions.find((a) => a.tool === "create_expense_candidate").argsSummary, "₹70");
assert.deepEqual(by.A.actionTypes.sort(), ["expense", "food"]);
assert.deepEqual(by.E.actionTypes, ["review"]);

// ---- filterAuditEntries by action ----
assert.deepEqual(ids(filterAuditEntries(entries, { action: "expense" })), ["A", "B", "C"]);
assert.deepEqual(ids(filterAuditEntries(entries, { action: "food" })), ["A"]);
assert.deepEqual(ids(filterAuditEntries(entries, { action: "review" })), ["E"]);
assert.deepEqual(ids(filterAuditEntries(entries, { action: "all" })), entries.map((e) => e.id));
// action combines with the other filters
assert.deepEqual(ids(filterAuditEntries(entries, { action: "expense", outcome: "applied" })), ["A", "B"]);

// ---- entry HTML shows the input->output->action chain ----
const chainHtml = auditEntryHtml(by.A);
assert.ok(chainHtml.includes("input"), "input label present");
assert.ok(chainHtml.includes("₹70"), "AI output (args) rendered");
assert.ok(chainHtml.includes("→ ledger entries"), "action (applied target) rendered");
assert.ok(chainHtml.includes("→ food logs"), "fan-out food log target rendered");

console.log("audit-log tests passed");
