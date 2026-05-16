# Trackerz Product Audit and User Flows

Last updated: 2026-05-16

## Current Reality

Trackerz is still a static GitHub Pages prototype with browser-local persistence. The active write store is `localStorage`, not Supabase tables. Supabase scaffolding exists for database schema, secrets, and an Edge Function agent, but production writes, auth, storage uploads, and scheduled midnight jobs still need Supabase deployment.

API keys must not be placed in browser code or Git. Gemini and DeepSeek keys belong in Supabase Edge Function secrets. The repo includes `scripts/set-supabase-secrets.ps1`, but it requires `SUPABASE_ACCESS_TOKEN`; this machine did not have that token available during this audit.

## Page Audit

Capture:
- Purpose: fastest possible input surface.
- Inputs now represented: text, multiple files, images, audio files, and browser voice recording when permission is available.
- Output surfaces: visible AI stage console, review queue, metrics, insights.
- Fixed in this audit: file accept list includes `audio/*`; voice creates an audio evidence item instead of a fake transcript; summaries start empty; complex mixed input creates multiple rows.

Dashboard:
- Purpose: DOD, WOW, MOM, trajectory views.
- Fixed in this audit: summary tiles and chart bars are state-derived. No fixed spend/protein/review values remain in page markup.
- Remaining backend need: real historical aggregates once Supabase records exist.

Money:
- Purpose: ledger, import queue, budgets, category trajectory.
- Fixed in this audit: top summary reads logged spend, ledger rows, import rows, and money review count from state.
- Current local parser handles multiple text expenses, bank imports, statements, screenshots, refunds, fuel, delivery, shopping, transport, and groceries at scaffold level.

Diet:
- Purpose: calories, protein, meal rows, food evidence.
- Fixed in this audit: top summary and metric cards read from state. Complex daily/weekly dumps split breakfast/lunch/dinner where terms exist.
- Remaining backend need: Gemini image/audio extraction for actual meal photos and voice transcription.

Insights:
- Purpose: AI overview, nightly schedule, flow coverage.
- Fixed in this audit: pending reviews and insight count are state-derived; flow coverage is computed from the catalog.
- Remaining backend need: true 12 AM Supabase scheduled function.

Settings:
- Purpose: budgets, AI cap, nightly schedule, data controls.
- Current controls: Clear all data, Load demo data, local budget field updates, AI cost meter.
- Remaining backend need: persist settings per Supabase auth user.

## Input Methods

Text:
- Best for live logging and quick corrections.
- Examples: `paid 240 zomato`, `breakfast poha lunch dal rice`, `slept 5 hours walked 8500 steps`.
- Local behavior: parses into review rows, ledger rows, macro rows, wellness rows, insights, and metrics.

Image:
- Best for payment screenshots, food photos, labels, receipts, health screenshots.
- Local behavior: creates image evidence review rows and duplicate warnings.
- Supabase behavior planned: Gemini extracts text/vision facts, DeepSeek turns facts into validated tool calls.

Audio/Voice:
- Best for end-of-day diet summaries, weekly dumps, missed photos, and hands-free logging.
- Local behavior: browser recording attaches an audio evidence item; uploaded audio files route to media review.
- Supabase behavior planned: Gemini transcribes and extracts facts, DeepSeek validates tool calls, low confidence stays in review.

CSV/XLS/XLSX/PDF/TXT:
- Best for weekly/monthly bank exports and statement imports.
- Local behavior: creates import preview rows and review rows.
- Supabase behavior planned: deterministic parsing first, OCR fallback for scanned PDFs, AI column mapping, row hashing, duplicate detection, and undoable import jobs.

Mixed Dump:
- Best for real life: text plus many screenshots plus audio plus statements.
- Local behavior: creates all relevant candidate rows, import rows, media review rows, and duplicate review rows.
- Safety: nothing is auto-deleted. Duplicates are flagged for user review.

## Logging Cadences

Live / per transaction:
- User opens Capture and logs one event.
- Expected path: instant text parse, visible AI stages, row appears in action queue and relevant domain table.
- Example: `paid 320 uber airport`.

Daily / end of day:
- User dumps the whole day in text or voice.
- Expected path: parse multiple meals, spends, sleep/steps, and insight summary.
- Example: `EOD: breakfast poha, lunch dal rice curd, dinner chicken rice, paid 500 fuel, walked 8500 steps`.

Weekly:
- User pastes notes, voice summary, or multiple screenshots.
- Expected path: process multi-day text, tag as weekly log, create multiple review rows, imports, and duplicate clusters.
- Example: `weekly log: paid zomato, fuel, amazon; gym twice; protein low`.

Monthly:
- User uploads bank/card statements or Excel exports.
- Expected path: import preview first, never direct write; mapping review; duplicate scan against existing live/daily entries.
- Example: `May HDFC.xlsx`, `ICICI card PDF`, `PhonePe screenshot folder`.

Corrections:
- User changes category, amount, macro, duplicate decision.
- Expected path: user correction wins; future model memory later; audit trail required.

## AI Architecture

Gemini:
- Role: media extraction for image/audio/PDF OCR fallback.
- Current Edge Function target: `gemini-2.5-flash`, with Pro fallback intended for high-risk media.
- Secret name: `GEMINI_API_KEY`.

DeepSeek via NVIDIA:
- Role: low-cost reasoning and tool-call planning.
- Secret name: `NVIDIA_API_KEY`.
- Tool calls must pass schema/policy validation before writes.

Validation:
- Unknown tools are blocked.
- Low confidence requires review.
- Destructive actions are blocked.
- Duplicate candidates are reviewed by the user; the app does not delete automatically.

## Supabase Secret Setup

Required local environment variables:
- `SUPABASE_ACCESS_TOKEN`
- `GEMINI_API_KEY`
- `NVIDIA_API_KEY`

Command:

```powershell
cd "C:\Users\Abhay Vasta\Desktop\Gpt\trackerz"
.\scripts\set-supabase-secrets.ps1
```

Gemini smoke test:

```powershell
$env:GEMINI_API_KEY = "<set locally, do not commit>"
.\scripts\smoke-gemini.ps1
```

## Test Coverage Added/Verified

Automated:
- UI contract checks for key controls and removal of hardcoded page metrics.
- Interaction contract checks for complex weekly text plus audio/image files.
- Capture fixture checks for daily, weekly, monthly, file, image, and audio routing.
- Flow catalog checks across 80+ flows.
- Agent policy checks for destructive action blocking.
- Analytics/import checks for budget, macro, statement, and duplicate helpers.

Manual browser QA:
- Fresh reset opens empty.
- Quick text capture fills metrics and tables.
- Dashboard tabs switch.
- Money import action updates import status.
- Settings clear/reset returns the app to empty.

## Remaining Product Gaps

- Supabase auth and RLS are not live in the frontend.
- Supabase Storage upload is not wired for actual media bytes.
- Gemini/DeepSeek calls are not made from GitHub Pages; they must run through Supabase Edge Functions.
- Nightly 12 AM summary is UI/scaffold only until a scheduled Supabase function is deployed.
- Charts are state-derived but still local and shallow until historical records exist.
