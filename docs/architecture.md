# Architecture

The frontend is intentionally split into small modules because AI-heavy apps fail when capture, extraction, validation, UI, and analytics are tangled together.

## Frontend Layers

- `src/ui`: DOM rendering and event binding only.
- `src/services`: UI-facing application services such as capture routing and cost estimates.
- `src/agent`: AI tool registry, policy decisions, model routing, evidence rules, and prompt boundaries.
- `src/imports`: bank statement detection, column mapping, row normalization, and preview creation.
- `src/analytics`: budget trajectory, macro pace, habit score, and insight severity calculations.
- `src/duplicates`: duplicate scoring and clustering helpers.
- `src/domain`: domain defaults for money, diet, and wellness.
- `src/data`: mock data used by the static GitHub Pages prototype.
- `lib`: pure shared primitives that are also tested directly.
- `styles`: layered CSS by concern instead of one giant stylesheet.

## AI Safety Boundary

The model never writes directly to the database. It can only request known tool actions. Backend code validates:

- tool name exists
- action is not destructive
- evidence exists
- confidence is above threshold
- user owns the target rows
- duplicate checks have run
- undo metadata is available

## Deployment Shape

GitHub Pages serves the static frontend. Supabase handles auth, database, storage, and Edge Functions. DeepSeek and Gemini keys live only in Supabase Edge Function secrets.
