# Decision log - 2026-08-06 overhaul

Running log of every judgement call made while executing the plan, so any of it
can be reversed later without re-deriving the reasoning. Newest at the bottom of
each section.

Plan: `C:\Users\abhay\.claude\plans\cosmic-sniffing-thimble.md`

---

## Naming

**The app and the assistant are both called Deno.**

- Renamed: every user-visible surface - page titles, `manifest.webmanifest`
  name/short_name, on-screen copy, brief and notification copy, README.
- **Not** renamed, deliberately:
  - `android/app/build.gradle` `applicationId com.ubhayaab.trackerz`. Changing it
    makes this a *different app* to Android: the existing install cannot be
    updated over, and given we were already fighting install failures that would
    have made things worse. Data lives in Supabase so nothing is at risk either
    way, but an in-place update is worth keeping.
  - The `jarvis` edge-function slug, the `jarvis_ping()` SQL function, the
    `jarvis_*` pg_cron job names, and `JARVIS_CRON_SECRET`. Renaming those is a
    coordinated migration across pg_cron + the GitHub heartbeat + scripts, and a
    half-applied rename silently kills the daily brief slots.
  - `Deno.env.get` / `Deno.serve` - that is the edge runtime, not us. This is the
    one real cost of the name: inside `supabase/functions/**`, "Deno" means the
    runtime. Internal identifiers stay `jarvis` partly to keep that unambiguous.

---

## Phase 0.1 - an instruction is not a meal

**Root cause found, and it was not the model.** For the 2026-08-06 capture
("my diet has changed I every single day now have two scoops of whey protein
with 500 grams of curd...") the brain routed perfectly: `update_plan_candidate`
at 0.95 plus `remember_fact` at 0.85. `lib/fan-out-expander.mjs` then *appended*
a `create_food_log_candidate` whose description was the first 120 chars of the
instruction, at confidence 0.60 with `_auto_expanded: true`. That became a
540 kcal / 64.7 g row, and the diet reconciler matched it back to "Protein milk
shake" and rendered that item ticked - the exact item being replaced.

**Two independent guards, because one is not enough.**

1. *The model's routing counts as evidence.* If the brain emitted a standing
   change, salvage is suppressed and model-emitted log tools are filtered out.
2. *The cue list learned the declarative voice.* `PLAN_CHANGE_CUES` was written
   entirely in the imperative ("change my diet") and had nothing for the perfect
   form ("my diet has changed") or for "I now have X every day". Added those plus
   Hinglish `ab se` / `ab main`.

Guard 2 matters because salvage runs even when the model returns nothing at all -
`scripts/capture.mjs --dry` proved guard 1 alone still fabricated the meal.

**Scoped to STANDING changes only - and this was learned by breaking a test.**
The first attempt treated *any* `update_plan_candidate` as a command. That broke
the real capture "drakn 500 g curd, with 2 scoops of protien powder. and no gym
today": the model answers a gym denial with an unscoped rest plan, so the whole
capture became an "instruction" and the 500 g of curd was silently dropped.

Resolution: only a **permanent-scope** plan change (or any `set_target_candidate`)
counts. A *date-scoped* delta is what the LOG-THAT-CONTRADICTS-THE-PLAN rule
deliberately emits *alongside* a real log. Denials additionally outrank the
model's routing outright, because an unscoped scope reads as permanent and a
denial is a report about the day, never a setup change.

**Files:** `lib/fan-out-expander.mjs`, `lib/request-router.mjs`,
`supabase/functions/agent/index.ts` (hand-maintained mirror - `fan-out-expander`
and `request-router` are NOT in `scripts/sync-mirror.mjs`, they are copied by
hand and guarded by `tests/mirror-parity.test.mjs`).

**Gotcha for future edits:** `tests/mirror-parity.test.mjs` extracts string
literals from cue arrays with a regex and cannot tell a cue from a comment. Any
comment *inside* one of those arrays must not contain quoted example prose, or it
is parsed as a cue and reported as drift. Long explanations go above the `const`.

**Verified:** `npm test` full suite green; `scripts/capture.mjs --dry` on the real
text now prints `routed as: plan_change` and `salvage alone would emit:
(nothing)`. New regression block in `tests/fan-out-expander.test.mjs` covers the
permanent case, a model-emitted phantom, a target change, the date-scoped
counter-case, the mixed "also I just had dal rice" case, and the
no-model-output-at-all case.
