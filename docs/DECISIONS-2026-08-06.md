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

---

## Phase 3 - the outbox

**The old queue guarded the wrong thing.** It keyed on `navigator.onLine`, which
reports whether an interface is up, not whether anything is reachable. In a metro
tunnel or a basement car park it stays TRUE while every request hangs; those hangs
landed in the `catch`, and `resetForm()` in the `finally` erased the words. The
one path that reliably destroyed a capture was the one you hit furthest from a
keyboard.

Now every capture is written to IndexedDB **before** any network call, and the
network is a drainer rather than a gate. That single inversion is what lets the
box clear instantly AND guarantees nothing disappears on bad signal: the text does
not vanish, it moves into a visible row that carries the truth.

**`lib/outbox.mjs`** (pure, fuzz-tested):
- Full-jitter backoff. Without jitter a batch queued during one outage all wakes
  in the same millisecond and hammers a server that is still recovering.
- Failure classification that knows 401 and 402 are terminal (retrying a
  signed-out session forever drains the battery; retrying an over-budget capture
  just spends more money) while a timeout is not.
- **Captive-portal detection.** Hotel and airport wifi answer every request with
  200 and an HTML login page. A naive "status === 200" check reads that as
  success and the capture is lost while the UI says saved.
- 60-seed fuzz asserting the only two invariants that matter: a capture is never
  lost, and never applied twice.

**Crash recovery.** A crash is not an event the running code observes, so anything
left in `sending` was interrupted mid-flight. `recoverInterrupted()` on boot hands
it back to the retry machine. Without it, a capture in the air when Android
reclaimed the WebView - the camera Activity is a common trigger - would sit in
`sending` forever, never sent and never surfaced.

**Migration, not replacement.** `outbox-store.js` upgrades the existing v1
database in place and rewrites the rows already in it. Dropping the store on
upgrade would lose exactly the data this exists to protect. Also added `onblocked`
handling: a second tab holding v1 open used to make `enqueueCapture` hang forever,
so the capture was neither sent nor visibly queued.

**The outbox is now the row.** `pushOptimistic`/`updateOptimistic` built a DOM
node that existed only in memory, so a reload erased it while the capture was
still queued in IndexedDB - no way to tell "still trying" from "gone".
`src/ui/outbox-panel.js` renders the same container from storage, so what is on
screen is what is actually persisted. Four states, never silence: queued,
sending, retrying (with the reason and a live countdown), needs-attention (with
what to DO about it, because a user who cannot act re-submits, and that is how a
failure becomes a duplicate row).

**Judgement calls a reviewer might want to reverse:**
1. The interactive submit does NOT go through the drainer. It needs the result
   synchronously to render an answer or a spend suggestion, so it writes to the
   outbox first and then owns the item via `markSending`/`markSent`/`markFailed`.
   The alternative - everything through the drainer - would make questions
   asynchronous, which is a worse product.
2. On success the item is REMOVED rather than kept as `sent`. The domain rows are
   the record from that point, and a lingering item would sit in the queue depth
   forever. The cost is that there is no local history of successful captures.
3. `markSent` and `markFailed` swallow their own errors (`.catch(() => null)`).
   A bookkeeping failure must not turn a successful capture into a user-visible
   error - but it does mean a storage failure at exactly that moment leaves an
   item that will be retried once more. The server's fingerprint guard catches it.
4. The sw.js share-target now writes the v2 shape with a client-minted UUID as
   both primary key and idempotency key. An auto-incremented key cannot serve as
   one, which is why the old `add()` became `put()`.

---

## INCIDENT: the app was live-broken for a few minutes, and unit tests said nothing

Soft-delete landed as code and migration together, but the migration had not been
applied to the live database. Every read in `supabase-data.js` now carries
`deleted_at=is.null`, so **every single query returned HTTP 400**: food, water,
workouts, sleep, reminders, ledger. 32 console errors, 33 failed requests, and
water undo silently stopped working.

`npm test` was **green throughout**. Nothing in the suite talks to PostgREST, so a
column that exists in a migration file but not in the database is invisible to it.
`node scripts/smoke-ui.mjs` caught it in one run, because it drives the real
signed-in app against the real database.

Fixed by applying `20260806000022_soft_delete.sql` (11 tables, idempotent). Verified
after: 0 console errors, 1 failed request (a pre-existing benign vendor probe for
a Node-only module), water 0 -> 250 -> 0 with undo working.

**The rule this proves, and it is already in the plan:** additive column ->
deploy code that tolerates BOTH shapes -> backfill -> only then constrain. Never
one step. Shipping a read that requires a column is not additive, whatever the
migration file says, and the gap between "the migration exists" and "the migration
ran" is where the outage lives.

**Process change:** a schema change is not done when `npm test` passes. It is done
when `scripts/smoke-ui.mjs` passes against the live database. That script is the
only thing in this repo that would have caught this.

---

## The eval harness (cross-cutting)

`tests/agent-eval.test.mjs` replays 15 real captures through the live
deterministic layers and scores them against a hand-written contract. Runs inside
`npm test`: hermetic, offline, free, no model call.

That is not a compromise. On 2026-08-06 the brain routed a permanent diet change
perfectly and `fan-out-expander` appended a 540 kcal meal built from the
instruction text; on 2026-08-04 a note about the app's JSON structure became a
432 kcal meal. In both cases the model was right and this layer was wrong, so
replaying recorded model output through the live guards is exactly where the
value is.

Scoring is partial-credit except for one thing: **a `must_not` hit is a hard zero
for the case.** A phantom meal averaged against fourteen passing cases is how it
survives a green build. Current state: 15 cases, weighted mean 1.000, 0 hard
failures.

The corpus deliberately includes CONTRAST cases (a plain meal, a date-scoped
delta alongside a real log, a mixed "also I just had dal rice"). A guard that
blocks the phantom AND the real meal is not a fix, and without those cases the
suite would happily pass an over-broad guard that logs nothing at all.

`scripts/eval-import.mjs` regenerates the raw half from the live DB but
deliberately does NOT fill in `expect` - seeding the expectation from recorded
behaviour would encode every bug as the contract, and the two phantom meals would
both become "correct" forever.

One case is recorded as a KNOWN GAP rather than silently accepted: with no model
output, an already-logged flag suppresses salvage for the whole domain, so
"had popcorn, already logged, then had a burrito" loses the burrito too.
`dropAlreadyRecordedRows` is per-row but salvage synthesis is all-or-nothing.

---

## Absent is not zero (charts)

`period-aggregator.dailySeries` now returns `null` for a day with no rows and `0`
only for a measured zero - but `src/ui/charts.js` did `Math.round(p.value)`, and
`Math.round(null)` is `0`. So the fix was being silently undone one layer later
and the chart still drew a confident flat bar for a day nothing was logged. Over
a 30-day window that reads as "your intake collapsed" for a week you were on
holiday.

Absent now survives to the renderer and draws as a dashed gap. The one exception
is the CUMULATIVE line, where carrying the previous total forward is correct -
"total spent so far" on an unlogged day is still the previous total, not unknown.
Written explicitly so the next reader does not "fix" it into a gap.

---

## A failed refresh is not a failed write

Nine call sites did `await hydrateStateFromSupabase().catch(() => {})` after
writing a row. Swallowing the refresh looks harmless because the write already
succeeded - and it is the opposite, because of what the user sees: **the row IS
saved and the screen does NOT change**, which is indistinguishable from "my tap
did nothing". So they tap again. That is how one workout became two rows on
2026-07-22.

All nine now go through `refreshAfterWrite(what)`, which says "Saved X, but
couldn't refresh the screen" - a different sentence with a different action
attached - rate-limited to one warning per 30 s so a burst of quick actions
during an outage does not stack six identical toasts.

The swallow ratchet dropped from 99 to 90 as a result, and the guard itself
caught the stale allowlist entries and refused to pass until they were removed.

---

## Audio: the format was always wrong

Gemini accepts wav, mp3, aiff, aac, ogg and flac. It does **not** accept
audio/webm, which is exactly what MediaRecorder produces by default in Chrome and
exactly what this app uploaded. The 400 was caught in the edge function, which
continued with `geminiEvidence = ""`, and the UI still said "Capture saved".

In the browser this was masked because Web Speech supplied a transcript anyway.
In the Android app there is no Web Speech API at all, so voice was completely and
silently dead - which is what the owner was reporting.

Now: `pickRecorderMime()` asks MediaRecorder for a container the API can already
read (ogg/opus first), and anything still unacceptable is converted client-side
to 16 kHz mono WAV before upload. Client-side rather than server-side on purpose:
it also cuts the upload to roughly a tenth of a 48 kHz stereo capture, which
matters far more on a phone than the CPU cost of the decode. Conversion failure
returns the ORIGINAL file rather than throwing - a slightly-wrong upload still
reaches the server where a MIME guard can refuse it loudly, and losing the
recording outright would be worse than either.

---

## Route invariants (Phase 5, ahead of its wiring)

`lib/route-invariants.mjs` turns four prompt rules into enforced contracts:
a standing change may not write a tracker row; standing LANGUAGE alone is enough
even when the model emitted no plan tool; a permanent scope may not carry a delta
(flagged, not dropped - a rejected plan change is a lost instruction); and a plan
change that resolves to nothing is a silent no-op reported as success.

Every violation is counted rather than merely fixed. A rising
`log_from_standing_language` count is the early warning that a model change has
started drifting, and it arrives before the user sees a phantom meal.

---

## Phase 4 - native dictation in the APK

`android/.../speech/SpeechPlugin.kt`, registered in `MainActivity`, preferred by
`src/services/speech.js` whenever `Capacitor.isNativePlatform()`.

**Why it had to exist:** the Web Speech API is a Chrome-the-BROWSER feature, not a
WebView feature. Inside the APK both `SpeechRecognition` and
`webkitSpeechRecognition` are undefined, so `isLiveTranscriptionSupported()`
returned false and the app fell back to record-and-upload - which, until the WAV
conversion landed, produced nothing at all. On the phone, the one place voice
matters most, there was no live text and no working fallback either.

Design points worth knowing:
- The plugin emits the WHOLE transcript on every update, never a fragment. The
  web wrapper treats each update as a replace. Appending is exactly the bug that
  turned one spoken sentence into "I I went I went to the gym".
- Android ends a recognition session at every pause, so a sentence with a breath
  in it arrives as several sessions. The plugin restarts and joins with the same
  overlap-aware algorithm as `joinTranscript` in the JS, so the two engines
  cannot disagree about what the user said.
- `ERROR_NO_MATCH` and `ERROR_SPEECH_TIMEOUT` restart silently rather than
  reporting a failure - the recogniser simply heard nothing for a stretch, and
  surfacing that as an error reads as "voice is broken".
- Error codes deliberately match the Web Speech names (`not-allowed`,
  `audio-capture`, `network`, `no-speech`), so one set of user-facing copy serves
  both engines.
- Reached via `globalThis.Capacitor.Plugins.Speech` - no npm specifier, so the
  no-bundler web build is untouched and it is simply `undefined` in a browser.

**Untested on hardware.** It compiles against the documented SpeechRecognizer
surface and every failure path returns a named code, but which recogniser a given
OEM ships, and how it handles Indian English, has never been observed.

CI now hard-fails if any of the five app-local plugins stops being registered.
`cap add` would replace `MainActivity.kt` with a stock Java stub and drop them
all, and the resulting APK would install perfectly and simply have no microphone,
no SMS capture, no Health Connect and no water widget.

---

## Phase 5 - route invariants wired and deployed

`lib/route-invariants.mjs` is now mirrored into the agent edge function and runs
as the LAST gate in `runPipeline`, after expansion.

**After expansion on purpose.** The 2026-08-06 phantom meal was appended by the
expander, not emitted by the brain, so a guard that checked the model's raw
output would have missed it entirely.

Mirror note: the block deliberately excludes `LOG_TOOLS` and `isStandingChange`,
because the edge function already defines both for the fan-out expander. The
first attempt mirrored them too and produced `TS2393: Duplicate function
implementation`. `scripts/sync-mirror.mjs` also requires the marker pair to
already exist in the destination before it will fill it.

**Deployed as agent v103 and verified live.** Capture:
"from now on I have 6 boiled eggs every single day for lunch"
- routed as `plan_change`
- `salvage alone would emit: (nothing)`
- model emitted `update_plan_candidate` (0.85) + `remember_fact` (0.95)
- **both landed as `proposed`, not `auto_applied`** - the confirm gate holding
- zero rows in `food_logs`
- the real permanent diet plan untouched (still exactly 1)

That is the "two signals for a permanent rewrite" rule working end to end: an
explicit instruction now waits for one tap instead of silently rewriting the
plan, and it cannot produce a meal on the way past.

Measured blast radius of the gate against all 158 historical auto-applied
actions: **8 (5.1%) would now need a tap**, 150 unchanged. Of 6 historical plan
calls, 5 were date-scoped and still auto-apply.

---

## Phase 7 - the timezone bug was live in the data, not just the code

The pattern engine's `lib/tz.mjs` work was gated on proving the day-key bug is
real. It is:

```
select count(*) from workout_logs
where (occurred_at at time zone 'Asia/Kolkata')::date <> occurred_at::date;  -> 2
```

Both rows are 2026-07-22 23:30 and 23:55 UTC, which is **2026-07-23 05:00 and
05:25 IST** - a day AND weekday flip in shipped rows. Also 3 of 76 `food_logs`
and 125 `ledger_entries`. Any weekday pattern built on `toISOString().slice(0,10)`
would have reported those as Wednesday when the user experienced Thursday.

A tz lint now fails the build on any NEW `toISOString().slice(0, 10)`, with the
15 legacy uses frozen as a named budget rather than silently tolerated.

**Gate table, verified numerically in both directions.** Fires at 3/3, 4/4, 4/5,
5/6, 6/7, 6/8. Does not fire at 1/1, 2/2, 3/4, 3/6, 4/6, 5/8. The tightest pass
is 4/5 at a Wilson lower bound of 0.5135 against a 0.50 floor.

The row that justifies the whole design is **2/2**: p = 0.0204, which passes a
naive p<0.05, AND its Wilson bound of 0.5491 passes the coverage gate. Only the
support floor stops it. Two Saturdays is not a habit, and a p-value alone would
have called it one.

**Window anchoring is the judgement call most worth reviewing.** A weekday window
starts at the item's first occurrence rather than at history start. Without it
the flagship case reads 4/6 against six weeks of logs and can never fire. The
bias is that the first trial is a guaranteed success; it is bounded by the
support floor, the 3-distinct-week floor, and specificity computed on the
untouched total. A lapsed habit is still not protected: 3 pizzas then 3 empty
Saturdays is 3/6 and stays silent.

---

## Phase 6 - calendar, reminders and self-triggering tasks

### The last mile: the agent could not write what the engine could read

The recurrence engine understood intervals, nth-weekdays, weekday lists, UNTIL,
COUNT and times of day. The AGENT could write none of them. So *"every other
Wednesday at 18:30"* was stored as a plain weekly rule with no hour: it fired on
the wrong week, at the wrong time, and said nothing about having dropped half
the sentence. A value computed correctly one layer away from where it is needed
is this codebase's signature failure, and this was the largest remaining
instance of it.

`lib/schedule-args.mjs` is the connecting piece, and it is used by **three**
call sites rather than copied into them: the edge function's `applyTool`, the
client's `buildRowForTool`, and its own test. The client copy had already
diverged - it silently dropped every modifier - which meant approving a proposed
reminder by hand produced a *weaker rule* than letting it auto-apply, the exact
thing that file's header comment promises cannot happen.

**`nth_weekday` accepts both forms.** `reminders.nth_weekday` is an `int` column
and the engine reads the weekday from the separate `weekday` field, but a model
naturally writes the RFC form `-1FR`. Sending that through would have failed the
insert on a type error. `parseNthWeekday` splits it into the two integers, and an
explicit `weekday` still outranks the one implied by the ordinal.

**Bad modifiers become null, never a bound.** `interval: 999` is not 52 and
`at_time: "quarter past six"` is not 06:00. A reminder that fires at a made-up
hour is worse than one with no hour, because the no-hour case rides the 07:00
brief and is therefore seen.

### schedule_task_candidate - the app scheduling itself

The distinction from a reminder is *who does the work*: a reminder replays a
sentence on a date, a task reads the day's rows at fire time and may decide to
stay silent. "remind me to drink water at 3pm" is a reminder; "at 3pm tell me
if I am behind on water" is a task.

**Grounding is on the ACT, not the content.** The task's prompt is written by the
model, so it can never be required to echo the user's words. `SCHEDULE_CUE`
checks that scheduling was actually asked for. Without it a hallucinated task is
a push notification at 9am about something nobody asked for.

**Classified `consequential`, not a new `external` tier.** A fourth tier that
behaves identically to an existing one is a name, not a control. Both live
captures below landed as `proposed` and wrote zero rows, as designed.

**A passed hour rolls to tomorrow, unless a day was named.** "check at 3pm" said
at 4pm means tomorrow. But an explicit `on_date` is never rolled forward even if
its hour has passed - the user named the day, and moving it would be the app
overruling a direct instruction.

**Depth 1 on agent-written tasks.** A capture is a human act, but the row is
written by the model, and the loop the depth cap exists to stop is
model-scheduling-model.

### Verified live, on the deployed pipeline (agent v107)

```
"remind me to call the accountant every other Wednesday at 6:30 pm"
  -> create_reminder_candidate conf 0.98
     {weekday:3, interval:2, at_time:"18:30", dtstart:"2026-08-12"}
  -> status 'proposed', zero rows written
  -> confirm path builds: "Wednesday, every 2nd week at 18:30"
     firing 2026-08-12, 08-26, 09-09

"every Sunday evening at 9pm look at my spending and tell me if I am over budget"
  -> schedule_task_candidate conf 1.00
     {intent:"review", freq:"weekly", weekday:0, at_time:"21:00"}
  -> status 'proposed', zero rows written
  -> confirm path builds fire_at 2026-08-09T15:30Z = 21:00 IST Sunday

pg_cron self-triggering, unattended, twice:
  one-shot   inserted 04:17:33Z -> fired 04:18:00Z, status 'done'
  recurring  inserted -> fired within 40s, run status 'silent'
             ("silent: nothing worth saying", $0.000222 in agent_task_runs)
             re-armed itself to 2026-08-09T15:30Z, the next Sunday 21:00 IST
```

The silent run is the one worth reading twice: a check that finds nothing worth
saying writes a row saying so. Silence with a trace is a feature; silence
without one is the bug this whole audit started from.

### Tasks are on the calendar, and autonomy has a switch

`taskAsCalendarRow()` shapes an `agent_tasks` row as a reminder rule, so the
calendar renders both from one code path and cannot show a task on a different
date from the reminder beside it. It returns null for anything that will never
fire again - a calendar showing impossible dates is worse than one that omits
them. Tasks carry their own glyph, not a colour, so the distinction survives
a grayscale screenshot and a colourblind reader.

Reminders and tasks are fetched separately and **fail separately**: a task-table
error must not hide every reminder, and it is shown rather than rendered as an
empty list.

Settings gains the autonomy master switch. It reads `=== true`, not
`!== false` - an unreadable or absent flag must never render as permission. A
failed write snaps the box back, because a switch that reads ON while the server
has it OFF is a promise the app cannot keep.

### Open, deliberately

Google Calendar sync (plan 6.8) is not built. It is the one part of Phase 6 with
a real external conflict surface, and the loop guards, token storage and 410-GONE
handling it needs are a phase of their own rather than a tail-end addition to
this one. The provider-adapter seam it needs is what the local calendar being
source of truth already provides.

