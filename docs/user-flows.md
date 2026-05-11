# User Flows and Feature Map

This product is a capture-first life OS. The user should never have to decide which database table they are touching. They should throw messy life data into the app, then trust the system to sort, dedupe, and summarize it.

## Universal Capture Flows

1. Quick text capture: user opens the link, types one messy note, taps Process, and the agent splits it into expense, food, workout, wellness, and reminder candidates.
2. Voice dump: user holds voice, speaks naturally in Hinglish/English, and the agent transcribes, segments, parses, dedupes, and writes high-confidence items.
3. Multi-image dump: user selects 3 to 50 screenshots at end of day, and the media router groups them by likely domain before extraction.
4. File dump: user uploads CSV, XLS, XLSX, PDF, TXT, or exported bank statement, and the import pipeline creates an import job with row previews.
5. WhatsApp/Notes screenshot: user uploads a screenshot of messy notes, and OCR extracts lines before DeepSeek parses them as events.
6. Mixed dump: user uploads a voice note plus payment screenshots plus food photos, and the agent links records that likely refer to the same event.
7. Paste dump: user pastes an entire day from Notes/WhatsApp, including bullets, dates, amounts, food, mood, and random reminders.
8. Delayed capture: user says "yesterday" or "last Friday", and the agent normalizes dates using user timezone.
9. No-category capture: user enters raw facts without choosing category; AI routes it.
10. Review later capture: user is busy, taps Save raw, and the agent processes it in the background.

## Money Tracker Flows

1. Real-time expense: "paid 240 zomato" creates a food delivery expense with today as date.
2. UPI screenshot: user uploads a PhonePe/GPay/Paytm screenshot; AI extracts amount, merchant, timestamp, account, UPI ref, and confidence.
3. Bank SMS screenshot: AI extracts debit/credit, amount, account suffix, merchant, and available balance if visible.
4. Bank statement import: user uploads month-end CSV/XLS/PDF from any bank; AI maps columns, detects credits/debits, categories, transfers, fees, and duplicate rows.
5. Credit card statement: AI parses statement rows, statement cycle, due date, total due, minimum due, interest/fees, and merchant rows.
6. Wallet export: AI handles Paytm/Amazon Pay/UPI wallet exports with inconsistent columns.
7. Cash expense: "gave 100 cash to guard" creates a cash transaction and marks payment mode cash.
8. Split bill: "dinner 1800, Rahul owes 900" creates expense plus receivable.
9. Reimbursement: "office reimbursed 1200" links income/credit to original expense if likely.
10. Refund: refund credits are matched against prior merchant/amount/date records.
11. Transfer detection: bank-to-bank transfers are excluded from spend and marked internal transfer.
12. ATM withdrawal: counted as cash movement, not expense, until cash is spent.
13. Subscription detection: recurring merchants get grouped and forecasted.
14. Budget setup: user sets monthly category budgets and daily safe-spend pace.
15. Budget alert: agent flags "food delivery is 72% of monthly budget by day 11".
16. Merchant cleanup: AI suggests merging "Zomato", "ZOMATO LTD", and "Zomato UPI".
17. Category memory: user recategorizes once, and future merchant matches inherit that preference.
18. Duplicate review: same UPI screenshot plus bank import row are linked as duplicates, one canonical row survives.
19. Suspicious row: impossible dates, negative amounts, missing merchant, or huge spend go to review.
20. Money search: "show fuel spends last month" returns table plus chart.

## End-of-Month Import Flow

1. User uploads bank file.
2. App creates an `import_job` and stores raw file.
3. Parser tries deterministic extraction: CSV/XLS columns, PDF text, or OCR if scanned.
4. AI maps unknown columns to date, description, debit, credit, balance, ref, mode, and account.
5. User sees a preview with row counts, credits, debits, likely transfers, likely duplicates, and unknowns.
6. User taps Import.
7. System creates `statement_rows`.
8. Dedupe engine links rows to existing expenses from screenshots/text/voice.
9. High-confidence new expenses are written.
10. Ambiguous rows stay in review.
11. Import memory stores bank format mapping for next month.
12. Dashboard updates month-over-month, category mix, subscription drift, and cashflow.

## Diet Flows

1. Food photo now: user uploads a plate photo; Gemini estimates visible items and portions; DeepSeek turns them into food log candidates.
2. Missed photo: user says "lunch was 3 rotis, dal, rice, curd"; AI estimates macros with confidence.
3. EOD diet voice: user summarizes the full day and the agent splits breakfast/lunch/snacks/dinner.
4. Home food defaults: Indian portions, rotis, dal, sabzi, rice, curd, paneer, eggs, chicken, chai, snacks.
5. Restaurant meal: user uploads bill/photo or says restaurant name; AI estimates likely calories and protein.
6. Packaged food: user uploads label; OCR captures serving size, calories, protein, carbs, fat.
7. Duplicate meal: food photo at 2pm and voice "lunch was dal rice" are flagged as same meal.
8. Protein gap: dashboard shows grams remaining and suggests practical options.
9. Calorie budget: daily target, current estimate, and likely range because food estimation is fuzzy.
10. Habit scoring: breakfast quality, protein consistency, late-night snacking, hydration, and meal timing.
11. Travel mode: looser estimates, restaurant-heavy assumptions, and no shame streak handling.
12. Cheat meal handling: record it, learn from it, avoid moral language.
13. Meal templates: user saves common meals like "home lunch" and reuses quickly.
14. Grocery assist: user uploads grocery bill, AI tags food inventory and diet-supportive items.
15. Weight link: food adherence is compared with weight trend, not single-day noise.

## Fitness and Wellness Flows

1. Steps capture: user types or screenshots step count; AI logs steps.
2. Workout note: "push day 45 min, bench 50x8" creates workout summary.
3. Weight log: "82.4 morning" records body weight with timing.
4. Sleep log: user types hours or imports screenshot from health app.
5. Mood note: "felt anxious after lunch" records wellness note with low confidence for cause.
6. Energy scoring: sleep, protein, steps, mood, and caffeine feed a daily score.
7. Injury note: user records pain or soreness; app surfaces trend if repeated.
8. Medication/supplement note: optional private log, never medical advice.
9. Habit check-in: simple yes/no/partial habits for water, steps, protein, sleep, workout.
10. Weekly reflection: AI summarizes what helped and what hurt.

## Dashboard and Insights

1. Always-available AI overview: one short daily summary, risks, wins, and next actions.
2. Hard data dashboard: charts and tables with exact filters.
3. DOD view: today vs yesterday for spend, calories, protein, steps, sleep, habit score.
4. WOW view: week vs previous week, trend direction, adherence, category movement.
5. MOM view: month vs previous month, budgets, cashflow, subscriptions, weight trajectory.
6. Trajectory view: rolling averages, forecast to month end, deficit/surplus pace.
7. Budget page: category budget, daily pace, projected overrun, safe-spend remaining.
8. Diet page: calories, protein, meal timing, missed meals, common weak spots.
9. Money page: merchant/category/payment-mode breakdown.
10. Duplicate center: rows grouped by duplicate cluster with keep/delete/merge.
11. Import center: current and historical imports, errors, preview, reprocess.
12. Cost meter: Gemini, DeepSeek, Supabase usage estimate by day/month/user.
13. Habit score: weighted score from user-selected goals.
14. Streaks with forgiveness: streaks are motivational, not punitive.
15. Search: natural language and filter search across all records.

## Quality-of-Life Features

1. One-tap common entries: chai, fuel, zomato, home lunch, eggs, gym, walk.
2. Smart defaults: date today, currency INR, timezone Asia/Kolkata, user-specific categories.
3. Merchant memory: recategorization teaches future rows.
4. Food memory: repeated meals become fast templates.
5. Offline queue: capture should work even if network is weak, then sync later.
6. Undo stack: every AI write can be undone.
7. Reprocess button: rerun extraction with a newer model or higher resolution.
8. Confidence labels: high, medium, low, needs user.
9. Raw evidence link: every AI row links back to image, file, text, or voice source.
10. Bulk actions: approve all high-confidence, delete all duplicate losers, recategorize selected.
11. Safe autopilot: AI can create but not permanently delete.
12. Privacy mode: hide amounts/weight on screen when showing someone.
13. Friend-ready accounts: each user has their own rows, budgets, goals, and files.
14. Admin invite later: Ubhay can invite up to personal community users.
15. Data export: CSV/JSON export for all user records.
