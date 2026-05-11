# Feature Atlas

This is the expanding product map. The MVP should not build everything at once, but the architecture should not block any of these flows.

## Capture Quality

- Home screen is always capture-first.
- Text, image, audio, file, and mixed capture share the same ingestion pipeline.
- Capture can be saved raw if AI is offline.
- User can tag capture as money, food, workout, wellness, or auto.
- EOD mode accepts multi-image plus voice plus notes together.
- Month-end mode accepts bank files and creates import previews.
- Camera mode later can scan receipt or food directly.
- Browser share target later can receive screenshots from Android share sheet or iOS share sheet.
- WhatsApp-forward mode later can parse exported chat snippets.
- Email-forward mode later can parse bank emails or receipts.

## Money Intelligence

- Category budgets, merchant budgets, and total monthly budget.
- Safe-spend daily pace.
- Subscription detection and renewal calendar.
- Refund matching.
- Reimbursement tracking.
- Borrow/lend tracking.
- Cash withdrawal and cash-spend reconciliation.
- Internal transfer exclusion.
- Credit card due-date and statement-cycle tracking.
- Merchant aliases and cleanup.
- Category memory from user corrections.
- Expense anomaly detection.
- Price drift for repeated merchants.
- Weekend vs weekday spend.
- Needs vs wants tagging.
- Food delivery leakage.
- Fuel trend.
- EMI/loan detection.
- Tax/business flag later.
- Shared expense settlement later.

## Diet Intelligence

- Calories, protein, carbs, fat, and confidence range.
- Indian home-food portion memory.
- Repeated meal templates.
- Protein gap suggestions.
- Calorie pace by time of day.
- Late-night snack detection.
- Eating-window timeline.
- Restaurant mode.
- Packaged label OCR.
- Grocery-to-meal memory later.
- Weight trend correlation.
- Adherence score.
- Cheat meal without shame.
- Meal prep suggestions later.
- Hydration tracking.
- Caffeine timing.

## Fitness and Wellness

- Steps, sleep, weight, workouts, mood, energy, stress.
- Body-weight rolling average.
- Workout frequency and muscle group balance.
- Sleep debt.
- Mood triggers from notes.
- Habit score by selected goals.
- Recovery score later.
- Injury/soreness trend.
- Reflection prompts.
- Weekly life review.
- Gentle alerts when patterns worsen.

## Dashboards

- AI overview available on every view.
- Hard data charts with table drilldown.
- Day-over-day, week-over-week, month-over-month.
- Rolling 7/14/30-day averages.
- Forecast to month end.
- Budget burn-down.
- Calorie/protein trajectory.
- Weight trend vs adherence.
- Habit score components.
- Duplicate queue.
- Import health.
- AI cost meter.
- Confidence/error dashboard.
- Search across everything.
- Natural language question answering over personal data.

## AI Safety and Control

- Every action has raw evidence.
- Every action has confidence and model metadata.
- Every write has undo.
- AI cannot hard-delete.
- Low-confidence writes go to review.
- High-confidence writes can autopilot.
- Duplicate clusters are visible.
- User can reprocess an item.
- User can pin a correction as memory.
- User can disable autopilot by domain.
- Spend caps per day/month.
- Prompt-injection tests for screenshots and imported notes.
- RLS tests for every table.

## Community Later

- Invite-only users.
- Each user owns private data.
- Optional shared challenges.
- Optional anonymous leaderboard.
- Optional coach/friend read-only view.
- Optional family budget group.
- Optional shared grocery/meal templates.
- Admin can disable a user or revoke invite.
