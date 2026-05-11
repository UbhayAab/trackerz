# AI Scaffolding

DeepSeek v4 Pro is the main brain. Gemini is the media interpreter. Supabase is the only layer allowed to write persistent data.

## Model Routing

- Text-only capture: DeepSeek v4 Pro through the NVIDIA/OpenAI-compatible endpoint.
- Image capture: Gemini 3.1 Flash-Lite first, with `MEDIA_RESOLUTION_HIGH` only when needed.
- Audio capture: Gemini 3.1 Flash-Lite or browser speech-to-text first, then DeepSeek for structure.
- Hard import mapping: DeepSeek v4 Pro, with deterministic parser output as input.
- Hard visual fallback: Gemini 3 Flash or 3.1 Pro only for blurry, dense, or repeatedly failed media.

## Key Handling

- Frontend stores no model keys.
- Supabase publishable key may be in browser code after RLS is enabled.
- DeepSeek, Gemini, NVIDIA, Supabase service-role, and database passwords live only in Supabase Edge Function secrets.
- Test keys can be used locally, but must never be committed.
- Every AI call records provider, model, tokens, estimated cost, latency, source, and result status.

## Agent Pipeline

1. Store raw text/file/media in `raw_ingestions`.
2. Store uploaded binary in Supabase Storage and `media_assets`.
3. Classify input type: text, image, audio, statement, mixed.
4. Extract text/vision transcript.
5. Ask DeepSeek to produce tool calls only.
6. Validate tool arguments with strict schemas.
7. Run duplicate detection.
8. Execute allowed writes through backend functions.
9. Write `ai_actions`, audit records, and undo metadata.
10. Return inbox cards and dashboard deltas.

## Tool Catalog

- `create_expense_candidate`
- `create_income_candidate`
- `create_transfer_candidate`
- `create_statement_row_candidate`
- `create_food_log_candidate`
- `estimate_food_macros`
- `create_workout_log_candidate`
- `create_body_metric_candidate`
- `create_wellness_note_candidate`
- `create_budget_candidate`
- `create_habit_event_candidate`
- `link_duplicate_candidates`
- `merge_duplicate_cluster`
- `request_user_review`
- `apply_verified_action`
- `undo_ai_action`
- `reprocess_ingestion`
- `set_user_memory`

## Autopilot Policy

- AI may auto-create high-confidence expenses, food logs, and simple habit events.
- AI may not hard-delete records.
- AI may mark duplicates and suggest merge/delete.
- AI may update categories and food templates when confidence is high or user memory exists.
- AI must request review for large transactions, unclear dates, low-confidence OCR, medical-like claims, destructive changes, and cross-user data.

## Duplicate Detection

Signals:

- Amount, merchant, timestamp, account suffix, UPI ref, and import row hash for money.
- Meal time, source image timestamp, described foods, and macro estimate range for diet.
- Same raw ingestion referenced by multiple parsed candidates.
- Similar text embeddings or normalized descriptions.
- User feedback from previous merges.

States:

- `unique`
- `possible_duplicate`
- `duplicate_winner`
- `duplicate_loser`
- `needs_review`

## Cost Calculator Assumptions

- Gemini 3.1 Flash-Lite image/video input: $0.25 per 1M tokens.
- Gemini 3.1 Flash-Lite audio input: $0.50 per 1M tokens.
- Gemini 3.1 Flash-Lite output: $1.50 per 1M tokens.
- Gemini 3 image high/default: about 1120 tokens per image.
- Audio: about 32 tokens per second.
- DeepSeek v4 Pro promotional direct price is cheaper than regular NVIDIA public estimates, but app should support provider-specific pricing.
- The dashboard must show real usage from API responses when available, and fallback estimates otherwise.

## Test Matrix

Money:

- UPI screenshots from GPay, PhonePe, Paytm, bank apps.
- Bank CSV with debit/credit separate.
- Bank CSV with signed amount.
- Excel with merged headers and extra summary rows.
- Credit card PDF statement.
- Refund matching.
- Split bill.
- Transfer detection.
- Duplicate screenshot plus bank import.
- Prompt injection hidden inside screenshot text.

Diet:

- Food photo with clear plate.
- Food photo with multiple plates.
- Voice-only EOD summary.
- Food photo plus voice duplicate.
- Packaged nutrition label.
- Indian home meal with vague portions.
- Restaurant meal with no exact macros.
- Missed date and "yesterday" correction.

Wellness:

- Sleep screenshot.
- Step count screenshot.
- Mood note mixed with money and food.
- Workout note with sets/reps.
- Body weight trend with outlier.

Agent:

- Tool-call schema compliance.
- Timeout and retry.
- Model fallback.
- Cost recording.
- Undo correctness.
- RLS isolation.
- Audit completeness.
- Malicious instruction in user content.
