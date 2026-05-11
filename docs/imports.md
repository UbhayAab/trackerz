# Statement and File Imports

The app must accept ugly month-end files because users will download statements from different banks and apps. We cannot hardcode one bank format.

## Supported Inputs

- CSV
- XLS
- XLSX
- PDF with selectable text
- Scanned PDF or image statement
- TXT export
- Screenshot batches
- Zip later, not MVP

## Import Pipeline

1. Upload file to Supabase Storage.
2. Create `import_jobs` row.
3. Detect file type and parser path.
4. Extract raw tables/text deterministically when possible.
5. Use OCR for scanned documents.
6. Use DeepSeek to map columns and normalize rows.
7. Create preview: total rows, debit total, credit total, date range, account hints, duplicate estimate.
8. User approves import.
9. Create `statement_rows`.
10. Convert eligible rows into ledger candidates.
11. Run dedupe against existing ledger entries.
12. Apply high-confidence writes.
13. Send ambiguous rows to inbox.
14. Save mapping memory by bank/source fingerprint.

## Column Mapping Strategy

Common candidates:

- Date: date, transaction date, value date, txn date, posted date.
- Description: narration, particulars, merchant, details, transaction remarks.
- Debit: withdrawal, paid out, debit, dr, amount debited.
- Credit: deposit, paid in, credit, cr, amount credited.
- Amount: signed amount, transaction amount.
- Balance: closing balance, running balance, available balance.
- Reference: UTR, UPI ref, transaction id, cheque no.

AI receives extracted rows plus metadata and must return a mapping object, not final database writes. Backend validates the mapping before row creation.

## Import Quality Checks

- Date range sanity.
- Duplicate row hash.
- Debit/credit signs.
- Balance arithmetic when possible.
- Header/footer removal.
- Total mismatch warnings.
- Empty merchant warnings.
- Currency mismatch.
- Internal transfer detection.
- Cash withdrawal handling.
- Reversal/refund matching.

## User Experience

- User can import without knowing bank format.
- Preview must be understandable on phone.
- User can approve all, approve selected, or keep as review.
- User can teach the app column mapping once.
- User can undo entire import.
- User can reprocess an import after model/schema changes.
