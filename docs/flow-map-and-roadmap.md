# Trackerz — Flow Map & Ambitious Roadmap

> Generated from a full read of the codebase (every page, service, agent module, domain detector,
> analytics module, the edge function, schema + migrations, and the docs). All P0/P1 findings below
> were re-verified against the source with file:line evidence — see "Verified against code".

## 1. Executive summary

Trackerz is a capture-first AI life tracker — a vanilla-ES-module static PWA on GitHub Pages backed by
Supabase (Postgres/Auth/Storage) and a single Gemini 2.5 Flash edge function that emits schema-validated
tool calls, with INR / Asia-Kolkata defaults. The **core capture pipeline is genuinely solid and wired
end-to-end**: text/image/audio/file → `raw_ingestions` → Gemini extraction → confidence-gated auto-apply
(≥0.88) / review (≥0.72) / reject → cross-source dedupe → review queue, with RLS, prompt-injection
wrapping, rate limits, and a $2/day cost cap all in place.

The tragedy of the codebase is that **a large, tested "brain" sits dead-ended**: `subscription-detector`,
`transfer-detector`, `refund-matcher`, `merchant-aliases`, `protein-gap`, `eating-window`, `mood-triggers`,
`recovery-score`, `weekly-review`, `budget-trajectory`, and `opportunity-cost` are all implemented and pass
tests but are **never called** and never rendered. Worse, three failure classes are structural and silent:
the edge function's `applyTool()` has **no handler** for `create_workout_log_candidate`,
`create_statement_row_candidate`, or `link_duplicate_candidates` (so high-confidence writes vanish), bank
`statement_rows` never become `ledger_entries`, and review approvals only mutate local state. The product
today is a trustworthy capture front-end on top of analytics and integrations that mostly haven't been
switched on — meaning the highest-leverage work is **wiring and hardening, not new code**, before the
conversational/agentic ambitions become safe to build.

## Verified against code (the load-bearing P0/P1 claims)

| Finding | Evidence | Status |
| --- | --- | --- |
| **Silent high-confidence data loss.** 3 of the write tools in `ALLOWED_TOOLS` have no `applyTool()` case. | `supabase/functions/agent/index.ts:35-46` lists `create_statement_row_candidate`, `create_workout_log_candidate`, `link_duplicate_candidates`; `applyTool()` only handles expense/income/transfer/food/body_metric/wellness (cases at 357-401), everything else `default: return null` (402-404). They still get inserted as `status="auto_applied"` with `applied_record_id=null` (454-460). | ✅ confirmed |
| **No `workout_logs` table.** | Not present in `supabase/schema.sql` nor any migration. Workout captures have nowhere to land even if a handler existed. | ✅ confirmed |
| **Schema is not the source of truth.** | `schema.sql` defines 14 tables; `subscriptions`, `merchant_aliases`, `category_memory`, `bank_format_memory`, `meal_templates`, `hydration_logs`, `weekly_reviews`, `invited_emails`, `audit_log`, `user_secrets` exist only in `migrations/20260522000003_money_diet_wellness_memory.sql`; `is_discretionary`/`nifty_monthly_closes` only in `migrations/20260518000002`. A fresh `schema.sql`-only push is broken. | ✅ confirmed |
| **The analytics "brain" is dead code.** | `subscription-detector.js`, `transfer-detector.js`, `refund-matcher.js`, `budget-trajectory.js`, `mood-triggers.js`, `recovery-score.js`, `weekly-review.js` exist under `src/domain/*` and `src/analytics/` but a content search finds **zero imports/references** anywhere in `src/`. | ✅ confirmed |
| **Review approvals don't persist.** | `src/ui/operational-tables.js:60-72` only mutates local state (`row.risk="approved"`, pushes to `parseLog`). `applyAiAction()` exists (`src/services/supabase-data.js:150`) but is never called. The Import button writes hardcoded mock values `"128"/"93%"/"18"` (`operational-tables.js:74-83`). | ✅ confirmed |

## 2. Existing user flows (complete inventory)

Status legend: `[implemented]` working UI→logic→DB · `[partial]` some pieces · `[stub]` placeholder ·
`[mock-data]` renders from mock not DB · `[planned]` in catalog/docs only · `[…-but-dead]` real code, never called.

### Capture
- **capture-text-chaos** — One messy box → classified + extracted into mixed candidates. `[implemented]`
- **capture-eod-voice** — Talk for 1–2 min; Web Speech transcript + audio → daily logs. `[implemented]`
- **capture-multi-image** — 10+ screenshots uploaded, clustered by Gemini vision. `[implemented]`
- **capture-mixed-dump** — Text + files + voice in one submit → unified review queue. `[implemented]`
- **capture-save-raw** — Network/agent failure queues capture for later review. `[implemented]`
- **Offline capture + IndexedDB drain-on-online** — Queue while offline, replay on reconnect. `[implemented]`
- **capture-paste-notes** — Pasted multi-line bullets split per line. `[partial]`
- **capture-share-target** — OS share-sheet into Trackerz. `[stub]`
- **capture-email-receipt** — Forwarded/pasted receipt emails. `[partial]`
- **capture-calendar-context** — Infer date from calendar events. `[planned]`
- **capture-bulk-review** — "Approve all high-confidence" button. `[stub]`
- **capture-correction-memory** — Edits teach future categorization. `[partial]`
- **ai-reprocess** — Re-run a stored ingestion against a better model + diff. `[planned]`
- **Capture cancellation / in-flight abort** — No `AbortController`; navigating away orphans half-uploaded media + non-terminal `raw_ingestions`. `[stub]`
- **Edge-function failure taxonomy** — 429/402/401/500/empty all collapse into one `request_user_review` at 0.4 confidence; none auto-retry. `[partial]`

### Money
- **money-upi-screenshot** — OCR amount/merchant/UTR/timestamp → expense. `[implemented]`
- **money-bank-excel / money-bank-csv** — SheetJS parse → column detect → preview → `statement_rows`. `[implemented]`
- **money-bank-pdf** — Selectable PDFs degrade; scanned fail. `[partial]`
- **money-card-statement** — No dedicated card-cycle tool. `[planned]`
- **money-sms-screenshot** — Generic vision OCR of bank SMS. `[partial]`
- **money-cash / money-cash-reconciliation** — No cash wallet table. `[partial]`
- **money-split** — No settlement tracker. `[planned]`
- **money-refund** — `refund-matcher.js` exists, unwired. `[partial-but-dead]`
- **money-transfer / money-investment-ignore** — `transfer-detector.js` exists, unwired. `[partial-but-dead]`
- **money-subscription** — `subscription-detector.js` fully built but never called. `[implemented-but-dead]`
- **money-budget-risk** — `budget-alerts.js` computes severity, never rendered. `[partial-but-dead]`
- **money-merchant-cleanup** — `normalizeMerchant()` pure util, no UI/memory write. `[partial]`
- **money-fees-interest / recurring-variable / overdraft-warning / location-context / tax-tags** — `tags` column exists; no edit UI/detection. `[stub]`
- **money-bill-photo** — Total parsed; no item-level rows. `[partial]`
- **money-income-salary** — `create_income_candidate` exists; no cashflow forecast. `[partial]`
- **money-natural-search** — NL query over ledger. `[stub]`
- **opportunity-cost (Nifty 50)** — `computeOpportunityCost()` built; depends on `is_discretionary` (migration-only). `[stub]`
- **Statement → ledger reconciliation** — `statement_rows.ledger_entry_id` always null; import dead-ends. `[partial — broken]`

### Diet & Nutrition
- **diet-food-photo** — Vision macro estimation; local fallback is mock. `[implemented]` / `[stub]`
- **diet-eod-voice** — Per-meal extraction from narrative. `[implemented]`
- **diet-protein-gap** — `suggestProteinFixes()` built; not surfaced in insights. `[implemented-but-dead]`
- **Macro pace tracking** — Today's protein/calories vs target. `[implemented]`
- **diet-template** — `meal_templates` table + functions built; no quick-add UI. `[partial]`
- **diet-restaurant / diet-label / diet-grocery-bill** — `restaurant-mode.js` parses bills but no macro estimate; no pantry. `[partial]` / `[stub]`
- **diet-eating-window / diet-late-snack** — Pure functions built; not in `composeInsights()`. `[implemented-but-dead]`
- **diet-weight-correlation** — `weight-rolling-avg.js` computed; no chart. `[partial-but-dead]`
- **diet-duplicate-meal** — Dedupe is money-only; food double-counts. `[partial]`
- **diet-water** — `metric_type='water_ml'` enum exists; no capture/aggregation. `[stub]`
- **diet-macro-correction / diet-party-day / diet-caffeine** — No edit UI, no range mode. `[stub]`
- **Set diet targets** — Saves to `budgets`; inputs never hydrate from DB. `[partial]`

### Wellness / Fitness
- **wellness-sleep / fitness-steps-screenshot / fitness-weight / wellness-mood-note** — `create_body_metric_candidate` / `create_wellness_note_candidate` wired end-to-end. `[implemented]`
- **wellness-habit-score** — `computeHabitScore()` runs in-memory; never persisted, no streaks. `[partial]`
- **fitness-workout-note / fitness-workout-screenshot** — `create_workout_log_candidate` is in `ALLOWED_TOOLS` but has no `applyTool()` case and no `workout_logs` table → silent loss. `[partial — broken]`
- **Sleep debt / recovery / mood triggers / weekly review / step summary** — All pure, tested, never rendered (no `pages/wellness.html`). `[implemented-but-dead]`
- **fitness-health-export** — No Apple Health / Google Fit importer; `body_metrics` CHECK blocks HR/HRV. `[stub]`
- **fitness-rest-day / wellness-journal** — No rest marking; no privacy flag in schema. `[stub]` / `[partial]`

### AI Agent
- **ai-tool-validated-write** — Schema validation + policy + apply + audit row. `[implemented]`
- **Auto-apply / review / reject thresholds** — 0.88 / 0.72 enforced. `[implemented]`
- **ai-prompt-injection** — Regex over `opts.text` only — does **not** cover OCR'd image text, the dominant mode. `[implemented — weak for images]`
- **ai-cost-cap / rate-limit** — $2/day, 60/5min; rate-limit **fails open** on query error. `[implemented]`
- **ai-model-fallback** — Catches errors → review; no secondary routing. `[partial]`
- **ai-evals** — `agent-policy.test.mjs` locks the matrix; no e2e/flow fixtures. `[implemented]`
- **ai-hallucination-guard** — No field-level evidence grounding. `[stub]`
- **Dead/uncallable tools** — `apply_verified_action`, `undo_ai_action`, `merge_duplicate_cluster`, `reprocess_ingestion`, `set_user_memory`, `estimate_food_macros` defined but not in `ALLOWED_TOOLS`/`applyTool()`. `[stub]`
- **`audit_log` table** — Fully provisioned + indexed, **zero writers/readers**. `[stub]`
- **Schema/code contract** — No test binds `ALLOWED_TOOLS` ↔ `applyTool()` cases → structural silent data loss. `[gap]`

### Dashboards / Insights
- **dashboard-ai-overview / dashboard-hard-data** — `composeInsights()` + tiles render (money/diet only). `[implemented]`
- **dashboard-cost-meter** — Spend by model, cap status. `[implemented]`
- **Trend charts (DOD/WOW/MOM/Trajectory)** — Render **mock-scaled** bars, not real series. `[mock-data]`
- **dashboard-trajectory** — Burn-rate math exists; no forecast card. `[partial]`
- **dashboard-duplicate-center** — `duplicate_candidates` flagged; no resolve UI. `[stub]`
- **dashboard-import-center** — Mock theater; no reprocess/undo. `[partial — mock]`
- **dashboard-monthly-review / weekly-brief** — `composeWeeklyReview()` built; no scheduler writes `weekly_reviews`. `[partial]` / `[planned]`
- **dashboard-goal-setting** — Budget inputs save; no presets/difficulty. `[partial]`
- **dashboard-what-if / dashboard-export** — No simulator; no export service. `[stub]`

### Platform / Auth
- **Magic-link / OAuth / local-dev sign-in / sign-out** — Real Supabase calls. `[implemented]`
- **One-time Supabase config wizard + 3-level config resolution** — `[implemented]`
- **Diagnostics (9 checks + e2e capture)** — Connectivity only, not extraction quality. `[implemented]`
- **State hydration + localStorage persistence** — Real fetch → format → render; errors swallowed into `[]`. `[implemented — silent-fail]`
- **community-multi-user (RLS)** — Enforced per `user_id`. `[implemented]`
- **community-admin-invite / coach-view / shared-challenge** — `invited_emails` exists; no UI. `[stub]` / `[planned]`
- **Schema-vs-migration drift** — see Verified table. `[gap]`
- **Storage lifecycle** — Uploaded media never deleted; no quota/GC/orphan cleanup. `[gap]`
- **Account deletion / data erasure** — "Clear cache" is localStorage only; no server-side wipe. `[gap]`
- **Session-expiry mid-capture, multi-tab sync, Nifty staleness** — Untraced. `[gap]`

## 3. Gap analysis — what's weak or missing today (prioritized)

1. **Silent high-confidence data loss (P0, correctness).** `applyTool()` lacks cases for workout/statement-row/link tools; they pass validation, get marked `auto_applied`, and write nothing. No test binds the allowlist to the apply switch.
2. **Schema is not the source of truth (P0, deploy-blocking).** `is_discretionary`, `tags`, and ~10 tables live only in migrations. Every feature below assumes the full schema is applied.
3. **The statement-import dead-end.** `statement_rows` never become `ledger_entries`; imports "succeed" but contribute nothing to spend/budgets/dashboards.
4. **Review approvals don't persist.** Approve/Drop mutate local state only; the correction signal every "agent learns" idea needs is never captured.
5. **A whole tested analytics brain is dead code.** Subscriptions, transfers, refunds, merchant memory, protein-gap, eating-window, late-snack, mood-triggers, recovery, sleep-debt, weekly-review, budget-alerts, opportunity-cost — all built, all unwired.
6. **Prompt-injection defense is blind to images.** `stripInjections()` runs only over `opts.text`; OCR text inside screenshots reaches Gemini unfiltered — the dominant mode, and it auto-writes money.
7. **No ledger idempotency.** Dedupe is fuzzy, post-write, money-only, 4-hour-bucket. No unique key (UPI/UTR), no exactly-once token; offline replay can double-write; food/wellness dedupe absent.
8. **Charts show mock data.** `buildTrendData()` invents scaling instead of consuming `period-aggregator`.
9. **No scheduler.** The nightly toggle is decorative; `weekly_reviews` is never written; no proactive surface.
10. **Silent failures + single-locale.** `hydrateStateFromSupabase` swallows errors into `[]`; INR/Asia-Kolkata + English hardcoded; no ARIA/keyboard.
11. **No read-side AI substrate.** The edge function never reads user data back to the model; `applyTool()` uses RLS-bypassing `adminClient()`; caps sized for one-shot captures. Every "ask/copilot/coach" idea needs context-assembly + RLS-safe reads + multi-turn cost control that don't exist.
12. **No observability/undo/export/erasure.** `audit_log` is dead; raw model output isn't retained for failed parses; no provenance from screenshot → number.

## Implementation status (updated)

**NOW tier — DONE (all 7 items, with tests; full suite green at 22 files):**
1. ✅ Tool-contract hole closed — missing `applyTool()` cases added, `workout_logs` table created, a write only ever records `auto_applied` when a row truly lands, non-write tools always surface for review, rate-limit + cost-cap now fail **closed**. New `tests/agent-contract.test.mjs` binds the allow-list to the apply switch and to the client applier.
2. ✅ Schema consolidated — `schema.sql` now mirrors every migration table + the `is_discretionary`/`tags` columns; `tests/schema-contract.test.mjs` enforces it.
3. ✅ Dead brain wired — new `src/analytics/insights-engine.js` fans out across subscriptions, protein-gap, late-snack, eating-window, weight-trend, sleep-debt, opportunity-cost, transfers/refunds; `hydrateStateFromSupabase` runs detectors, persists subscriptions, and feeds the insight list + dashboards with real arrays. `tests/insights-engine.test.mjs`.
4. ✅ Review approvals persist — approve now writes the proposed row server-side (`applyProposedAction`) via a pure `src/services/action-applier.js` mirror of the edge function; "Approve all" added; drop calls reject. (Correction-memory-on-edit split to follow-up task #8 — needs an inline-edit UI.)
5. ✅ Real-data charts + export + privacy — `buildTrendData` consumes `period-aggregator.dailySeries`; new `export-service.js` (CSV/JSON download) + `privacy-mode.js` blur toggle wired into Settings. `tests/charts-export.test.mjs`.
6. ✅ One-tap quick-log chips — `src/ui/quick-log.js` writes hydration/mood/meal-templates directly (no Gemini); hydration added to habit weights.
7. ✅ Field-level evidence guard — model now returns `evidence_text`; ungrounded high-confidence writes are demoted to review; injection scanning now covers OCR/vision text. Pure `src/agent/evidence-grounding.js` + `tests/evidence-grounding.test.mjs`.

**AI architecture — DONE:** the agent is now a two-model pipeline — **Gemini extracts** image/voice evidence (OCR/transcription/vision) and **DeepSeek is the reasoning brain** (tool calls), with Gemini as the reasoning fallback. Cost meter records per-provider spend. Keys read from `app_secrets`/secrets. (`supabase/functions/agent/index.ts`.)

**Additional NEXT items shipped this round (pure + tested):**
- ✅ Cashflow "safe to spend today" + month-end projection + what-if (`cashflow-forecast.js`, wired into the insight feed). `tests/cashflow-forecast.test.mjs`
- ✅ Deterministic Indian-bank/UPI SMS parser (`imports/sms-parser.js`, wired into the route preview as a fast lane). `tests/sms-parser.test.mjs`
- ✅ Account deletion / data erasure (`deleteAllUserData` + Settings button).

**Still not started (need live infra / larger builds):** share-target service worker, statement→ledger reconciliation pipeline, idempotent-capture tokens, nightly scheduler (pg_cron) + Web Push, dedicated wellness page, read-side "Ask your data" copilot, net-worth/tax layer, hash-chain ledger, social layer. Several require pg_cron / Web Push / OAuth scopes that can't be verified here.

## 4. Roadmap

### NOW — quick wins that switch on what's already built (next few weeks)

**Close the tool-contract hole (the P0 fix).** Add the missing `applyTool()` cases; create the
`workout_logs` table (+RLS); add a build-failing test asserting every `ALLOWED_TOOL` with a
`tableForTool()` mapping has an apply case. Make rate-limit **fail closed**.
*Effort:* S–M. *Touches:* `supabase/functions/agent/index.ts`, `src/agent/tool-registry.js`,
`tests/agent-policy.test.mjs`, new `workout_logs` migration.

**Consolidate `schema.sql` + migrations into one verifiable source of truth.** Fold migration
columns/tables into `schema.sql`; add a CI check that applies schema + migrations idempotently.
*Effort:* S. *Touches:* `supabase/schema.sql`, `supabase/migrations/*`, CI.

**Wire the dead money + diet + wellness brain into the insights feed.** In a post-capture pass
(alongside `runCrossSourceDedupe`) run `detectSubscriptions`/`detectTransfers`/`matchRefunds`/`resolveMerchant`
and persist; extend `composeInsights()` to emit `protein_gap`, `late_snack`, `eating_window`,
`weight_trend`, `budget_risk`, `subscription_due`, `opportunity_cost`. Surface a "Today's edge" card.
*Effort:* M. *Touches:* `agent-runner.js`, `insights-feed.js`, all `src/domain/*` detectors,
`subscriptions`/`merchant_aliases`/`category_memory` tables.

**Persist review approvals + bulk-approve + correction memory.** Wire `applyAiAction()`/reject
server-side; add "Approve all ≥0.88"; on row edits, write `merchant_aliases` + `category_memory` and
inject them into the prompt context for future captures.
*Effort:* M. *Touches:* `operational-tables.js`, `supabase-data.js`, `agent/index.ts`.

**Real-data charts + data export + privacy screen.** Rewrite `buildTrendData()` to consume
`period-aggregator`; add `export-service.js` (CSV/JSON via SheetJS); add a `privacy-mode.js` blur toggle.
*Effort:* S each. *Touches:* `charts.js`, `period-aggregator.js`, new `export-service.js`,
`data-controls.js`, new `privacy-mode.js`.

**One-tap quick-log chips (water, mood, meal templates).** Render time-of-day chips from
`meal_templates` + direct `hydration_logs`/`wellness_logs` writes that bypass Gemini; add hydration to
`habit-score`.
*Effort:* S. *Touches:* `capture-panel.js`, `meal-templates.js`, `supabase-data.js`, `habit-score.js`.

**Field-level evidence guard (promote to load-bearing).** Before auto-applying, verify each
load-bearing field (amount digits, merchant substring, date token) is grounded in the raw text **and**
the OCR text Gemini returned; ungrounded fields force `proposed`. Extend injection filtering to the
model's returned OCR text.
*Effort:* M. *Touches:* `agent/index.ts`, `action-policy.js`, `evidence.js`.

### NEXT — meatier bets (next quarter)

**Finish the PWA share-target inbox + ambient SMS parser.** Complete `manifest.webmanifest`
share_target + `sw.js` POST interception into the offline queue → `runCapture`; add a deterministic
`sms-parser.js` for Indian bank templates (zero AI cost). *Effort:* M + L. *Depends on:* persisted offline pipeline.

**Statement-to-ledger reconciliation + PDF/scanned vision pipeline.** Route PDFs/scanned statements
through vision emitting `create_statement_row_candidate`; match `statement_rows` to ledger via `scorePair`,
promote unmatched to `ledger_entries`, backfill `ledger_entry_id`; persist `bank_format_memory`.
*Effort:* L. *Touches:* `statement-import.js`, `score-pair.js`, `agent/index.ts`. *Depends on:* tool-contract fix.

**Idempotent capture + versioned rows + read-side offline cache.** Add `client_token` (unique index on
`raw_ingestions`) for exactly-once replay; add `updated_at`/`row_version`/`deleted_at` + bump trigger;
cache raw fetched rows in IndexedDB so reads work offline and errors stop blanking the UI.
*Effort:* M + L. *Touches:* `offline-queue.js`, `agent-runner.js`, `supabase-data.js`, `sync.js`, new `cache-store.js`.

**Nightly scheduler: digest, weekly review, habit streaks, proactive nudges.** A scheduled edge
function (pg_cron) that persists a daily `habit_days` row, writes `weekly_reviews` on Sundays, runs
detectors, composes a brief, and delivers via Web Push. Add a forgiveness-aware streak engine + snoozeable
nudges with quiet hours. *Effort:* L. *Touches:* new `supabase/functions/nightly`, `weekly-review.js`,
detectors, push, new `daily_scores`/`nudges` tables. *Depends on:* wired insights feed.

**Wellness page + workout analytics + health-export importer.** Ship `pages/wellness.html` rendering
sleep-debt, weight rolling avg, step summary, mood trend, recovery; build `workout-analytics.js`; add an
Apple Health / Google Fit / Strong importer; relax the `body_metrics` CHECK for HR/HRV. *Effort:* M + L.
*Depends on:* `workout_logs` from the tool-contract fix.

**Forecasting: safe-to-spend, cashflow runway, what-if simulator.** A cashflow engine combining
`budget-trajectory`, subscription `next_expected_at`, and detected salary cadence into a "Safe to spend
today" hero tile + 14-day runway; a pure `what-if.js` (Gemini only parses the NL scenario). *Effort:* L.
*Depends on:* reconciliation (complete ledger).

### LATER — ambitious

**Read-side AI substrate + "Ask your data" / Money Copilot.** A second, read-only edge surface with
RLS-scoped retrieval tools (`query_ledger`, `summarize_period`, `run_what_if`) that assemble compact
context, run a bounded tool-loop on `userClient()` (never `adminClient`), and answer with cited row-ids +
chart specs. *Effort:* XL. *Depends on:* idempotent/trustworthy ledger, persisted corrections.

**Net-worth & accounts layer; tax & deductible pack; multi-currency.** `accounts`/`account_balances`/
`holdings` tables (seed bank balances from the discarded `statement_rows.balance`), a net-worth trendline;
`tax_buckets` with year-end export; an `fx_rates` table + base-currency normalization + Travel mode. *Effort:* XL.

**Multi-step agentic plans + real undo + privacy-preserving accountability circles.** Agent "plan" mode
returning an approvable checklist; wire the dormant link/merge/reprocess/undo tools into a server-side
executor writing the (currently dead) `audit_log`; invite-gated circles exposing only opt-in aggregates via
`SECURITY DEFINER`. *Effort:* XL.

## 5. Moonshots ("plan crazy")

1. **Reverse the agent — a nightly autonomous "life close-out."** At local midnight the agent reads the
   whole day (via a real RLS-safe retrieval layer), runs every detector, and produces one morning
   artifact: yesterday closed, today's safe-to-spend, the protein move that pre-empts your gap, the
   subscription that hits Friday — each a one-tap pre-filled candidate, every autonomous read logged to
   `audit_log`. *Why it fits:* smallest change with the largest identity shift, and it forces the three
   substrate pieces (scheduler, read layer, audit trail) into one shippable ritual.

2. **Tamper-evident proof-of-life ledger.** Every auto-applied write hash-chains
   `sha256(prev_hash + canonical(row) + sha256(source_media))` into the already-shaped `audit_log`; any
   retroactive edit breaks the chain. The chain + media hashes export as a signed bundle a third party can
   verify without seeing amounts. *Why it fits:* when an AI writes your money from a photo, the killer
   feature is provable provenance — and it delivers real undo, export, and erasure on one primitive.

3. **A financial-and-health digital twin you can fast-forward and argue with.** Fuse the existing
   deterministic forecasters into a 6–12-month simulatable model, let users perturb it ("cut delivery to
   2×/week, raise the SIP"), have Gemini narrate the two dated futures, and **persist each prediction** to
   later score prediction-vs-reality. *Why it fits:* the math already exists and is tested; the leap is
   fusion + self-calibration.

4. **Privacy-preserving proof-of-habit social layer.** The nightly close-out emits signed daily
   attestations (booleans only, never rows); friends in invite-gated pods verify streaks and can stake real
   forfeits adjudicated purely from attestations; coaches get scoped, time-boxed, metric-limited read
   windows. *Why it fits:* the natural apex of single-user RLS + a hash chain + a scheduler — the first
   design where accountability and privacy aren't a trade-off.

5. **Ambient capture mesh — email + SMS + calendar + share-sheet.** Per-user forwarding address,
   deterministic Indian-bank SMS parsing, calendar-resolved dates for vague captures, and a finished share
   target — all flowing through the one hardened `raw_ingestions → agent` pipeline. *Why it fits:* reuses
   the entire existing spine and pushes capture toward fully passive.

6. **Self-tuning trust dial.** Mine the (now-persisted) approve/reject history per tool-and-merchant class
   to compute observed precision per confidence band, storing per-class threshold overrides the edge
   function reads — trusted UPI screenshots auto-apply sooner, shaky restaurant macros stay gated longer,
   shown as evidence ("47 approved, 0 rejected → auto-applying at 0.80"). *Why it fits:* turns a global
   constant into personalized, evidence-backed trust — after the correction-capture loop from NOW is closed.

7. **Autonomous savings & subscription-cleanup agent (human-in-the-loop).** Read-only-then-propose tools
   (`propose_subscription_cancel`, `propose_auto_save_sweep`, `propose_budget_reallocation`) that never
   auto-apply — they land as high-value, one-tap, undoable, audit-logged proposals, with a running "agent
   saved you ₹N" counter. *Why it fits:* makes the tracker work *for* you within the existing safety boundary.

---

### Other missed flows worth noting (from the completeness pass)
- **Magic-link redirect / token-refresh / session-expiry mid-capture / multi-tab sign-out** — sign-in is
  `[implemented]` but the in-flight-JWT-expiry path silently dead-ends a capture in `raw_ingestions`.
- **First-run / empty-state / seed-data** — who seeds `nifty_monthly_closes`? What does a brand-new user
  with zero rows see? The activation funnel is undescribed.
- **Storage GC / account deletion / Nifty staleness** — see Gaps #10/#12; load-bearing for a privacy-first
  finance+health tracker.
