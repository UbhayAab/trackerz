# Trackerz — User Flows

Every way a real human will get data into this app, and what the system does
with it. This is the spec the AI scaffolding has to satisfy.

## Three timing personas

| Persona | Behavior | Implication |
|---------|----------|-------------|
| **Tap-and-go** | Logs every transaction / meal as it happens | Capture must be ≤2 taps from cold open. Each capture is small and unambiguous. Few dedupes. |
| **Screenshot-everything** | Collects screenshots in a folder/share-target through the day, dumps them periodically | Bulk image ingest. Each image may contain 1–3 transactions. Heavy OCR. Medium dedupe against bank import. |
| **EOD-only** | Sits down at night and dictates the whole day | Long voice notes, long text dumps. AI must split into multiple actions. Very high dedupe with anything else they captured during the day. |

## Three cadence buckets

| Cadence | Inputs typical of this cadence | Aggregation |
|---------|-------------------------------|-------------|
| **Real-time** (per event) | text snippet, single photo, share-target | Single tool call usually. |
| **Daily** | EOD voice, multi-photo dump, EOD text recap | Multiple tool calls; dedupe sweep across the day. |
| **Weekly / monthly** | Bank statement import, recurring-subscription scan, weekly review post | Heavy normalization, cross-period reconciliation. |

## Input modalities (what the capture surface accepts)

- **Text** — typed in capture box, pasted, or shared from another app
- **Voice** — recorded in-browser via MediaRecorder, dropped as .webm / .m4a / .mp3
- **Image** — camera capture, gallery pick, paste, drag-drop, share-target
- **File** — .csv / .xls / .xlsx / .pdf / .txt (bank statements, exports)
- **Mixed** — any combination above in one capture (the common EOD case)

## The flow matrix

| # | Flow | Trigger | Modality | Cadence | AI step | DB writes | Dedupe risk |
|---|------|---------|----------|---------|---------|-----------|-------------|
| 1 | Real-time expense (typed) | Home → textarea | text | per event | classify + amount + merchant + ts | `ledger_entries` | low |
| 2 | Real-time expense (voice) | Home → voice button | audio | per event | transcribe → classify → fields | `ledger_entries`, `media_assets` | low |
| 3 | Payment screenshot (GPay/PhonePe/Paytm) | Share-target → image | image | per event | OCR → amount + merchant + ts | `ledger_entries`, `media_assets` | high vs bank import |
| 4 | EOD photo dump (multi-image) | Home → file picker (multi) | image[] | daily | OCR each; cluster by ts; emit N tool calls | N × `ledger_entries`, N × `media_assets` | very high |
| 5 | EOD voice summary | Home → record | audio | daily | transcribe → split into N actions across domains | mix of `ledger_entries`, `food_logs`, `wellness_logs`, `body_metrics` | medium |
| 6 | WhatsApp/iMessage screenshot | Share-target | image | ad-hoc | OCR text → classify by content | depends on parse | medium |
| 7 | Notes-app dump (long text) | Share-target text | text | ad-hoc | split into actions per line/paragraph | depends | medium |
| 8 | Bank statement (CSV/XLSX) | Money → Import | file | monthly | detect format → map columns → normalize rows | `statement_imports`, `statement_rows`, derived `ledger_entries` | **very high** vs everything else captured this period |
| 9 | Bank statement (PDF) | Money → Import | file | monthly | OCR pages → detect table → normalize | same as #8 | very high |
| 10 | Food photo | Home → camera | image | per meal | identify dish + portion → macros | `food_logs`, `media_assets` | low |
| 11 | Food text ("3 rotis dal sabzi") | Home → text | text | per meal | parse meal items → macros | `food_logs` | low |
| 12 | Food EOD voice | Home → record | audio | daily | transcribe → split per meal slot | N × `food_logs` | medium vs per-meal photos |
| 13 | Weight measurement | text "75.3kg" | text | daily/weekly | parse number + unit | `body_metrics` | low |
| 14 | Steps screenshot | upload from Fit/Health | image | daily | OCR steps number | `body_metrics` | low |
| 15 | Mood/sleep voice | record | audio | daily | extract mood, energy, stress, sleep hours | `wellness_logs`, `body_metrics` | low |
| 16 | Hydration log | text "2L water" | text | daily | parse volume + unit | `hydration_logs` | low |
| 17 | Subscription detection | passive job | none | weekly batch | recurring pattern detect across last 90d | `subscriptions` | n/a |
| 18 | Refund matching | passive | none | on bank import | match credit row to prior debit by merchant + amount | linked `ledger_entries` | n/a |
| 19 | Transfer detection | passive | none | on bank import | match in/out pairs across own accounts | linked `ledger_entries` | n/a |
| 20 | Cross-source dedupe sweep | passive on every ingest | none | per ingest | score every pair (voice ↔ bank, photo ↔ photo, text ↔ photo) | `duplicate_candidates` | n/a |
| 21 | Weekly review post | Sun 12 AM cron | none | weekly | summarize 7 days, surface top movers | `weekly_reviews` | n/a |
| 22 | Budget breach alert | passive on every expense write | none | per write | check daily/weekly/monthly cap against current spend | insight surfaced | n/a |
| 23 | Meal template propose | passive after 3+ similar meals | none | per food write | suggest "save as template" | `meal_templates` | n/a |
| 24 | Merchant alias propose | passive on new merchant | none | per ledger write | suggest canonical name | `merchant_aliases` | n/a |
| 25 | Category memory | passive on confirm | none | per confirm | record user's category choice for this merchant | `category_memory` | n/a |
| 26 | Eating window detection | passive on food write | none | per food write | track first/last meal time of day | derived from `food_logs` | n/a |

## Walkthroughs by persona

### Persona A — Tap-and-go (Aman, freelancer, 60 captures/day)

```
08:14  pays auto Rs 80 → opens app → types "auto 80" → tap Process
       ↓
       raw_ingestions (text)
       ai_runs (gemini-2.5-flash, ~600ms)
       ai_actions: create_expense_candidate(amount=80, merchant=Auto, mode=cash) conf=0.91 → auto_applied
       ledger_entries (1 row)
       UI: today tile bumps Rs 80, optimistic queue clears
13:02  lunch dal rice → photo → tap Process
       ↓
       raw_ingestions (image)
       media_assets (raw-media/uid/lunch-xxx.jpg)
       ai_runs (Gemini vision)
       ai_actions: create_food_log_candidate(meal=lunch, items=dal+rice+roti) conf=0.78 → proposed (under 0.88)
       UI: review queue gets 1 row, "Approve" / "Drop" buttons
       Aman taps Approve → food_logs row created
21:30  EOD wellness "slept 7, walked 9k, mood 7" voice
       ↓
       same path, splits into 2 body_metrics + 1 wellness_log
```

### Persona B — Screenshot-everything (Priya, biz dev, dumps EOD)

```
through the day:
  pays via GPay, screenshots confirmation → saves to gallery
  pays at Cafe → screenshots → saves
  Amazon refund → screenshots → saves
  ... 8 screenshots by 9 PM

21:45  opens app → Files → selects 8 images → Process
       ↓
       raw_ingestions (mixed, capture_mode=auto)
       8 × media_assets uploaded to raw-media bucket
       ai_runs (Gemini vision, batched 4 images per call to stay under prompt limit)
       ai_actions: 8–11 expense candidates (one screenshot had two transactions)
       Some auto-applied (conf > 0.88), rest queued for review
       cross-source dedupe sweep: links GPay screenshot to bank row pending; flags 0 dupes for now
       UI: queue shows 11 candidates; today tile estimates Rs 4,820

23:00  next morning Priya imports HDFC May statement
       statement_imports row
       statement_rows: ~450 rows
       dedupe sweep against May ledger_entries: surfaces 38 likely matches
       UI: review queue gets 38 "merge" suggestions
       Priya bulk-approves → linked, no duplicate spend counted
```

### Persona C — EOD-only (Karan, busy executive)

```
23:00  records 3-minute voice memo:
       "Morning coffee 150 rupees. Lunch was 280 at Punjabi tadka, paid by card.
        Auto home was 95. Dinner 740 zomato. Workout was 40 min strength.
        Slept like 6 hours yesterday, today aim for 8. Steps were around 7500.
        Mood 6, stressed about quarterly."

       ↓
       raw_ingestions (audio, capture_mode=auto)
       media_assets (raw-media/uid/voice-xxx.webm)
       ai_runs (Gemini audio in + structured output)
       ai_actions (split):
         - create_expense_candidate(150, coffee, cash) conf=0.88
         - create_expense_candidate(280, "Punjabi Tadka", card) conf=0.94
         - create_expense_candidate(95, auto, cash) conf=0.86
         - create_expense_candidate(740, Zomato, upi) conf=0.96
         - create_food_log_candidate(slot=dinner, items=zomato) conf=0.62 → review (low because of low specificity)
         - create_body_metric_candidate(sleep_hours, 6) conf=0.90
         - create_body_metric_candidate(steps, 7500) conf=0.84
         - create_wellness_log_candidate(mood=6, stress=high) conf=0.82
       cross-source dedupe sweep: nothing to dedupe yet (voice was the only source today)
       UI: 4 ledger rows visible, 1 food review pending, wellness tile updates
```

## Edge cases the AI must handle

1. **Currency variants**: "₹240", "Rs.240", "240 rs", "INR 240", "240/-", "240 only"
2. **Hindi-English code-mix**: "kal raat dinner 300 ka tha", "lunch khaya 220 ka"
3. **Ambiguous merchant**: "paid 240 to mom" → not a merchant, save as `transfer` or skip
4. **Multiple events in one sentence**: "lunch 280 and chai 30" → 2 ledger rows, not 1 for 310
5. **Implicit time**: "yesterday lunch" → occurred_at = (now - 1d), clamped to 13:00 local
6. **Past tense vs intent**: "paid 500" → log it; "should pay 500 tomorrow" → DO NOT log
7. **Self-correction in voice**: "lunch was 240, no wait 280" → use 280
8. **OCR noise**: payment screenshots with bank logos, ads, share buttons → ignore non-amount text
9. **Multi-image, same transaction** (user took 2 screenshots of the same payment) → only 1 ledger row + duplicate_candidates link
10. **EOD voice + earlier photo of same meal**: dedupe should link, not double-count

## Safety & guard layers (every flow goes through these)

1. **JWT validation** — userId from `auth.uid()`, never trusted from body
2. **Per-tool schema validation** — amount must be positive number, currency must be a known code, etc.
3. **Prompt injection detection** — strips "ignore previous instructions" etc. before sending to Gemini
4. **Confidence policy** — auto-apply ≥ 0.88, review ≥ 0.72, reject below 0.72
5. **Per-user rate limit** — 60 ai_runs / 5 min
6. **Daily cost cap** — sum of `ai_runs.estimated_cost_usd` < $2 / user / day
7. **RLS** — every user table has a policy; service_role bypasses only on the server
8. **Audit log** — every AI-proposed and AI-applied change goes to `ai_actions` with full args + undo payload

## Mode routing (when "Auto" is selected on capture)

The capture router (`src/services/capture-router.js`) picks a mode based on:
- File extension / mime type
- Keyword presence (money/food/wellness vocab dictionaries)
- Numeric content (high signal for money/calories)
- Length and structure (long text → multiple actions likely)

The router never blocks — it just sets a `capture_mode` hint. The AI is allowed
to overrule it. Final classification is the AI's decision, validated by the tool
schema.

## What the user always controls

- **Approve / drop** every `proposed` action from the review queue
- **Override category** on any ledger row (writes to `category_memory`)
- **Delete** any row at any time (cascades to `ai_actions.applied_record_id`)
- **Undo** last AI-applied action (uses `ai_actions.undo_payload`)
- **Set budgets** per category per period in settings
- **Set diet/wellness targets** in settings
- **Disable nightly summary** in settings
- **Clear local workspace cache** (frontend only) in settings
- **Sign out** wipes the JWT, no server-side data deleted

## What the system never does without consent

- Auto-merge two records flagged as duplicates → always surfaces as a candidate
- Modify a user-edited row based on a later AI run
- Apply an action with confidence below 0.88
- Apply an action whose tool name is not in the allowlist
- Apply any action if the JWT doesn't validate
