# Ubhay Life OS

A private, phone-first life logger for money, diet, fitness, and wellness.

The app is designed for GitHub Pages on the frontend and Supabase for auth, data, storage, and Edge Functions. DeepSeek v4 Pro is the main reasoning agent. Gemini handles image/audio understanding when media is uploaded.

## First Principles

- Open the app and capture immediately: text, images, files, voice, or end-of-day dumps.
- Store raw inputs, parsed candidates, AI actions, and final records separately.
- Let AI move fast, but only through typed tools, validation, audit logs, dedupe checks, and undo.
- Support one user first, but keep every table multi-user ready.
- Make insights available all the time: hard charts plus AI summaries for day, week, month, and trajectory.

## Local Files

- [index.html](index.html): GitHub Pages-ready static app shell.
- [styles.css](styles.css): mobile-first operational UI.
- [app.js](app.js): mock capture, charts, cost calculator, and dashboard state.
- [docs/user-flows.md](docs/user-flows.md): detailed user flows and quality-of-life map.
- [docs/feature-atlas.md](docs/feature-atlas.md): expanded capability map.
- [docs/ai-scaffolding.md](docs/ai-scaffolding.md): model routing, tools, safety rails, tests, and cost policy.
- [docs/imports.md](docs/imports.md): bank Excel/CSV/PDF import plan.
- [docs/testing-plan.md](docs/testing-plan.md): unit and AI eval strategy.
- [lib/flow-catalog.mjs](lib/flow-catalog.mjs): executable flow catalog rendered by the UI and tested locally.
- [lib/agent-core.mjs](lib/agent-core.mjs): pure duplicate, routing, cost, import, and tool validation logic.
- [supabase/schema.sql](supabase/schema.sql): database skeleton.
- [supabase/config.toml](supabase/config.toml): project/function config scaffold.
- [supabase/functions/agent/index.ts](supabase/functions/agent/index.ts): Edge Function scaffold.
- [scripts/set-supabase-secrets.ps1](scripts/set-supabase-secrets.ps1): pushes model keys to Supabase Edge Function secrets from environment variables.
- [scripts/smoke-deepseek.ps1](scripts/smoke-deepseek.ps1): verifies the NVIDIA-hosted DeepSeek endpoint from an environment variable.

## Key Policy

Never put DeepSeek, Gemini, NVIDIA, Supabase secret, or service-role keys in the frontend or repository. GitHub Pages gets only the Supabase publishable key. All model keys live as Supabase Edge Function secrets.

## Current Status

This is a static scaffold and decision base. It does not yet connect to Supabase or live AI services. The next implementation step is wiring Supabase auth, migrations, storage buckets, Edge Function secrets, and the ingestion pipeline.

Supabase Edge Function secrets require a Supabase personal access token with secret-write permission. The project publishable/secret API keys are not enough to create Edge Function secrets through the Management API.

## Tests

Run:

```powershell
node tests/agent-core.test.mjs
node tests/flow-catalog.test.mjs
node tests/capture-fixtures.test.mjs
node tests/ui-contract.test.mjs
node --check app.js
```
