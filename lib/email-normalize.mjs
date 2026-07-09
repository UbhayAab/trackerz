// EMAIL → CAPTURE normalization. Turns a raw inbound email (from / subject /
// body) into the clean text the capture pipeline ingests, plus a stable dedupe
// key so the same message is never ingested twice. Pure (no DOM/Supabase/network)
// so it's unit-tested and shared by whatever delivery mechanism feeds it (Apps
// Script forwarder, inbound-parse webhook, or a Gmail poll — see
// docs/email-ingestion-plan.md). The existing agent SYSTEM_PROMPT already knows
// how to parse HDFC/UPI alerts; this module just hands it clean input.

const MAX_CAPTURE = 2000;

// Pull the bare address out of a From header: "HDFC Bank <alerts@hdfcbank.net>"
// -> "alerts@hdfcbank.net". Falls back to the trimmed input when there is no
// angle-bracket form.
export function senderAddress(from = "") {
  const s = String(from || "").trim();
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return /\S+@\S+/.test(addr) ? addr : "";
}

export function senderDomain(from = "") {
  const at = senderAddress(from).split("@")[1] || "";
  return at;
}

// Very small HTML→text: drop style/script blocks, turn <br>/<p>/</tr> into
// newlines, strip the rest of the tags, and decode the handful of entities that
// show up in bank alerts. Not a full parser — inbound bank mail is simple HTML.
function htmlToText(html = "") {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

// Markers that begin a quoted reply chain / forwarded history — everything from
// the first one onward is noise we don't want in the capture.
const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}/im,
  /^-{2,}\s*forwarded message\s*-{2,}/im,
  /^on .+ wrote:/im,
  /^from:\s.+\nsent:\s/im,
  /^_{5,}/m,
];

// Trailing boilerplate lines we strip (system-generated / do-not-reply / legal).
const FOOTER_MARKERS = [
  /this is a system generated (e-?mail|message)[\s\S]*$/i,
  /please do not reply to this (e-?mail|message)[\s\S]*$/i,
  /this e-?mail (and any attachments )?is confidential[\s\S]*$/i,
  /if you did not (make|initiate) this transaction[\s\S]*$/i,
  /to unsubscribe[\s\S]*$/i,
];

function stripQuotedHistory(text) {
  let cut = text.length;
  for (const rx of QUOTE_MARKERS) {
    const m = text.match(rx);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

function stripFooters(text) {
  let out = text;
  for (const rx of FOOTER_MARKERS) out = out.replace(rx, "");
  return out;
}

export function cleanBody({ text = "", html = "" } = {}) {
  const raw = text && text.trim() ? text : htmlToText(html);
  const noQuote = stripQuotedHistory(String(raw));
  const noFooter = stripFooters(noQuote);
  return noFooter
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^>/.test(l))     // drop quoted ">" lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Stable idempotency key. Prefer the RFC Message-ID (angle brackets stripped);
// otherwise derive one from sender + subject + the received DATE (so a daily
// same-subject alert on different days is not collapsed, but a re-delivery of the
// same message is). Deterministic, dependency-free (no hashing needed for a
// unique-index key).
export function dedupeKey({ messageId = "", from = "", subject = "", receivedAt = "" } = {}) {
  const mid = String(messageId || "").replace(/[<>]/g, "").trim().toLowerCase();
  if (mid) return `mid:${mid}`;
  const day = String(receivedAt || "").slice(0, 10);   // YYYY-MM-DD (or "")
  const subj = String(subject || "").replace(/\s+/g, " ").trim().toLowerCase();
  return `syn:${senderAddress(from)}|${subj}|${day}`;
}

// The one entry point. Returns the capture text the pipeline should ingest plus
// the metadata a delivery layer needs. `captureText` is "" when there is nothing
// usable (the caller should skip ingesting it).
export function normalizeEmail(email = {}) {
  const { from = "", subject = "", text = "", html = "", messageId = "", receivedAt = "" } = email || {};
  const body = cleanBody({ text, html });
  const subj = String(subject || "").replace(/\s+/g, " ").trim();
  const parts = [];
  if (subj) parts.push(subj);
  if (body) parts.push(body);
  const captureText = parts.join("\n\n").slice(0, MAX_CAPTURE).trim();
  return {
    captureText,
    dedupeKey: dedupeKey({ messageId, from, subject, receivedAt }),
    sender: senderAddress(from),
    senderDomain: senderDomain(from),
    subject: subj,
  };
}
