# Trackerz → Next.js on Vercel — migration blueprint

**Target stack:** Next.js (App Router, TypeScript) + Tailwind + Framer Motion,
hosted on **Vercel**. Backend UNCHANGED: **Supabase** (Postgres + Auth + RLS +
Storage) and the existing Deno edge functions (`agent`, `nightly`,
`email-inbound`). Not MongoDB, not a separate Express server.

**Why this shape:** the AI brain (`lib/*.mjs`) already runs in Node (the 47
tests). The safety model is Postgres RLS. So we keep the whole backend and only
rebuild the **UI** in React. The frontend calls Supabase directly (RLS-scoped by
the user session) and invokes the `agent` edge function for captures — exactly
like the current app.

## Repo layout during the rewrite

```
trackerz/
  web/                     ← the new Next.js app (Vercel Root Directory = web)
  src/ index.html …        ← the current static app (stays live on Pages until cutover)
  lib/ supabase/ tests/     ← shared brain + backend, unchanged
```

Vercel project → **Root Directory: `web`**, framework auto-detected (Next.js).
Env vars on Vercel: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(prod defaults are also baked into `web/src/lib/config.ts`, so it runs with none).

## Cutover (big-bang)

1. Build `web/` to feature-parity on this branch.
2. Point a Vercel project at `web/` → preview deploys per push.
3. When parity is verified on the preview URL, set the custom domain / make it
   the primary. Optionally retire the GitHub Pages workflow.
4. The edge functions + DB never move, so there is no data migration and no
   downtime — only the frontend origin changes.

## Frontend architecture

- **Rendering:** mostly client components (like today), a thin server shell.
  Data is fetched client-side with the browser Supabase client so RLS applies
  via the user's session. `middleware.ts` refreshes the session + gates auth.
- **Design system:** CSS variables (dark-first, premium palette) in
  `globals.css`, surfaced through Tailwind's `theme.extend`. Framer Motion for
  page transitions, list stagger, capture feedback, number tickers.
- **Shared brain:** pure `lib/*.mjs` modules are imported directly where the UI
  needs client-side logic (formatters, reconcile, additions, plan). Copied into
  `web/src/lib/brain/` at cutover (or wired via a path alias) so Vercel's
  root-dir build includes them. Server-side reasoning stays in the edge fn.

## Page port checklist (parity target)

| Route | Source today | Status |
|-------|--------------|--------|
| `/` Home | `src/pages/*` + capture | ⏳ scaffolded: capture + glance + feed |
| `/money` | `pages/money.html` | ☐ stub |
| `/diet` | `pages/diet.html` | ☐ stub |
| `/gym` | `pages/gym.html` | ☐ stub |
| `/analytics` | `pages/analytics.html` | ☐ stub |
| `/settings` | `pages/settings.html` | ☐ stub |
| `/login` | `auth-gate.js` | ⏳ scaffolded |

## What's DONE in this first commit

Runnable foundation: scaffold + config, design system (tokens + Tailwind +
motion), Supabase client + auth middleware, app shell (top bar, bottom nav,
animated page transitions), the **capture bar wired to the `agent` edge
function**, a Home page reading real metrics + additions feed, login, and
stubs for the other five routes.

Run it:
```bash
cd web && npm install && npm run dev   # needs npm (this sandbox has none)
```

## Remaining (next commits)

Port Money (ledger + statement import), Diet (plan check-off + macros), Gym
(Hevy-style sets + auto-check), Analytics (charts via Recharts), Settings
(profile, push, plan paste). Then the shared-brain copy step + Vercel wiring.
