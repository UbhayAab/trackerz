// Habituation: the anti-dullness mechanism. Human attention stops firing for
// repeated stimuli; Jarvis does the same — an insight/thought shown recently is
// suppressed unless it is critical, so briefings never read like yesterday's.
// Pure: no clock, no DB. History = signatures the caller extracted from prior
// briefings' payloads.

// Stable signature for a line of insight/thought text: numbers and dates change
// day to day ("Protein gap 62g" vs "58g") but the MESSAGE is the same — strip
// digits so the signature captures the message, not the measurement.
export function insightSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[₹$]|rs\.?\s?/g, "")
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Collect signatures from prior briefing payloads (array of payload objects,
// newest first). Reads payload.insights (strings) + payload.thought/question.
export function historyFromBriefings(payloads = [], { days = 4 } = {}) {
  const sigs = new Set();
  for (const p of payloads.slice(0, days * 2)) { // two slots per day
    for (const line of p?.insights || []) sigs.add(insightSignature(line));
    if (p?.thought?.text) sigs.add(insightSignature(p.thought.text));
    if (p?.question) sigs.add(insightSignature(p.question));
    for (const n of p?.nudges || []) sigs.add(insightSignature(n));
  }
  sigs.delete("");
  return sigs;
}

// Filter items ({text, severity?}) against history. Critical severity always
// passes (a fresh overspend must repeat until fixed); everything else needs a
// signature not seen in the recent window. Returns { fresh, suppressed }.
export function filterNovel(items = [], historySigs = new Set()) {
  const fresh = [];
  const suppressed = [];
  const seenNow = new Set();
  for (const it of items) {
    const text = typeof it === "string" ? it : it?.text;
    const sig = insightSignature(text);
    if (!sig) continue;
    const repeatWithin = seenNow.has(sig);
    const repeatAcross = historySigs.has(sig) && (typeof it === "object" ? it.severity : "") !== "critical";
    if (repeatWithin || repeatAcross) suppressed.push(it);
    else {
      fresh.push(it);
      seenNow.add(sig);
    }
  }
  return { fresh, suppressed };
}
