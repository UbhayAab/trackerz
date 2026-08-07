# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

Trackerz is a capture-first life tracker (money/diet/wellness) served as static files from GitHub Pages, with Supabase for auth/DB/storage and two Supabase Edge Functions: `agent` turns messy captures (text, voice, screenshots, bank statements) into structured tool calls, and `jarvis` is the proactive engine - pg_cron fires `jarvis_ping()` (pg_net → the function) at four IST slots (close-out 00:05 → `habit_days` + streaks + Sunday `weekly_reviews`; morning 07:00 → LLM-voiced brief into `briefings`, delivered by Resend email + Web Push; midday 14:30 → protein/gym pace push, silent when the day is on track; evening 20:30 → nudge push). The brief's brain is `lib/jarvis-brief.mjs`, mirrored byte-identically inside the jarvis function (tests/mirror-parity.test.mjs enforces it); the voice model may only phrase the facts JSON, never invent numbers, with a deterministic fallback. Delivery prefs live on `profiles` (briefing_enabled/email_brief/push_enabled/quiet_hours, editable in Settings → Jarvis), push endpoints in `push_subscriptions` (VAPID keys via `scripts/generate-vapid-keys.mjs`; private half in `app_secrets` as JARVIS_VAPID_JWK, public half hardcoded in `src/services/push.js`). `.github/workflows/jarvis-heartbeat.yml` re-fires the same idempotent actions as a fallback scheduler (needs the JARVIS_CRON_SECRET repo secret). The agent is a **two-model pipeline**: **Gemini 2.5 Flash** extracts evidence from images/audio (OCR, transcription, food-photo vision) and **DeepSeek** is the reasoning "brain" that emits the tool calls. DeepSeek runs thinking-mode first - `deepseek-reasoner` (R1) is the primary brain, with `deepseek-chat` (strict-JSON `response_format`) as the fallback when the reasoner errors or returns no parseable JSON; if DeepSeek is unavailable entirely it falls back to Gemini for reasoning. (`deepseek-reasoner` rejects `response_format`/`temperature` - only set those for `deepseek-chat`. `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL` secrets can override the endpoint/model, e.g. to point at an NVIDIA-hosted model.) Both keys (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) live only as edge-function secrets / `app_secrets`. The live URL is https://ubhayaab.github.io/trackerz/. Project ref: `yyoewdcijplkhxleejtm` (an earlier build pointed at `qmlenovxatoyxxqlvzlo`, which no longer resolves - that mismatch broke the live app; the frontend now points at yyoe and the schema/keys live there).

There is no bundler or transpiler. Everything is native ES modules loaded directly by the browser. A `package.json` exists for dev tooling only (test runner scripts, Playwright, `pg`, `dotenv`).

## Commands

Run from the repo root (`trackerz/`):

```powershell
# Local static server (http://127.0.0.1:4173)
npm run serve

# Run all tests (the suite is ~28 files chained with &&; each is a standalone `node:assert` script, no test runner)
npm test

# Run a single test file
node tests/agent-core.test.mjs

# Apply schema / migrations via Node (reads DB URL from .env)
npm run db:push

# One-shot backend provisioning (schema + buckets + secrets via Node)
npm run setup:backend

# Screenshot pages with Playwright (writes to docs/ - used for visual checks)
npm run screenshot

# Ad-hoc read-only SQL against the live DB (reads .env.local)
node scripts/q.mjs "select count(*) from food_logs"

# Import bank statements straight into the live DB (same pipeline as the app).
# Idempotent; refuses to write a statement whose balance chain does not reconcile.
node scripts/import-statements.mjs --dry-run "C:/path/one.csv" "C:/path/two.xls"
node scripts/import-statements.mjs "C:/path/one.csv" "C:/path/two.xls"

# Drive the signed-in money page and print the numbers it actually renders
node scripts/smoke-money.mjs

# Drive the real signed-in app in a phone viewport; prints console errors,
# failed requests, and any fabricated "undefined"/NaN on screen
node scripts/smoke-ui.mjs

# Fire the jarvis engine on demand instead of waiting for a cron slot
node scripts/jarvis-run.mjs status|morning|midday|evening|closeout [--force]

# Prove the negation guard against the DEPLOYED agent function (self-cleaning)
node scripts/verify-negation-live.mjs

# Prove the deployed agent ANSWERS a question instead of silently filing it
node scripts/verify-answer-live.mjs

# Run a REAL capture through the deployed pipeline and print every row it wrote
node scripts/capture.mjs "6 boiled eggs and 500ml curd"
node scripts/capture.mjs --dry "no gym today"        # local salvage only, no writes
node scripts/capture.mjs --undo <ingestionId>        # remove everything it wrote

# Copy the JARVIS-BRIEF mirror block lib/ -> edge fn (tests/mirror-parity guards it)
node scripts/sync-mirror.mjs

# Deploy an edge function (requires supabase CLI logged in; or use the script - takes a slug, default agent)
supabase functions deploy agent
node scripts/deploy-edge-function.mjs jarvis

# Push edge-function secrets (reads from env)
$env:GEMINI_API_KEY = "..."; ./scripts/set-supabase-secrets.ps1
```

### Delivery: there are TWO channels and they are not the same speed

This is the single most expensive thing to get wrong here, because getting it
wrong makes a shipped fix look like a broken fix.

**Web (fast).** Pages `build_type` is **legacy**: the repo's own `main` branch is
published directly on every push, so anything outside `.gitignore` is live within
a minute. Confirm with `gh api repos/UbhayAab/trackerz/pages`. `sw.js` is
network-first with `cache: "no-store"` for app code plus `skipWaiting` +
`clients.claim`, so the browser cannot get stuck on an old bundle.

`.github/workflows/pages.yml` is therefore **disabled except for
workflow_dispatch**. In legacy mode `actions/deploy-pages` has no deployment
target to claim, so a run started by a push never finishes: it sits in `waiting`
holding the `pages` concurrency group and every later push queues behind it
forever. Measured 2026-08-08: one run waiting 25 hours, two cancelled behind it,
the newest pending 9 hours. The site was fine the whole time. If you ever switch
Pages to `build_type: workflow` in repo settings, restore the `push` trigger in
the same change.

**Android (slow, and it is the one the owner actually uses).** The APK bundles
the whole web app: CI stages the repo into `www/` and Capacitor freezes it into
`assets/public`. **A fix on `main` is not a fix on the phone until a new APK is
installed.** Measured 2026-08-08: builds 1.0.35 through 1.0.45 had ZERO downloads
on their immutable per-build release assets while the owner reported bugs that
those builds had already fixed. Eleven builds of work, invisible.

Two guards now exist, and both must keep working:
- CI writes `www/build-info.json` (versionCode = run number, commit, timestamp)
  so the running bundle can identify itself. It is gitignored and must NEVER be
  committed: its ABSENCE is how the browser knows it is not running from a
  bundle.
- `lib/update-check.mjs` + `src/services/build-info.js` compare the installed
  build against the newest release asset and `src/ui/navigation.js` shows a
  banner when the phone is behind. It runs on module load, NOT from inside
  `bootWithAuth` - an app too old to sign in is exactly the app that most needs
  the banner, and the auth-gated version never appeared at all.

`APP_VERSION` in `src/version.js` is a hand-typed string that read "v17" while CI
was publishing build 45. Inside the APK the badge now shows the real build number
instead, because a stamp that cannot change cannot tell you whether an update
landed. Do not reintroduce a hand-maintained version as the only signal.

**When you report a fix, say which channel it lands on.** Edge functions and
database changes are live the moment they deploy. Anything in `src/`, `lib/`,
`styles/` or the HTML is live on web immediately and reaches the phone only after
an APK reinstall.

### Test files outside `npm test`

Only these. Everything else in `tests/` is in the chain, and the list below drifted
badly once (it still named seven files that had been folded into CI, including both
prompt-injection suites, which is how a "we do not run that one" belief outlives the
fact) - so check `package.json` before trusting it:

- `tests/e2e-live-db.test.mjs`, `tests/e2e-gemini-vision.test.mjs` - require live
  Supabase/Gemini credentials and cost money, so they stay opt-in.

To find the truth at any time:

```powershell
node -e "const p=require('./package.json');const fs=require('fs');const inSuite=new Set([...p.scripts.test.matchAll(/tests\/([a-z0-9-]+)\.test\.mjs/g)].map(m=>m[1]));console.log(fs.readdirSync('tests').filter(f=>f.endsWith('.test.mjs')).map(f=>f.replace('.test.mjs','')).filter(f=>!inSuite.has(f)).join('
')||'(all registered)')"
```

## Architecture

### Two-environment split

- **Browser (static)**: every `.js` in `src/` (~105 modules) and every `.mjs` in `lib/` runs in the browser. The HTML pages are `index.html` plus `pages/{analytics,diagnostics,diet,gym,money,settings}.html` and `pages/share-target.html` (Web Share Target endpoint); each loads exactly one entry module from `src/pages/`. There is no build step - module specifiers are real relative paths.
- **Edge Function**: `supabase/functions/agent/index.ts` runs in Deno on Supabase. This is the only place that holds `GEMINI_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY`. The browser never sees those.

Everything in `lib/` is a pure module imported by both browser code and tests - keep them dependency-free (no DOM, no Supabase). Several of them have an **inline mirror inside the edge function** (`supabase/functions/agent/index.ts`) because Deno can't import browser-relative paths; when you change one of these, update the edge mirror too:
- `agent-core.mjs`, `flow-catalog.mjs` - agent primitives + the flow catalog.
- `context-builder.mjs` - assembles the "memory context" block injected into every AI reasoning call (fixed-priority sections under a char cap; LAST7 is O(1)).
- `fan-out-expander.mjs` - deterministic fan-out + salvage + backdate: guarantees one real event lands in every tracker it belongs to even when the model under-emits or bails to review.
- `food-nutrition.mjs` - lookup table of everyday foods; when `estimateNutrition(text).recognized` is true its totals are AUTHORITATIVE and override the model (DeepSeek reasoning is only used for non-everyday items). **This table is the app's ONLY food vocabulary.** `fan-out-expander.mjs` derives its `FOOD_WORDS` salvage cues from these aliases rather than keeping a second hand-written list - that duplication was a real bug, leaving 119 of 254 priceable foods invisible to salvage. Add a food here and both layers learn it; then run `node scripts/sync-mirror.mjs` to regenerate the edge's `FOOD_WORDS` literal. `tests/food-mirror.test.mjs` proves the edge's copy of the whole nutrition engine returns identical numbers to lib's across a corpus (it strips the TS types and runs both), and `tests/fan-out-expander.test.mjs` asserts every priceable alias is also a salvage cue.
- `negation.mjs` - clause-scoped denial detection. Salvage fires on a domain *mention*, and a mention is not an occurrence: "no gym today" must never become a workout row. Scoped per clause so "no gym but ate 6 eggs" denies the gym and still logs the eggs. A denied workout is written as `workout_logs.status='skipped'` (answered the day, did not train) rather than dropped. See `docs/AUDIT-2026-07-22.md`.
- `additions.mjs` - shapes recent domain rows into the Home feed's day-over-day "additions" list.
- `aspiration-cascade.mjs` - maps a free-text goal note to budget/target changes plus the undo math.

### The bank statement pipeline

Statement import is its own four-stage pipeline in `lib/`, pure and
browser/Node-isomorphic, driven by `lib/statement-ingest.mjs`. The browser
importer (`src/services/statement-import.js`), the bulk loader
(`scripts/import-statements.mjs`) and `tests/statement-pipeline.test.mjs` all
call the SAME `ingestStatements()` - so the preview a user approves and the rows
that get written cannot disagree.

1. `statement-shape.mjs` - a bank statement is a letter with a table buried in
   it (13 preamble rows on Kotak, 20 on HDFC, a summary block and marketing
   footer after). Scores rows to find the header, binds columns POSITIONALLY
   (Kotak's header contains `Dr / Cr` twice - once for the amount, once for the
   balance - and any name-keyed mapping loses the sign of every transaction),
   and reads the account identity out of the letterhead. The dd/mm vs mm/dd
   convention is decided once per file from evidence in the file.
2. `statement-audit.mjs` - proves the parse. If `balance[n] = balance[n-1] +
   credit - debit` holds for every row, the bank has confirmed every date,
   amount and sign. Verdict is `proven` / `consistent` / `suspect`;
   `scripts/import-statements.mjs` REFUSES to write a suspect statement.
3. `txn-semantics.mjs` - narration grammar (HDFC `UPI-PAYEE-VPA-IFSC-RRN-NOTE`,
   Kotak `UPI/PAYEE/REF/NOTE`, NEFT/IMPS/NACH/TPT/BILLPAY/EMI forms) plus a
   FLOW TYPE per row. Flow type is the load-bearing idea: `direction` cannot
   tell a credit-card bill from a grocery run, and over the owner's two real
   statements 77% of outflow was transfers, investments, card bills and loan
   principal rather than spending. `rowCountsAsSpending(row)` is the predicate
   every money total should use.
4. `statement-link.mjs` - facts needing two rows: own-account transfer pairs,
   refunds matched to the debits they reverse (including a refund that is an
   exact multiple of N same-day charges), repeated charges, recurring series and
   the instances that went MISSING, and bank rows that duplicate a hand-logged
   entry.

Tables: `bank_accounts` (learned from the statements themselves, which is how a
payment to KKBK0008109 becomes a recognised self-transfer), `ledger_links`,
`recurring_series`, plus `flow_type` / `counts_as_spending` / `counterparty` on
`ledger_entries`. Idempotency is by content key with no import id in it. See
`docs/STATEMENT-IMPORT-2026-07-28.md`.

### The capture pipeline (the spine of the app)

A single ingestion path runs for everything the user drops in:

1. `src/pages/capture.js` collects text/files/voice, calls `previewCaptureRoute` from `src/services/capture-router.js` to classify the input.
2. `src/services/agent-runner.js` (`runCapture`) inserts a `raw_ingestions` row, uploads media to the `raw-media` Supabase Storage bucket, then invokes the `agent` edge function.
3. The edge function runs the pipeline - Gemini 2.5 Flash extracts evidence from any media, then the DeepSeek brain emits the JSON tool calls under `SYSTEM_PROMPT` (which constrains output to the allowed-tool schema) - persists rows in `ai_runs` + `ai_actions`, and auto-applies high-confidence writes server-side.
4. After the function returns, the client runs `runCrossSourceDedupe` (`src/services/dedupe-scan.js`) to link e.g. a voice-logged "Rs 250 lunch" to a "Rs 252" bank row using time-bucket + amount-tolerance matching (`src/duplicates/score-pair.js`).
5. The capture page polls/refreshes the review queue and dashboard tiles via `src/services/supabase-data.js`.

If the edge function is unavailable, captures still land in `raw_ingestions` with `status='queued'` - nothing is lost, and the UI shows "Agent unavailable; capture queued for review".

### AI safety boundary

The model never writes to the DB directly. It returns tool calls that pass through layered guards:

- `src/agent/tool-registry.js` is the allowlist of known tool names (also mirrored in `ALLOWED_TOOLS` inside the edge function - keep them in sync).
- `src/agent/action-policy.js` decides `block` / `auto_apply` from `(tool kind, confidence, evidence, risk)`. **There is no approve gate**: an unknown tool or a destructive one is blocked, and everything else auto-applies immediately. `confidencePolicy` (`autoApply 0.88`, `review 0.72`) no longer gates anything - it only tags `reasons` (`low_confidence` / `missing_evidence` / `high_risk`) so the feed can flag a weak row for one-tap deletion. Consequence worth knowing: a confidently WRONG tool choice commits silently and never surfaces as "needs a look" - which is how a food capture filed as `create_note_candidate` at 0.80 lost a whole meal (see `docs/AUDIT-2026-07-28-note-misfile.md`).
- Postgres RLS (see `supabase/schema.sql` + `supabase/migrations/20260518000001_rls_and_buckets.sql`) is the last line of defense - every user-owned table must have RLS enabled.

If you add a new tool: register it in `src/agent/tool-registry.js` **and** add it to `ALLOWED_TOOLS` in `supabase/functions/agent/index.ts`, and extend `SYSTEM_PROMPT` with its `arguments` shape. Tests in `tests/agent-policy.test.mjs` enforce policy invariants.

### Frontend layering (enforced by `tests/architecture.test.mjs`)

The test asserts these directories exist with modules in them - do not collapse them:

- `src/ui/` - DOM rendering and event binding only. No data fetching or AI logic.
- `src/services/` - UI-facing app services (capture routing, cost meter, Supabase client, dedupe scan, statement import, speech).
- `src/agent/` - tool registry, action policy, model routing, evidence rules, prompt boundaries.
- `src/ai/` - client-side AI glue (capture parsing, job runner).
- `src/imports/` - bank statement format detection, column candidates, row normalizer, statement preview, and `sheet-reader.js` (the ONLY module that touches SheetJS - it reads every cell raw, because `cellDates: true` makes SheetJS read Kotak's `01-04-2026` as 4 January).
- `src/analytics/` - budget trajectory, macro pace, habit score, insight rules, opportunity cost.
- `src/duplicates/` - pair scoring + expense/food cluster helpers.
- `src/domain/{money,diet,wellness}/` - domain defaults.
- `src/data/` - static mock data (dashboard, table, Nifty monthly closes).
- `src/pages/` - page entry modules (one per HTML file).
- `src/state/` - `app-state.js` + `sync.js`.
- `src/utils/` - `dom.js`, `formatters.js`.
- `lib/` - pure shared primitives, must stay browser/Node-isomorphic.
- `styles/` - layered CSS (tokens → base → layout → components → page-specific → tables → nav → responsive), imported by the single `styles.css` entry. Do not write to `styles.css` directly except to add imports.

`tests/architecture.test.mjs` also requires ≥ 45 modules in `src/` and ≥ 8 CSS layers - if you delete or merge files, update the test.

### Config and secrets

- `src/config.js` resolves Supabase URL+anon key in this order: (1) `src/config.local.js` (gitignored), (2) `localStorage` keys `trackerz.supabase_url` / `trackerz.supabase_anon_key`, (3) hard-coded production defaults (the live `yyoe` URL + publishable anon key are baked in, so the app works out of the box; the on-screen setup card is only a fallback for forks). `config.js` also self-heals: a browser holding the dead `qmle` ref in `localStorage` gets it wiped so the prod default takes over.
- The Supabase **anon** key is safe in the browser only because RLS is on every user table.
- `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and any old `NVIDIA_API_KEY` live only as Supabase Edge Function secrets - never commit them, never put them in client code.

### Tests

Each `tests/*.test.mjs` is a standalone Node script using `node:assert`. There is no runner, no watch mode, no parallel orchestration - `node tests/<file>.test.mjs` is the unit. `tests/architecture.test.mjs` enforces directory layout, `tests/flow-catalog.test.mjs` enforces that every flow in `lib/flow-catalog.mjs` has trigger/inputs/AI-steps/outputs/safeguards/examples, and `tests/agent-policy.test.mjs` locks the auto-apply/review/block decision matrix.

## Conventions

- No build step, no transpilation, no framework. Vanilla ES modules + native browser APIs. Don't introduce React/Vite/TypeScript on the frontend.
- Currency is INR; default timezone is `Asia/Kolkata` (see `profiles` defaults in schema).
- When adding a new HTML page, add its module under `src/pages/`, wire it from the page's `<script type="module">`, and link it from the bottom nav consistently.
- The repo deploys via "upload the whole tree to Pages" - do not add build artifacts that should not ship.
