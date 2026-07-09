// EMAIL NORMALIZE — unit coverage for lib/email-normalize.mjs. Proves an inbound
// bank alert becomes the clean capture text the agent already knows how to parse,
// quoted history / footers are stripped, and dedupe keys are stable.
import assert from "node:assert/strict";
import { normalizeEmail, senderAddress, senderDomain, cleanBody, dedupeKey } from "../lib/email-normalize.mjs";

// --- sender parsing --------------------------------------------------------
assert.equal(senderAddress("HDFC Bank <alerts@hdfcbank.net>"), "alerts@hdfcbank.net");
assert.equal(senderAddress("alerts@hdfcbank.net"), "alerts@hdfcbank.net");
assert.equal(senderAddress("Weird Name Only"), "", "no address -> empty");
assert.equal(senderDomain("HDFC Bank <alerts@hdfcbank.net>"), "hdfcbank.net");

// --- HDFC credit-card alert, end to end ------------------------------------
{
  const r = normalizeEmail({
    from: "HDFC Bank InstaAlerts <alerts@hdfcbank.net>",
    subject: "Alert : Update on your HDFC Bank Credit Card",
    text: "Dear Customer,\n\nThank you for using HDFC Bank Credit Card ending 1234 for Rs 540.00 at SWIGGY on 21-06-2026 20:14:03.\n\nThis is a system generated email. Please do not reply.",
    messageId: "<abc123@hdfcbank.net>",
    receivedAt: "2026-06-21T20:15:00+05:30",
  });
  assert.ok(r.captureText.includes("Rs 540.00"), "amount survives");
  assert.ok(r.captureText.includes("SWIGGY"), "merchant survives");
  assert.ok(!/system generated/i.test(r.captureText), "footer stripped");
  assert.ok(r.captureText.startsWith("Alert :"), "subject leads the capture");
  assert.equal(r.sender, "alerts@hdfcbank.net");
  assert.equal(r.dedupeKey, "mid:abc123@hdfcbank.net");
}

// --- quoted reply history is cut -------------------------------------------
{
  const body = cleanBody({ text: "Rs.250.00 debited from a/c **1234 on 21-06-26.\n\nOn Sun, 21 Jun 2026 wrote:\n> old stuff\n> more old stuff" });
  assert.ok(body.includes("Rs.250.00"));
  assert.ok(!body.includes("old stuff"), "quoted history removed");
}

// --- HTML-only email is de-tagged ------------------------------------------
{
  const r = normalizeEmail({
    from: "ICICI <alerts@icicibank.com>",
    subject: "Transaction alert",
    html: "<html><body><p>INR 1,299.00 spent on ICICI Card at AMAZON.</p><br><span>Ref 998877</span></body></html>",
  });
  assert.ok(r.captureText.includes("INR 1,299.00"));
  assert.ok(r.captureText.includes("AMAZON"));
  assert.ok(!/[<>]/.test(r.captureText), "no angle-bracket tags leak through");
}

// --- dedupe keys: message-id wins; synthetic falls back to sender|subj|day --
assert.equal(dedupeKey({ messageId: "<X@y>" }), "mid:x@y");
assert.equal(
  dedupeKey({ from: "a@b.com", subject: "  Daily  Summary ", receivedAt: "2026-07-09T07:00:00Z" }),
  "syn:a@b.com|daily summary|2026-07-09",
);
// same subject, different day -> different key (a daily alert isn't collapsed)
assert.notEqual(
  dedupeKey({ from: "a@b.com", subject: "Summary", receivedAt: "2026-07-08" }),
  dedupeKey({ from: "a@b.com", subject: "Summary", receivedAt: "2026-07-09" }),
);

// --- empty / junk -> empty capture (caller skips) --------------------------
assert.equal(normalizeEmail({ subject: "", text: "   " }).captureText, "");
assert.equal(normalizeEmail({}).captureText, "");

console.log("email-normalize tests passed");
