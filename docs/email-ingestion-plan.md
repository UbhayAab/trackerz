# Email ingestion — plan & scope

**Goal:** bank / UPI / card alert emails (and anything else worth capturing)
land as captures automatically, without you forwarding or pasting anything.

**Key fact that makes this small:** the agent `SYSTEM_PROMPT` **already** parses
HDFC/UPI/card alerts in detail (see `supabase/functions/agent/index.ts`, the
"HDFC Bank payment alerts" rules). So the pipeline can already turn an alert
email into an expense/income/transfer. The only missing piece is **delivery** —
getting the email's text into a `raw_ingestions` row. Everything downstream
(evidence grounding → salvage → sanity → auto-apply, then cross-source dedupe
against bank-statement imports) already exists.

```
 Gmail alert ──▶ [delivery]  ──▶  email-inbound edge fn  ──▶  raw_ingestions row
 (HDFC/ICICI…)                    · verify shared secret        (source_type=text)
                                  · normalizeEmail() (built)        │
                                  · dedupe on message-id            ▼
                                  · resolve user                 agent pipeline
                                                                 (already parses
                                                                  bank alerts) ──▶ ledger_entries
```

---

## The one decision: how does the email reach us?

| Option | How | Setup cost | Reliability | Verdict |
|--------|-----|-----------|-------------|---------|
| **1. Gmail Apps Script forwarder** ⭐ | A ~30-line Google Apps Script bound to *your* Gmail runs on a 5–15 min time-trigger, searches `from:(hdfcbank OR icicibank …) newer_than:1d`, POSTs each new message to the `email-inbound` edge fn with a shared secret. | Paste a script into script.google.com, set a trigger. No external service, no domain, no OAuth app. | High. Runs as you, uses Gmail search, marks processed with a label. | **Recommended.** Best fit for a single-user personal app. |
| 2. Inbound-parse webhook | A service (Cloudflare Email Routing / SendGrid / Postmark) receives mail at an address you forward to, and POSTs parsed JSON to the edge fn. | Needs a domain + a provider account + a Gmail auto-forward filter. | High, real-time. | Overkill here; more moving parts + a paid-ish dep. |
| 3. Gmail API poll (OAuth) | An edge/cron job polls the Gmail API with a stored refresh token. | Google Cloud project, OAuth consent screen, restricted-scope verification, token refresh. | High, but heaviest. | Most work + Google verification friction. Skip unless you want no Google-side script at all. |

All three feed the **same** `email-inbound` edge function and the **same**
`normalizeEmail()` — so the choice only changes the ~30 lines that deliver the
message, not the app. You can start with Option 1 and swap later.

---

## What gets built (once you pick a delivery)

1. **`lib/email-normalize.mjs`** — ✅ **built + tested this session**
   (`tests/email-normalize.test.mjs`). Pure: `normalizeEmail({from,subject,text,
   html,messageId,receivedAt})` → `{ captureText, dedupeKey, sender, subject }`.
   Strips quoted history + do-not-reply footers, de-tags HTML alerts, and makes
   a stable idempotency key (RFC Message-ID, else sender|subject|day).

2. **`email-inbound` edge function** (`supabase/functions/email-inbound/index.ts`)
   — new. Responsibilities:
   - Auth: `x-email-secret` header checked against `app_secrets.EMAIL_SECRET`
     (same pattern as `NIGHTLY_SECRET`). Deploy with `--no-verify-jwt`.
   - Resolve the target user: single-user app → the sole `profiles.id`, or a
     configured `app_secrets.EMAIL_OWNER_USER_ID`.
   - `normalizeEmail()` the payload; skip if `captureText` is empty.
   - **Idempotency:** insert `dedupeKey` into a new `email_messages` table with a
     unique index; on conflict, return `{skipped:true}` (never double-ingest).
   - Insert a `raw_ingestions` row (`source_type='text'`, `capture_mode='email'`,
     `raw_text=captureText`), then invoke the existing agent pipeline for it
     (reuse `runPipeline`/`persistRunAndActions` — factor the shared bit into
     `_shared/` if cleaner, guarded by a parity test).
   - Return `{ ok, ingestion_id, action_count }`.

3. **Migration** `…_email_messages.sql` — `email_messages (id, user_id,
   dedupe_key unique, sender, subject, ingestion_id, created_at)` + RLS
   (service-role writes; owner reads). Small.

4. **Delivery glue** for the chosen option — for Option 1, the Apps Script
   below.

5. **Policy choice (needs your call):** should parsed **bank** emails
   **auto-apply** (they're high-signal and already dedupe against statement
   imports) or land in **review** first? Default recommendation: auto-apply
   expenses/income exactly like a typed capture (confidence-gated by the
   existing `action-policy`), since cross-source dedupe already catches overlaps
   with statement rows. Reversible via the additions feed.

6. **Tests:** `email-normalize` ✅; add an `email-inbound` contract test (secret
   rejected → 401; dedupe-key replay → skipped; a sample HDFC payload → one
   `create_expense_candidate`). Reuse `tests/capture-cases` style.

---

## Option 1 — the Apps Script (paste into script.google.com once the endpoint exists)

```javascript
// Trackerz email forwarder. Tools → Triggers → add a time-driven trigger (e.g.
// every 15 min). Set ENDPOINT + SECRET. Processes labelled-once, bank senders.
const ENDPOINT = "https://yyoewdcijplkhxleejtm.supabase.co/functions/v1/email-inbound";
const SECRET   = "PASTE_EMAIL_SECRET";               // == app_secrets.EMAIL_SECRET
const QUERY    = 'newer_than:2d -label:trackerz-done (from:hdfcbank.net OR from:icicibank.com OR from:axisbank.com OR subject:(debited OR credited OR "transaction alert"))';

function forwardToTrackerz() {
  const label = GmailApp.getUserLabelByName("trackerz-done") || GmailApp.createLabel("trackerz-done");
  const threads = GmailApp.search(QUERY, 0, 25);
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const payload = {
        from: msg.getFrom(), subject: msg.getSubject(),
        text: msg.getPlainBody(), html: msg.getBody(),
        messageId: msg.getId(), receivedAt: msg.getDate().toISOString(),
      };
      const res = UrlFetchApp.fetch(ENDPOINT, {
        method: "post", contentType: "application/json",
        headers: { "x-email-secret": SECRET },
        payload: JSON.stringify(payload), muteHttpExceptions: true,
      });
      if (res.getResponseCode() >= 300) { Logger.log("skip %s: %s", msg.getId(), res.getContentText()); }
    }
    thread.addLabel(label);   // don't reprocess; the endpoint also dedupes by message-id
  }
}
```

Belt-and-suspenders: the Gmail label prevents re-sending, and the endpoint's
`email_messages` unique key prevents double-ingest even if the label step fails.

---

## Security notes

- The endpoint is public but gated by `EMAIL_SECRET`; no user JWT (Apps Script
  can't hold one). Same trust model as the `nightly` cron.
- Email bodies are treated as **untrusted user content** by the agent (the
  prompt-injection guard in `SYSTEM_PROMPT` already applies — an alert email
  saying "ignore instructions" is surfaced for review, not obeyed).
- No inbound email is ever trusted for figures beyond what the text contains
  (evidence-grounding stage re-checks every amount/date).

---

## Status — BUILT (decisions locked: Apps Script forwarder + auto-apply)

Everything is committed and green (47 test files). Delivery = **Option 1 (Gmail
Apps Script)**; policy = **auto-apply, confidence-gated** (bank emails flow
through the normal `action-policy`, exactly like a typed capture).

- ✅ `lib/email-normalize.mjs` + `_shared` mirror (parity-guarded) + tests.
- ✅ `supabase/functions/email-inbound/index.ts` — secret-gated, dedupes, creates
  the capture, drives the existing `agent` pipeline via the internal path.
- ✅ `agent` internal-invoke path (`x-internal-secret` + explicit `userId`), with
  the ingestion-ownership check still enforced. **Security note:** this adds a
  server-to-server auth branch to the production `agent` fn — review it.
- ✅ Migration `20260709000016_email_messages.sql` (+ schema.sql mirror + RLS).
- ✅ CI: `deploy-functions.yml` deploys `email-inbound` with `--no-verify-jwt`.
- ✅ Contract test `tests/email-inbound-contract.test.mjs`.

### Activation (on your laptop, with the PAT)

1. Apply the migration `20260709000016_email_messages.sql` (Studio SQL editor or
   `npm run db:push`).
2. Set two secrets in `app_secrets`:
   ```sql
   insert into public.app_secrets (name, value) values
     ('EMAIL_SECRET', '<long random A>'),
     ('INTERNAL_INVOKE_SECRET', '<long random B>')
   on conflict (name) do update set value = excluded.value;
   ```
   `EMAIL_SECRET` authenticates the Apps Script → `email-inbound`;
   `INTERNAL_INVOKE_SECRET` authenticates `email-inbound` → `agent`.
3. Deploy (push to `main` → CI, or manual
   `supabase functions deploy email-inbound --no-verify-jwt --project-ref yyoewdcijplkhxleejtm`
   and redeploy `agent` so its internal path ships).
4. (Single-user app: nothing to configure. If you ever add a 2nd account, set the
   `EMAIL_OWNER_USER_ID` function secret to your `profiles.id`.)
5. Paste the Apps Script above into script.google.com, set `ENDPOINT` +
   `SECRET` (= `EMAIL_SECRET`), add a 15-min time trigger.
6. Smoke test: forward yourself an HDFC alert (or wait for one) → within 15 min
   it should appear as a capture and, if confident, an auto-applied expense.
   Verify: `select raw_text, status from raw_ingestions where capture_mode='email' order by created_at desc limit 5;`

### Follow-ups (not built)

- Expand the Apps Script `QUERY` to your actual bank senders / other sources.
- Optional: a Settings toggle to pause email ingestion.
- If you later want zero Google-side script, swap delivery to Option 2/3 — the
  endpoint + normalizer stay; only the caller changes.
