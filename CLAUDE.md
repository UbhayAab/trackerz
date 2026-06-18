# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

Trackerz is a capture-first life tracker (money/diet/wellness) served as static files from GitHub Pages, with Supabase for auth/DB/storage and a single Supabase Edge Function (`agent`) that turns messy captures (text, voice, screenshots, bank statements) into structured tool calls. The agent is a **two-model pipeline**: **Gemini 2.5 Flash** extracts evidence from images/audio (OCR, transcription, food-photo vision) and **DeepSeek** (`deepseek-chat`) is the reasoning "brain" that emits the tool calls; if DeepSeek is unavailable it falls back to Gemini for reasoning. Both keys (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) live only as edge-function secrets / `app_secrets`. The live URL is https://ubhayaab.github.io/trackerz/. Project ref: `qmlenovxatoyxxqlvzlo`.

There is no bundler or transpiler. Everything is native ES modules loaded directly by the browser. A `package.json` exists for dev tooling only (test runner scripts, Playwright, `pg`, `dotenv`).

## Commands

Run from the repo root (`trackerz/`):

```powershell
# Local static server (http://127.0.0.1:4173)
npm run serve

# Run all tests (the suite — each file is a standalone `node:assert` script, no test runner)
npm test

# Run a single test file
node tests/agent-core.test.mjs

# Apply schema / migrations via Node (reads DB URL from .env)
npm run db:push

# Deploy the edge function (requires supabase CLI logged in)
supabase functions deploy agent

# Push edge-function secrets (reads from env)
$env:GEMINI_API_KEY = "..."; ./scripts/set-supabase-secrets.ps1
```

GitHub Pages deploy is automatic on push to `main` via `.github/workflows/pages.yml` — it uploads the whole repo as the Pages artifact, so anything outside `.gitignore` ships to production.

### Test files outside `npm test`

These exist but are not in the `npm test` suite and must be run individually:

- `tests/diet-domain.test.mjs`, `tests/money-intelligence.test.mjs`, `tests/wellness-domain.test.mjs` — domain logic
- `tests/dedupe-matrix.test.mjs`, `tests/period-aggregator.test.mjs` — analytics
- `tests/fuzz-corpus.test.mjs`, `tests/safety.test.mjs` — fuzzing and safety invariants
- `tests/e2e-live-db.test.mjs`, `tests/e2e-gemini-vision.test.mjs` — require live Supabase/Gemini credentials

## Architecture

### Two-environment split

- **Browser (static)**: every `.js` in `src/` and every `.mjs` in `lib/` runs in the browser. Pages under `pages/*.html` and `index.html` each load exactly one entry module from `src/pages/`. There is no build step — module specifiers are real relative paths.
- **Edge Function**: `supabase/functions/agent/index.ts` runs in Deno on Supabase. This is the only place that holds `GEMINI_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY`. The browser never sees those.

`lib/agent-core.mjs` and `lib/flow-catalog.mjs` are pure modules imported by both browser code and tests — keep them dependency-free (no DOM, no Supabase).

### The capture pipeline (the spine of the app)

A single ingestion path runs for everything the user drops in:

1. `src/pages/capture.js` collects text/files/voice, calls `previewCaptureRoute` from `src/services/capture-router.js` to classify the input.
2. `src/services/agent-runner.js` (`runCapture`) inserts a `raw_ingestions` row, uploads media to the `raw-media` Supabase Storage bucket, then invokes the `agent` edge function.
3. The edge function calls Gemini 2.5 Flash with `SYSTEM_PROMPT` constraining output to a JSON tool-call schema, persists rows in `ai_runs` + `ai_actions`, and auto-applies high-confidence writes server-side.
4. After the function returns, the client runs `runCrossSourceDedupe` (`src/services/dedupe-scan.js`) to link e.g. a voice-logged "Rs 250 lunch" to a "Rs 252" bank row using time-bucket + amount-tolerance matching (`src/duplicates/score-pair.js`).
5. The capture page polls/refreshes the review queue and dashboard tiles via `src/services/supabase-data.js`.

If the edge function is unavailable, captures still land in `raw_ingestions` with `status='queued'` — nothing is lost, and the UI shows "Agent unavailable; capture queued for review".

### AI safety boundary

The Gemini model never writes to the DB directly. It returns tool calls that pass through layered guards:

- `src/agent/tool-registry.js` is the allowlist of known tool names (also mirrored in `ALLOWED_TOOLS` inside the edge function — keep them in sync).
- `src/agent/action-policy.js` decides `block` / `review` / `auto_apply` from `(tool kind, confidence, evidence, risk)`. Thresholds: `autoApply ≥ 0.88`, `review ≥ 0.72`, anything lower or destructive → blocked.
- Postgres RLS (see `supabase/schema.sql` + `supabase/migrations/20260518000001_rls_and_buckets.sql`) is the last line of defense — every user-owned table must have RLS enabled.

If you add a new tool: register it in `src/agent/tool-registry.js` **and** add it to `ALLOWED_TOOLS` in `supabase/functions/agent/index.ts`, and extend `SYSTEM_PROMPT` with its `arguments` shape. Tests in `tests/agent-policy.test.mjs` enforce policy invariants.

### Frontend layering (enforced by `tests/architecture.test.mjs`)

The test asserts these directories exist with modules in them — do not collapse them:

- `src/ui/` — DOM rendering and event binding only. No data fetching or AI logic.
- `src/services/` — UI-facing app services (capture routing, cost meter, Supabase client, dedupe scan, statement import, speech).
- `src/agent/` — tool registry, action policy, model routing, evidence rules, prompt boundaries.
- `src/imports/` — bank statement format detection, column candidates, row normalizer, statement preview.
- `src/analytics/` — budget trajectory, macro pace, habit score, insight rules, opportunity cost.
- `src/duplicates/` — pair scoring + expense/food cluster helpers.
- `src/domain/{money,diet,wellness}/` — domain defaults.
- `src/data/` — static mock data (dashboard, table, Nifty monthly closes).
- `src/pages/` — page entry modules (one per HTML file).
- `src/state/` — `app-state.js` + `sync.js`.
- `src/utils/` — `dom.js`, `formatters.js`.
- `lib/` — pure shared primitives, must stay browser/Node-isomorphic.
- `styles/` — layered CSS (tokens → base → layout → components → page-specific → tables → nav → responsive), imported by the single `styles.css` entry. Do not write to `styles.css` directly except to add imports.

`tests/architecture.test.mjs` also requires ≥ 45 modules in `src/` and ≥ 8 CSS layers — if you delete or merge files, update the test.

### Config and secrets

- `src/config.js` resolves Supabase URL+anon key in this order: (1) `src/config.local.js` (gitignored), (2) `localStorage` keys `trackerz.supabase_url` / `trackerz.supabase_anon_key`, (3) the on-screen setup card. The same static bundle deploys anywhere.
- The Supabase **anon** key is safe in the browser only because RLS is on every user table.
- `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and any old `NVIDIA_API_KEY` live only as Supabase Edge Function secrets — never commit them, never put them in client code.

### Tests

Each `tests/*.test.mjs` is a standalone Node script using `node:assert`. There is no runner, no watch mode, no parallel orchestration — `node tests/<file>.test.mjs` is the unit. `tests/architecture.test.mjs` enforces directory layout, `tests/flow-catalog.test.mjs` enforces that every flow in `lib/flow-catalog.mjs` has trigger/inputs/AI-steps/outputs/safeguards/examples, and `tests/agent-policy.test.mjs` locks the auto-apply/review/block decision matrix.

## Conventions

- No build step, no transpilation, no framework. Vanilla ES modules + native browser APIs. Don't introduce React/Vite/TypeScript on the frontend.
- Currency is INR; default timezone is `Asia/Kolkata` (see `profiles` defaults in schema).
- When adding a new HTML page, add its module under `src/pages/`, wire it from the page's `<script type="module">`, and link it from the bottom nav consistently.
- The repo deploys via "upload the whole tree to Pages" — do not add build artifacts that should not ship.
