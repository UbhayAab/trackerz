# Data audit - 2026-08-08

Every number below came from a query run against the live DB via
`node scripts/q.mjs`. Nothing is estimated, recalled or carried over from an
earlier document.

**Window:** IST 2026-07-09 00:00 to 2026-08-07 23:59 = 30 days.
**Clock at audit time:** DB `now()` = 2026-08-07T19:33Z = 2026-08-08 01:03 IST.
**Account:** the owner is `548339a8-6d61-4bd9-bc7e-9768be01e4eb` and owns every
capture, meal, workout and ledger row in this database. **Two other `profiles`
rows exist** - `b788d68f…` (created 2026-05-23) and `2f953b03…` (created
2026-08-07) - and while they own no domain data, jarvis does close their days:
they hold 16 and 1 `habit_days` rows and 55 and 3 `briefings` rows respectively.
Reading this table without `user_id` in the GROUP BY is what produced two
retracted findings in this document (section 7). Every figure below is filtered
to the owner unless it says otherwise.

## The rule this document follows

Absence is never printed as a measurement. Where something was not logged it
says **not logged**, not `0`. Where a read could not distinguish "none" from
"unknown", it says so. Several of the findings below are precisely this failure
happening inside the app itself.

---

## 1. Captures

| | |
|---|---|
| `raw_ingestions` all time | 130 |
| in window | 85 |
| `status='processed'` (all time) | 126 |
| `status='duplicate'` (all time) | 4 |
| `status='queued'` | **0** |
| `status='failed'` | **0** |

**Nothing is stranded on the phone.** The recent "Show the captures that are
sitting on the phone" work has nothing to show: there is not a single queued or
failed ingestion in the database, and there never has been one that survived.

Sources in window: `text/auto` 80, `text/manual` 3, `text/money` 1,
`text/wellness` 1. No ingestion in the window is recorded with a non-text
`source_type`.

### Captures that produced no domain row

27 ingestions in the window wrote nothing to `food_logs` / `ledger_entries` /
`workout_logs` / `notes`. Breaking that down honestly:

- **8** are reminder or calendar text (owned by other work, not assessed here).
- **4** are `status='duplicate'` and were correctly suppressed.
- **3** are the owner talking to the app, not logging anything
  (`"Wtf happenend"`, `"Look at the cal numbers that you have pushed. Fix all"`).
- **1** is `"Masala dosa"` at 2026-07-26 07:18, which a retry 78 seconds later
  logged successfully. Not a loss (this exact case is documented in
  `scripts/repair-notes-2026-07-31.mjs`).
- **Genuine losses - 3:**

| when | text | what was lost |
|---|---|---|
| 2026-07-09 09:58 | `Just ate 20 rupees lays and 60 for 3 boiled eggs and some riata` | one meal **and** Rs 80 of spend. The only action recorded is a `request_user_review` whose reason is `agent_error: Failed to send a request to the Edge Function`, later `rejected`. |
| 2026-07-22 09:04 | `6 boiled eggs` | one meal |
| 2026-07-30 09:13 | `6 boilede ggs` | one meal - the typo defeated the lookup, and nothing said so |

---

## 2. Food

| | |
|---|---|
| rows in window | 62 at audit time, **61** after the phantom below was removed |
| days with at least one food row | **20 of 30** |
| days with no food row at all | **10** |
| avg calories on days he logged | 1,567 kcal |
| avg protein on days he logged | 94.2 g |
| highest day | 3,300 kcal (2026-07-24) |
| lowest day | 486 kcal (2026-07-20) |
| days over 2,000 kcal | 5 of 20 |

**The 10 blank days are consecutive: 2026-07-10 through 2026-07-19.** Those are
not zero-calorie days. Nothing was logged; what he ate is unknown.

### Protein against target

The 07:00 brief announces "Targets: 162g protein, 2000 kcal". That 162 comes
from `MACRO_TARGETS` in `lib/diet-scaffold.mjs` - a code default. **The
`budgets` table has 0 rows**, so no target has ever actually been saved.

- Days reaching 162 g: **0 of 20.**
- Days reaching 90% of it (145.8 g): **2** - 2026-08-05 (155.5 g) and
  2026-08-06 (153.2 g).
- Average on logged days is 94.2 g, i.e. 58% of the target he is measured against.

### What he actually eats

Top repeats in the window: `6 boiled eggs` x 8 (432 kcal / 38 g each),
`Protein milk shake` x 6 (371 kcal / 55 g), `4 boiled eggs` x 2,
`Whey protein with curd` x 2. 15 food rows in the window mention boiled eggs.

Meal slots: lunch 25, snack 20, dinner 10, **breakfast 6**, other 1. Breakfast
appears on 6 of 30 days.

### Two data defects in `food_logs`

1. **A meal was filed on 2026-10-19** - 73 days in the future. Row
   `41f2c028-d519-4225-b2a5-66f311d5a967`, description
   `"My bday is 19 oct 2002\n\nAlso, I had 50g aloo bhujia and 2 soop sachet,
   the same as yesterday"`, 150 kcal / 3 g protein, `ingestion_id = null`. The
   birthday date in the sentence became the meal's date.

   **CORRECTION, and it changed the repair.** The first draft of this document
   said "his real 2026-08-06 lunch is missing from that day". That was wrong, and
   checking it before writing is what caught it. The meal is *not* missing from
   2026-08-06. The identical 91-character sentence - same typo, same "the same as
   yesterday", same birthday line - was ingested **twice** on 2026-08-06 under a
   byte-identical `capture_fingerprint` (`5654277c…`):

   | ingestion | at | wrote |
   |---|---|---|
   | `d0a60123` | 15:14:33Z (20:44 IST) | `food_logs 1b90dbea` - "50g aloo bhujia and 2 soup sachets", snack, **2026-08-06**, 365 kcal / 8 g. Correct in every field, and exactly what `lib/food-nutrition.mjs` prices it at. |
   | `f7c1aa50` | 16:48:24Z (22:18 IST) | `food_logs 41f2c028` - the bad row above |

   Re-dating `41f2c028` to 2026-08-06 as originally planned would have logged the
   same bowl of bhujia **twice** (730 kcal) and invented a 12:00 "lunch" on a day
   whose real entry is a 20:44 snack. So the repair is a **delete, not a
   re-date** - see section 9.

   The idempotency guard is not at fault. `CAPTURE_DEDUPE_WINDOW_MIN = 10` in the
   edge function, deliberately: "the same purchase made again an hour later is
   real". Every other repeated fingerprint in this database (the Domino's paste,
   "Masala dosa", the Coke manifest) was a re-send 0 to 1 minutes apart and was
   correctly caught. This one arrived 94 minutes later and legitimately passed.
2. **One row has `protein_g = null`** (on 2026-07-24). That day's stated 45.4 g
   is a partial sum over the rows that have a value, not a measurement of the
   day. Still open.

---

## 3. Gym

| | |
|---|---|
| days trained (`status='done'`) | **7 of 30** |
| days explicitly marked skipped | 3 |
| days with **no gym row at all** | **20** |

Twenty days out of thirty are unanswered - the app cannot tell a rest day from a
day it never asked about, and nothing in the UI distinguishes them.

Quality of the rows that exist (9 `done` rows in window):

- **8 of 9 have `duration_min = null`.** There is no training-volume data.
- **4 of 9 have `ingestion_id = null`** - logged by the Home button with no
  capture behind them, so there is no description of what was trained.
- No phantom rows found: every `done` row has a plausible same-day capture or an
  explicit button press, and `scripts/repair-phantom-workouts.mjs` already
  cleared 5 historical ones (audit_log, 2026-07-22).
- 2 workout candidates were `rejected` in the window (2026-07-30, 2026-08-03),
  and both of those days have a `done` row anyway - dedupe, not loss.

---

## 4. Money

Read with `rowCountsAsSpending` semantics (`lib/txn-semantics.mjs`), i.e. the
`counts_as_spending` column, never raw outflow.

### The last 30 days

**7 ledger rows. Rs 1,233 total. All of them hand-typed** (`flow_type` is null
and `source_type` is null on all 7).

That is what the app knows. It is not what he spent. **The last bank-derived row
in the database is dated 2026-06-29 - 38 days ago.** July and August have no
statement data at all. Any sentence of the form "you spent Rs 1,233 last month"
is false; the honest sentence is "the app has no idea what you spent last month."

The 7 rows: Movie tickets Rs 484 (2026-08-01), an uncategorised Rs 350
(2026-07-26), lunch Rs 110 x2, TestMerchant Rs 99, 3 boiled eggs and raita
Rs 60, Lays chips Rs 20.

### The statement window (Jan-Jun 2026) - the only real money data

Both imports reconcile: HDFC ••7022 (114 rows, Jan 1 - Jun 30) and Kotak ••1104
(73 rows, Apr 1 - Jun 30), both `audit_confidence = 'proven'` with the running
balance verified across every step.

| | rows | Rs |
|---|---|---|
| Gross outflow (every row that reduced a balance) | 129 | **1,554,304** |
| Real spending (`counts_as_spending`) | 80 | **357,019** |
| Ratio | | **4.35x** |
| Real income | | 683,439 |

The 4.35x gap is made of things that are not spending:

| flow_type | rows | Rs |
|---|---|---|
| investment | 17 | 504,000 |
| loan_principal | 2 | 263,889 |
| self_transfer_out | 4 | 226,978 |
| card_payment | 25 | 201,400 |
| wallet_load | 1 | 1,019 |

**And the composition of the Rs 357,019 that does count matters more:**

| flow_type | rows | Rs | share |
|---|---|---|---|
| p2p_out (money sent to people) | 49 | 183,028 | 51% |
| loan_emi | 5 | 145,285 | 41% |
| **spend (actual merchant purchases)** | **24** | **28,411** | **8%** |
| bank_charge | 2 | 295 | 0.1% |

Six months of merchant purchases total Rs 28,411. Ninety-two percent of what the
app calls his spending is UPI transfers to other people plus loan EMI.

### Budgets

`budgets` has **0 rows**. No monthly spend cap, no calorie target, no protein
target has ever been saved. Every "target" the app narrates is a code default.

---

## 5. Sleep, steps, water, weight, mood

| | |
|---|---|
| `sleep_sessions` all time | **3 rows** |
| last sleep record | 2026-07-29 (nothing in 9 days) |
| steps | **no table, no rows - not logged** |
| `hydration_logs` in window | 9 of 30 days, 5,250 ml total, 583 ml on the days he logged |
| water target (scaffold) | 3,450 ml/day |
| `body_metrics` weight | **1 row, ever**: 84.0 kg on 2026-06-25, 43 days ago |
| `wellness_logs` (mood/energy/stress) | **0 rows, ever** |

The three sleep records are 11.07 h (2026-07-23, from the button), 6.00 h
(2026-07-28) and 6.75 h (2026-07-29). Three points is not a sleep pattern.

One weight reading is not a trend. Any weight-change claim the app makes is
unsupported.

---

## 6. AI runs

| | |
|---|---|
| `ai_runs` all time | 181 |
| status `completed` / `succeeded` | 124 / 57 |
| **rows with a non-null `error_message`** | **0** |
| total estimated cost, all time | **USD 0.5922** |
| `ai_actions` in window | 118 (104 auto_applied, 5 applied, 8 rejected, 1 reverted) |

**A 0% recorded error rate is not a 0% error rate.** Diagnosed to two separate
causes, only one of which was a live defect:

1. **The brain-fallback reason: already fixed, and working.** The
   DeepSeek -> Gemini swap does capture its reason
   (`brainFallbackReason` -> `runInfo.errorMessage` ->
   `ai_runs.error_message`). That code was written *in response to* the 5
   `gemini-fallback` runs of 2026-07-25/26, and those are the last fallbacks that
   have occurred. So the nulls on those 5 rows are historic, not a live bug.
2. **A run that FAILS is not recorded at all. This was the real defect.**
   `persistRunAndActions` is called only on the success path and hardcodes
   `status: "completed"`. The top-level `Deno.serve` catch returned a 500 to the
   client and **wrote nothing**. Every thrown run - provider timeout, unparsable
   JSON, an unreachable function, a failed insert - left no row.

   Proof in the live data: the "6 boiled eggs" capture of 2026-07-24
   (`59eccdfc`) died on `"Failed to send a request to the Edge Function"` and has
   **1 `ai_actions` row and 0 `ai_runs` rows**. And `src/ui/audit-log.js` has
   been branching on `runs.some(r => r.status === "errored")` for a status
   nothing in the codebase could write.

Fixed in section 9.

`agent_tasks`: **0 rows.** `agent_task_runs`: **0 rows.** The self-triggering
agent has never run.

---

## 7. Jarvis / habits - RETRACTED. There is no double-write.

**The first draft of this document was wrong here, and this section is the
correction.** It claimed `habit_days` held "49 rows for 32 distinct days, 17
written twice", that the two copies of 2026-08-07 disagreed
(`workout:true, streak 19` vs `workout:false, streak 1`), that two closeout
briefings 271 ms apart contradicted each other, and that `pg_cron` plus
`.github/workflows/jarvis-heartbeat.yml` were both firing closeout
non-idempotently.

None of it holds. The query behind it was `count(*) - count(distinct day)` with
**no `user_id` in the grouping**. This database has three `profiles` rows.
Re-queried correctly:

| | |
|---|---|
| `habit_days` rows | 49 |
| distinct `(user_id, day)` pairs | **49** |
| true duplicates | **0** |
| distinct users | 3 |

| user | rows | distinct days |
|---|---|---|
| `548339a8…` (the owner) | 32 | 32 |
| `b788d68f…` | 16 | 16 |
| `2f953b03…` | 1 | 1 |

The table has `UNIQUE (user_id, day)`, so a duplicate day for one user is not
even storable. The closeout upsert already uses `onConflict: "user_id,day"` and
`runCloseout` short-circuits on an already-closed day unless forced, which is
exactly the idempotency the heartbeat needs.

### The same false alarm, a second time, on `briefings`

The two closeout rows of 2026-08-07 were re-raised as proof that the double-write
was real and reached `briefings` too. Pulled again **with `user_id` included**,
which is the column whose absence caused the error both times:

| user | body | created_at |
|---|---|---|
| `548339a8…` (the owner) | "Day closed: Rs 0 spent, workout done. Streaks: gym 2d." | 18:35:01.857Z |
| `2f953b03…` (a profile created that day) | "Day closed: Rs 0 spent, no workout." | 18:35:02.128Z |

Two people, not one engine contradicting itself. And `briefings` carries
`UNIQUE (user_id, kind, for_date)`:

| | |
|---|---|
| `briefings` rows | 169 |
| distinct `(user_id, kind, for_date)` | **169** |
| true duplicates | **0** |

The 271 ms gap is the closeout loop walking three profiles inside one
invocation, which is what it is for. **Nothing to deduplicate here either**, and
a dedupe built on the quoted evidence would have deleted another user's
briefing. The `unique(user_id, kind, for_date)` declaration is now asserted in
`tests/briefing.test.mjs` alongside the `habit_days` one.

### What WAS real in those rows: "Rs 0 spent"

Both bodies open with `Rs 0 spent` on a day that had **zero ledger rows**. The
sum of an empty set was printed as a measurement, in the one sentence the owner
actually reads. This file already refuses to do exactly this for sleep - the
comment on `sleepH` says it "used to default to 0, which the voice model then
narrated as the fact 'you got zero sleep' every single day".

Fixed in `lib/jarvis-brief.mjs` (mirrored into the jarvis function via
`scripts/sync-mirror.mjs`):

- `jbCloseDay` now returns `moneyRows`, the ledger row COUNT for the day.
- `jbCloseoutBody` prints **"no spending logged"** when `moneyRows === 0`, and
  drops the `(under cap)` / `(over cap)` verdict with it - there is nothing to be
  under or over.
- The row count, not the sum, is the discriminator: a day of pure income or
  transfers has money rows and a genuine Rs 0 of spending, and still reports
  `Rs 0 spent`.
- `habit_days` rows stored before this field exists have `moneyRows` undefined.
  Those are genuinely unknown and keep the old wording - inventing an absence is
  the same error as inventing a zero.

Locked by four cases in `tests/jarvis-brief.test.mjs`.

**Nothing to deduplicate, no streaks corrupted.** The owner's own series is
continuous and correct - `logging` runs 1 to 19 across 2026-07-20 to 2026-08-07
with no reset, matching the 10 blank days before it (section 2).

What was actually missing is a guard, and that is what was added:
`tests/briefing.test.mjs` now asserts the `unique(user_id, day)` declaration in
`supabase/schema.sql`, the `onConflict: "user_id,day"` upsert key, and the
`existing && !force` short-circuit. Either half alone permits the duplicate this
section wrongly reported, so both are locked.

### Three places absence is being narrated as measurement

1. **`protein_hit` is `false` on all 43 habit rows in the window** and
   `streaks.protein` is 0 throughout - including the day he logged 155.5 g.
   `lib/jarvis-brief.mjs:206` computes it as
   `proteinTarget != null && proteinTarget > 0 && protein >= proteinTarget * 0.9`,
   and `proteinTarget` reads `daily_protein` out of `budgets`, which is empty.
   So `false` there means *no target exists*, and it is being displayed as
   *target missed* - while the morning brief simultaneously announces a 162 g
   target from a different source (the scaffold). Two target paths, one of them
   permanently null.
2. **`under_budget` is `false` on all 43 rows** for exactly the same reason.
3. **"Rs 0 spent"** in the 2026-08-07 closeout. Nothing was logged that day.
   Rs 0 is not a measurement. **Fixed above.**

Items 1 and 2 sit in the CLIENT composer, not here: `lib/jarvis-brief.mjs` reads
targets through `jbBudgetAmount` and correctly yields null rather than a default,
and its `protein_hit` is null when no target exists. Another agent fixed the
client side in `src/analytics/briefing.js` during this round, so the brief now
says "Targets (app defaults, not set by you)". The underlying fact is unchanged:
`budgets` has 0 rows, so he has still never set a target.

---

## 8. Personal notes - where they are saved

Answered in full because the owner asked and could not find out from the app.

| store | rows | span |
|---|---|---|
| `public.notes` | **3** (0 soft-deleted) | 2026-08-01 to 2026-08-04 |
| `public.memory_facts` | **5** | 2026-08-02 to 2026-08-07 |

The three notes:

1. `aspiration` / general / open, 2026-08-01 - *"Will keep a daily journal here,
   logging the day every night before sleeping, from now on."* (One journal
   entry has been written since. This one.)
2. `note` / diet / open, 2026-08-04 - the request that repeated daily foods be
   auto-added to the "Log again" section.
3. `todo` / money / done, 2026-08-04 - set up recurring GST filing reminders,
   `due_on` in the quarter.

The five memory facts: `anniversary` = 4 November (`provenance='typed'`),
`birthday` = 19 October 2002, `daily_foods` = whey + 500 g curd daily and 6
boiled eggs, `gst_filing_deadline`, `nutrition_log_format`. Four of the five
have `provenance = null`, which means they were written before the column
existed - not that their origin is unknown.

### Could he read them back? No.

- `notes` had exactly one surface: the Home additions feed, which renders a note
  as `String(n.body).slice(0, 60)` on one ellipsised line among the meals and
  the expenses (`lib/additions.mjs`). His longest note is 300+ characters, so
  most of it existed only in Postgres.
- `memory_facts` had **no surface at all**. `src/state/sync.js:205` assigns
  `state.memoryFacts` and nothing in the app has ever read that property. Five
  standing facts - the ones replayed into the prompt of every later capture -
  were invisible to the person they describe.
- There is no notes page, no notes panel, no search, and `fetchNotes()` filters
  `status='archived'`, so an archived note is unreadable by any means.

Fixed: `src/ui/notes-panel.js` (new) renders both stores in full on Home, with
provenance stated for every fact. See section 9.

### 11 note candidates, 3 notes: where the other 8 went

`ai_actions` holds 11 `create_note_candidate` rows, all `auto_applied`.

- **8** were removed by `scripts/repair-notes-2026-07-31.mjs` - 5 that restated a
  domain row from the same capture, 2 contradicted by what actually happened
  that day, 1 converted into the `workout_logs` row it should have been. All
  eight are in `audit_log` with a before-image. Correct and accounted for.
- **2 were orphaned - now restored.** The 2026-08-02 Domino's captures wrote note
  rows `f45076ad-1c1d-4308-9256-233f5ef29662` and
  `fac6ab97-cb7f-4d2b-825f-9459deab98f7`; both `ai_actions` still carry
  `applied_record_table='notes'` and those ids. Neither row existed, and there
  was no `audit_log` entry for either. They were the only rows in this database
  that an action claimed to have written and that vanished without a record. The
  two `food_logs` rows from the same capture *were* removed with a proper audit
  entry (`repair-misclassified-2026-08-04`); the notes were not.
- The 11th is accounted for by the three that remained.

### How they vanished without an audit entry

Established from the git history, not guessed.

The additions feed's ✕ calls `deleteRow()` in `src/services/supabase-data.js`.
Soft delete landed in commit `6236125` on **2026-08-06 09:43 IST**. Before that
commit the function body was one line:

```js
await supabase.from(table).delete().eq("id", id).eq("user_id", userId);
```

A hard `DELETE`. No tombstone, no before-image, no audit row - and `notes` is in
`DELETABLE_TABLES`. Anything removed from the feed between 2026-08-02 and
2026-08-06 left exactly the trace these two left: none. The notes were written
2026-08-02 12:01 and the window closes 2026-08-06 09:43.

Two other hard-delete paths were checked and **ruled out**:

- `scripts/capture.mjs --undo` also deletes the `ai_actions`, `ai_runs` and
  `raw_ingestions` rows for the ingestion. All three still exist for `06d9bc20`,
  so it was not used.
- `deleteAllUserData` would have taken the whole account.

**The hole is closed for the app path**: `deleteRow` now writes `deleted_at`,
every read filters it, and the row survives for the 30-day purge. It still does
not write an `audit_log` entry, so a delete is *reversible* but not *recorded* -
listed as open in section 10. `scripts/capture.mjs --undo` remains a hard delete
across nine tables with no audit; it is a developer tool, not an app path, but it
is the same shape of hole.

### Restored

`scripts/restore-orphan-notes-2026-08-08.mjs` rebuilds each missing row from the
tool arguments the action recorded, at its original id, `created_at` and
`occurred_at`, and writes the audit entry that should have existed.

The discriminator matters more than the two rows. **Eight** note rows named by an
`ai_action` are gone; six of them were deliberately removed by
`scripts/repair-notes-2026-07-31.mjs` and every one has an `audit_log` entry with
its full before-image. Restoring those would undo an approved repair and put the
misfiled "no gym today" notes back into the AI's memory context, where they
contradict days he actually trained. So the script keys on **the presence of an
audit trail, not the absence of the row** - a removal that was recorded is a
decision; a removal with no record is the hole. The audit row may name the note
as its `target_id` *or* inside `before->>'id'` (the convert-to-workout case wrote
`target_table='workout_logs'`), so both are checked; keying on `target_id` alone
would have wrongly "rescued" one.

Result, verified live: 2 restored, **0 orphans left**, `notes` now holds **5**
rows, and two `note.restore_orphan` entries are in `audit_log`.

### The misfile trap - checked, and it is not currently active

`docs/AUDIT-2026-07-28-note-misfile.md` documents real content being filed as
`create_note_candidate` at moderate confidence and disappearing from the tracker
it belonged to. Replaying all 11 note candidates against the live tables:

- The historic misfiles (5 "no gym today" style notes, 1 order manifest) were all
  caught and repaired on 2026-07-31.
- None of the 3 surviving notes is a disguised meal, expense or workout. The
  diet-domain one is *about* eating rather than a record of eating, and the
  fabricated 432 kcal meal it once produced was correctly deleted by
  `scripts/repair-meta-note-meal-2026-08-04.mjs`.

`notes` is not currently being used as a dumping ground. The 2026-08-02 orphans
are a different failure - a delete with no audit trail, not a misroute.

---

## 9. What was changed

### Live data (both audit-logged, both reversible)

1. **2 orphaned notes restored** -
   `scripts/restore-orphan-notes-2026-08-08.mjs --apply`. `notes` went 3 -> 5,
   two `note.restore_orphan` entries written, 0 orphans remaining. Detail and the
   cause in section 8.
2. **The 2026-10-19 phantom meal removed** -
   `scripts/repair-future-meal-2026-08-08.mjs --apply`. Soft delete (`deleted_at`),
   full before-image in `audit_log` under
   `food.delete_future_dated_duplicate`, including why a delete replaced the
   planned re-date.

   The script refuses to run unless it can first prove the row it duplicates is
   still present, still on 2026-08-06, and still priced at what
   `lib/food-nutrition.mjs` says - three checks, because deleting the phantom
   without a surviving keeper would lose the meal outright.

   Verified after: **0** food rows dated in the future; 2026-08-06 holds 5 rows /
   1,766 kcal / 153.2 g protein, unchanged, because the phantom was never in that
   day's total. The 30-day window is now 61 rows over 20 days.

   The parser that took a birthday for a meal date was NOT touched - another
   agent owns it.

### Code

1. **`src/ui/notes-panel.js`** (new). A "Notes & memory" panel that renders every
   note in full (kind, domain, date, due date, status, complete body, wrapped)
   and every `memory_facts` row with a plain-English provenance line - "you said
   it (typed)" vs "not from you - text read out of pixels" vs "saved before
   origins were tracked" for the NULLs. It distinguishes four states -
   `loading` / `failed` / `empty` / `ready` - and only prints a count when the
   read actually succeeded, so a dead connection can never render as "0 notes".
   It styles itself and fetches nothing, per the `src/ui` layering rule.
2. **`src/ui/additions-feed.js`** - two lines: import `renderNotesPanel` and
   call it from `renderAdditionsFeed`, before the empty-feed early return. The
   panel mounts itself next to `#additionsFeed`, **so no edit to `index.html` or
   `src/pages/capture.js` was needed.**
3. **`supabase/functions/agent/index.ts`** - **a shared file, edited while two
   other agents were in it.** The change is confined to run/error accounting and
   deletes nothing:
   - two `let` declarations plus a `startedAt` before the `Deno.serve` try, so
     the catch can name who failed;
   - two assignments (`failedUserId = userId`, `failedIngestionId =
     payload.ingestionId`) at the points those values are first known;
   - an `ai_runs` insert inside the top-level catch with `status: "errored"`,
     `error_message`, `estimated_cost_usd: 0` and the measured latency.

   `estimated_cost_usd: 0` is deliberate: a run that threw is not billed by this
   function, and 0 keeps an errored row out of the daily cost cap. It does count
   toward the 5-minute rate limit, which is the safe direction - a client
   retrying into a broken pipeline should be slowed, not given free attempts.
   The insert is wrapped in its own `try`/`catch {}` so a logging failure can
   never replace the real error, and the 500 response is unchanged.

   `node scripts/typecheck-edge.mjs` passes: 3 functions, 0 new errors.
   **This lands the moment the function is deployed, and another agent is
   deploying both edge functions.**
4. **`tests/notes-memory.test.mjs`** - five new blocks covering full-body
   retention, ordering, the four-state absence rule (an unsynced or failed read
   must not print a count), provenance tone for owner/untrusted/derived/NULL, and
   the closed provenance set.
5. **`lib/jarvis-brief.mjs`** - `moneyRows` on the day object and the
   "no spending logged" wording (section 7). Mirrored into
   `supabase/functions/jarvis/index.ts` with `node scripts/sync-mirror.mjs`
   (466 lines, 1 block); `tests/mirror-parity.test.mjs` passes.
6. **`tests/briefing.test.mjs`** - the `habit_days` one-row-per-user-per-day
   invariant AND the `briefings` `unique(user_id, kind, for_date)` invariant
   (section 7), written because a wrong reading of those two tables sent this
   audit down the same false trail twice. Appended after the target-source blocks
   another agent added, not over them.
7. **`tests/jarvis-brief.test.mjs`** - four cases separating "no money rows" from
   "measured Rs 0", including the legacy-row case that must keep the old wording.
8. **`tests/ai-run-accounting.test.mjs`** - asserts the top-level catch writes an
   `ai_runs` row with `status: "errored"`, carries the message, prices it at 0,
   captures the ids outside the try, wraps the logging insert, and still returns
   the 500.

All of these test files are already in the `npm test` chain.

Verified: `notes-memory`, `briefing`, `ai-run-accounting`, `additions-feed`,
`architecture`, `ui-contract`, `layout-contract`, `interaction-contract`,
`navigation`, `audit-log`, `provenance` all pass; `scripts/typecheck-edge.mjs`
passes; `node scripts/smoke-ui.mjs` renders the panel on the signed-in Home page
with no horizontal overflow at 320/360/390/414 px.

`tests/no-swallowed-errors.test.mjs` fails on a stale allowlist entry for
`src/services/speech.js` and `src/ui/capture-panel.js` - files with large
uncommitted edits from the concurrent voice work. Not caused by, and not fixable
from, this change.

---

## 10. Open, not fixed here

| finding | why not fixed |
|---|---|
| The date parser that read a birthday as a meal date | another agent owns that code path and is adding the regression test |
| `deleteRow` tombstones but writes no `audit_log` entry - a delete is reversible but still not recorded | `src/services/supabase-data.js`, not this agent's files |
| `scripts/capture.mjs --undo` hard-deletes across nine tables with no audit | developer tool, but the same shape of hole that lost the two notes |
| One 2026-07-24 food row has `protein_g = null`, so that day's 45.4 g is a partial sum | `food_logs` is owned by other work |
| `protein_hit` / `under_budget` permanently `false` because `budgets` is empty, while the morning brief announces a 162 g target from the scaffold | the honest fix is to save a real target, not to change the flag; `budgets` has 0 rows |
| Archived notes unreadable (`fetchNotes` filters `status='archived'`) | `src/services/supabase-data.js`, not this agent's files |
| No bank data since 2026-06-29 - the money picture is 38 days stale | needs a statement import, not a code change |

### Closed this round

| finding | how |
|---|---|
| 2 orphaned note rows deleted without an audit entry | restored, audit-logged, cause traced to the pre-2026-08-06 hard `deleteRow` |
| Food row dated 2026-10-19 | removed as a duplicate re-send, audit-logged; 0 future-dated food rows remain |
| `habit_days` "double-write" | **retracted** - the finding was a query bug, invariant now locked by a test |
| `ai_runs` never records a failure | top-level catch now writes a `status='errored'` row with the reason |
