# A meal filed as a note - 2026-07-28

A capture of three consumed items logged **zero calories**. Nothing errored,
nothing queued, nothing landed in review. The pipeline reported success.

```
Coca Cola Zero Sugar Soft Drink Can (300 ml) × 3
Eat Better Co Ragi Chips, Achari Masti (55 g) × 1
Eat Better Co Ragi Chips, Thai Chilli Tadka (55 g) × 1
```

## The trace

| Stage | Result |
| --- | --- |
| `raw_ingestions` | `bec702ca`, 06:29 IST, `status='processed'`, text intact |
| dedupe | a second identical capture 30 s later correctly marked `duplicate` |
| `ai_runs` | `deepseek-reasoner`, `completed`, 8.95 s, no `error_message` |
| `ai_actions` | ONE call: `create_note_candidate`, `domain:"diet"`, confidence 0.80 |
| applied | `notes` row `7e04b30d`. Zero `food_logs`. |

Three independent layers had to miss for this to happen.

## 1. The model knew it was food and filed it as prose

DeepSeek tagged the capture `domain: "diet"` - it understood the content
exactly - then reached for `create_note_candidate`. Every other capture in the
corpus is a sentence a person says ("2 bricks of maggi and one dosa"). This one
is an **order manifest**: brand, product, pack size, `× N`, one item per line,
no verb. `SYSTEM_PROMPT` carried no example of that shape, so the model fell
back to "unstructured text → note".

## 2. The salvage net had a vocabulary hole

`fan-out-expander.mjs` exists to synthesize a food log when the model
under-emits. Replayed against the real text:

```
foodCuesIn        -> []
namesDish         -> false
expandToolCalls([], …) -> []      // salvage fired nothing at all
```

Salvage gated on `FOOD_WORDS`, a hand-written list of ~90 mostly home-cooked
Indian dishes: no soft drinks, no packaged snacks, no brands.

The part that made it a defect rather than a missing word: **`food-nutrition.mjs`
already knew these foods.** `cola`, `coke`, `chips`, `soft drink` and `namkeen`
all returned recognized totals. Two hand-maintained food vocabularies had
drifted, and the gate used the poorer one. Measured at the time of the fix:

> **119 of the 254 aliases the app could already price were invisible to
> salvage** - including `coke`, `cola`, `chips`, `biscuit`, `bread`, `cheese`,
> `butter`, `namkeen`, `chocolate`, and `whey` / `whey scoop` / `protein scoop`.

A whey-only capture would have failed the same way. The curd-and-whey log that
same afternoon only survived because `curd` happened to be on the list.

## 3. Even if salvage had fired, the macros would have been wrong

`estimateNutrition` did not recognise any of the three items. The nearest match
it held was `cola` at 140 kcal / 39 g carbs - **regular** cola. Three Zero Sugar
cans would have been charged **420 kcal and 117 g of carbs they do not
contain**. There was no zero-sugar row, and no ragi/millet chips row at all.

## Contributing: there is no review gate

`src/agent/action-policy.js` auto-applies every non-blocked action;
`confidencePolicy` only tags `reasons`. So a confidently wrong tool choice
commits silently instead of surfacing as "needs a look". CLAUDE.md still
documented the old `review ≥ 0.72` gate and has been corrected.

## What was changed

1. **`FOOD_WORDS` is now derived from `FOOD_TABLE`**, not hand-written
   (`lib/fan-out-expander.mjs`). All 119 gaps closed at once, and the class of
   bug is now structurally impossible: adding a food teaches salvage in the same
   edit. `tests/fan-out-expander.test.mjs` asserts the invariant directly - every
   priceable alias must be a salvage cue.
2. **Two table rows added**: `diet soft drink` (2 kcal) and `millet chips`
   (250 kcal / 55 g pack). A `SUGAR_FREE_CUE` qualifier scan reroutes a sugared
   drink to its zero row - it must be a qualifier scan and not an alias, because
   the sugared alias usually still matches ("Coca Cola **Zero Sugar** Soft Drink"
   contains both `cola` and `soft drink`).
3. **Order-manifest parsing**: a trailing `x N` is the line-item count; lines are
   the outer parse unit so a comma cannot strand the count on a flavour fragment;
   same-food aliases collapse within a phrase; bracketed pack sizes (`(300 ml)`)
   no longer leak out as unknown foods. Measure-word plurals (`scoops`, `cups`)
   added to `STOPWORDS` - their absence had been silently costing `2 scoops whey`
   its macros.
4. **`SYSTEM_PROMPT`** now teaches the order-manifest shape and states that
   `create_note_candidate` is never right for something consumed, spent or done.
5. **`tests/food-mirror.test.mjs`** (new) proves the edge function's hand-copied
   nutrition engine returns identical numbers to `lib/` over 35 captures. It
   extracts the block, lets Node strip the TS types, and runs both. The old
   `mirror-parity` static text check could not cover this block (the edge copy
   has type annotations and different function names), which is why it drifted
   unnoticed. Verified to fail on injected drift, not just to pass.
6. **`scripts/sync-mirror.mjs`** regenerates the edge's `FOOD_WORDS` literal from
   the lib's runtime value, since it is no longer copyable as text.

Result on the original capture: `recognized: true`, **506 kcal / P9 / C67.5 /
F22**, with the 3 cans priced at 6 kcal rather than 420.

The meal itself was backfilled onto the original ingestion id by
`scripts/log-food-2026-07-28b.mjs` so it stayed attached to the capture the user
actually made.
