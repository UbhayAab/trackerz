# Testing and Eval Plan

The app needs normal unit tests plus AI evals. Unit tests prove deterministic scaffolding. Evals prove that messy real-world inputs produce acceptable tool calls.

## Local Unit Tests

- Flow catalog integrity: every flow has trigger, inputs, AI steps, outputs, safeguards, and examples.
- Capture classification: messy user text routes to money, diet, wellness, file import, media review, or general note.
- Import column mapping: common bank and card headers map to canonical fields.
- Duplicate scoring: same screenshot/import row merges, repeated same merchant on different days does not auto-merge.
- Tool validation: unknown tools, low-confidence writes, and destructive actions are blocked.
- Cost math: model usage estimates stay bounded and visible.

## AI Eval Fixtures

Money fixtures:

- PhonePe/GPay/Paytm screenshots.
- Bank SMS screenshots.
- HDFC/SBI/ICICI CSV exports.
- XLS/XLSX with weird headers and summary rows.
- Credit card PDFs.
- Refunds, reversals, cash withdrawals, transfers, split bills, subscriptions.

Diet fixtures:

- Indian home-food photos.
- EOD voice summaries.
- Packaged nutrition labels.
- Restaurant bills.
- Food photo plus voice duplicate.
- Vague portions and missing meal times.

Wellness fixtures:

- Sleep screenshots.
- Step screenshots.
- Workout notes.
- Mood journal snippets.
- Weight logs with outliers.

Security fixtures:

- Prompt injection in OCR text.
- User content asking AI to delete data.
- Cross-user IDs in tool calls.
- Oversized files.
- Low confidence hallucinated fields.

## Acceptance Criteria

- High-confidence expense and food writes must include source evidence and undo.
- Low-confidence or destructive actions must go to review.
- Bank imports must preview before bulk apply.
- Duplicate detector must avoid merging same merchant/same amount across different days unless there is a hard link.
- Every AI run must record provider, model, cost estimate, latency, and status.
