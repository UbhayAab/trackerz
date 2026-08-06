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

**Live data corrected.** The guard stops new phantoms; it cannot un-write the one
already in the database. `food_logs` row `a1de7c21` ("Hey actually my diet has
changed...", 540 kcal, 64.7 g protein, meal_slot lunch, 2026-08-06) was deleted
and its `ai_actions` row set to `status='reverted'` with the reason recorded in
`undo_payload`. It was still being auto-ticked against "Protein milk shake" on
the home card at the time of removal. Today's totals went from 540 kcal / 64.7 g
to 0 - i.e. the entire day's logged intake had been fabricated from an
instruction.

A second `_auto_expanded` row ("6 boiled eggs", 432 kcal, 2026-07-29) was checked
and **kept**: that one is a legitimate salvage of a real meal.

---

## Phase 0.2 - grounding the seven ungrounded write tools

`isGrounded()` ended in `default: true`, and the comment claiming only non-write
tools reached it was false: `update_plan_candidate`, `set_target_candidate`,
`remember_fact`, `create_note_candidate`, `create_reminder_candidate`,
`create_hydration_candidate` and `create_sleep_candidate` are all in
`WRITE_TOOLS` and all skipped grounding. All seven now have cases, with a
structural test asserting set-equality between `WRITE_TOOLS` and the `case`
labels in both directions, so the next tool added cannot silently fall through.

**OPEN ITEM, and the most important one in this document.** Grounding failure
only **tags** (`low_evidence` into `undo_payload`); it does not demote or block,
and `low_evidence` currently has **zero consumers** anywhere in `src/`, `lib/` or
`pages/`. So "a photo of someone else's meal plan can silently replace yours" is
still true - the write is now labelled, not prevented.

Deliberately not made load-bearing yet: with `AUTO_APPLY_MIN_CONFIDENCE = 0`, no
approve gate, and a review queue that has never been rendered in any surface,
demoting these to `proposed` would route legitimate rows into a place nobody
looks - which is the exact silent-loss failure this codebase keeps rediscovering.
Grounding becomes a gate in Phase 2, once the confirm/diff UI exists to receive
what it stops.

Threshold call worth knowing: `update_plan_candidate` grounding uses a minimum
word length of 4. Replaying the new logic over all 26 historical `ai_actions`
rows for these tools gives 25/26 passing. The single flag is a real plan change
("No gym due to travel and rest") that fails only because "gym" is three letters.
Dropping to 3 makes it 26/26 - but "day" is a substring of "today", and nearly
every plan summary contains "day" while nearly every capture contains "today",
which would make plan grounding permanently true. Kept 4, accepted the one false
flag.

---

## Phase 0.9 - costs and the silent fallback

`estimateCostUsd` hardcoded `0.075 / 0.3` and was used for the DeepSeek answer and
summary passes and as the whole-run fallback. Deleted; everything now routes
through `costOf` with the resolved provider's rates. Gemini constants corrected
to `0.30 / 2.50`. The same stale pair was found and fixed in `jarvis/index.ts`.

Measured rather than assumed: the main capture path already used `costOf` with
DeepSeek rates and was accurate to the fourth decimal. The real understatement
was on the 6 Gemini-fallback runs (4.8x under), and the `estimateCostUsd` path is
7.3x under for any DeepSeek tokens it touched. At the measured average run cost
(~$0.0044) a $2/day cap is ~450 captures/day, so this is a correctness fix, not a
live spend change.

The Gemini fallback now writes `provider: 'gemini-FALLBACK'` and the reason into
`ai_runs.error_message`. Six such fallbacks had happened between 2026-07-01 and
2026-07-25 and nothing anywhere surfaced them.

---

## Phase 0.10 - midday

`"midday"` was missing from the jarvis action allowlist while `runMidday` was
dispatched 37 lines later, so every pg_cron and heartbeat call to that slot has
returned 400 since it was written. Confirmed against the live DB: `briefings`
holds 50 morning, 50 closeout, 50 evening, 8 weekly and **0 midday**. Fixed, with
a structural test asserting the allowlist equals the dispatched set, and that
every `jarvis_ping('x')` in migrations and every `ACTION=x` in the heartbeat
workflow is accepted.

---

## Phase 0.3-0.7 - voice, submit, progress

**Voice.** `event.results` is a live cumulative list; `aggregate += chunk` across
events built a staircase of the sentence's own prefixes. Rebuilt from index 0 on
every event with an overlap-aware word-level join, plus `collapseStutter` to
repair text from any transcription source (the broken row is already in
`raw_ingestions`, and a native recognizer can produce the same shape).

Two algorithm choices worth reversing if they annoy: the join matches on WORD
boundaries, not characters, because a character-level overlap fuses "the" +
"the gym" into "thethe gym". And `collapseStutter` also normalises a genuinely
doubled word ("very very good" -> "very good"). That is deliberate and asserted
in the test: a doubled intensifier costs nothing in a food log, while a staircase
costs a fabricated meal, because the whole string becomes evidence for the agent.

**Live text into the textarea**, matching the Gym page. Home was writing it into
`state.activeJob.detail`, which renders inside a collapsed `<details>` - the text
was not slow, it was invisible. Also removed `updateState` from the per-word
path: it serialised the whole app state to localStorage and re-rendered seven
panels once per spoken word.

**Process implies Stop.** Submitting mid-recording awaits the recorder's flush
(800 ms bounded race) before reading files. Previously the audio File was built
in the `stop` listener, which fired after `resetForm()` had cleared
`pendingMediaFiles` - so the blob silently attached to the NEXT capture.

**Audio MIME.** The blob was labelled `audio/webm` regardless of what
MediaRecorder actually produced, and Gemini does not accept `audio/webm` at all.
Now uses `recorder.mimeType`. This is why a voice note with no live transcription
produced no evidence while the UI still said "Capture saved".

**Instant clear.** The box empties immediately and the submit button is never
held disabled through the round trip. A failure enqueues rather than discards; if
the queue also fails, the text goes back in the box unless the user has typed
something new.

**Progress.** The bar is now the empirical CDF of the user's own past runs of the
same shape (`lib/eta.mjs`, seeded with the 18 measured latencies: p50 12.3 s,
p90 27.1 s, max 45.7 s). It replaces `Math.min(92, stages.length * 14)`, which
hit 92% when reasoning began and froze there for the whole model call. Clamped at
97% so only completion reaches 100; past p90 it stops counting down and says
"taking longer than usual" rather than lying. Under 5 samples for a bucket it
shows an indeterminate sweep and NO number - inventing one is what produced the
old "~undefineds" pill.

90 s request timeout added (~2x the slowest run ever measured). Previously a
stalled connection disabled the button forever.

---

## Phase 0.8 - water

`withBusy` did `if (state.busy) return;` and then awaited a server round trip plus
a full refresh, so six rapid taps logged **one** 250 ml. Replaced with an
optimistic reducer (`lib/water.mjs`, pure) and a debounced batch write: six taps
now produce six rows in one round trip, with the number moving on every tap.
Browser-verified with Playwright against a stubbed REST layer, and end-to-end
against the live DB via `scripts/smoke-ui.mjs`.

Goal is now editable (`budgets.kind = 'daily_water_ml'`) with the scaffold sum as
fallback, and clamped - a goal of 0 previously made the percentage `Infinity`.

Sub-agent decisions left in place: a successful flush does not trigger a refresh
(so a row logged on another device appears on the next refresh, in exchange for
one round trip per burst instead of five); the long-press menu's +500/+1L share
`data-act="water"`, so three elements match while it is open; water uses the
wellness blue rather than the app accent, because green already means money.

---

## APK

The binary was never the problem. The published asset is 6,886,605 bytes - which
Chrome renders as "6.89 MB" - the zip verifies clean, v1+v2+v3 signatures are
present, the signer fingerprint matches the CI pin, and it had already downloaded
four times.

**Cause: the launch context.** `display: standalone` plus an out-of-scope
`github.com` link means the installed PWA opened the download in a Custom Tab
*inside itself*, where the progress and the Open button have nowhere to surface.
Now forced to a real browser tab with `target="_blank"`. (A `download` attribute
would not help - Chrome has ignored it cross-origin since Chrome 65.)

**Cause: the release was deleted and recreated on every push.** That mints a new
asset id and ETag, so a paused or resumed download hits an object that no longer
exists and parks in pause/resume forever; and a run cancelled between the delete
and the create leaves the URL 404ing, which Chrome saves as `trackerz.apk`. Now:
create-if-missing, then upload an **immutable** `trackerz-1.0.<build>.apk` plus a
clobbered floating `trackerz.apk` and a `latest.json` with size and SHA-256.
`cancel-in-progress` turned off so a publishing run is never killed mid-step.

**Manifest.** Added `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` - without them
Capacitor's permission bridge is denied instantly with no dialog, so microphone
capture was *impossible* in the app regardless of any JS fix - plus `CAMERA`,
`POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED` and the `RecognitionService`
`<queries>` intent (needed on API 30+ or the on-device recognizer is invisible).

**CI integrity.** Three source files carried a comment claiming the workflow
restores the manifest after sync. No such step existed. Added assertions on the
load-bearing manifest lines and on `MainActivity.java` not appearing, because the
`cap add` fallback branch would regenerate both and CI would happily publish a
signed APK with no SMS, no Health Connect, no mic and no registered plugins.

`docs/` and `*.md` excluded from the APK payload - 1.8 MB of audit screenshots
were being baked into `assets/public` where nothing can read them.

`webContentsDebuggingEnabled` set to false in release (it allowed any
USB-connected machine to attach DevTools to a live Supabase session). Service
worker registration skipped on native, and `sw.js` VERSION bumped after 12 days
stale - it caches by VERSION and only purges on change, so the old shell was
being served over new code.

**Still unverified:** whether the APK installs on the actual phone. Everything
above is reasoning from the artifact and the launch context; the first on-device
install is the real test.
