// Facts that only exist between two rows.
//
// Classification can look at one transaction and say what it probably is.
// Everything in this file needs a pair: a debit here and a credit there are one
// transfer, not two events; a credit is only a refund if some earlier debit paid
// for it; three identical charges on one day is a duplicate charge; a payment is
// only "recurring" once there is a rhythm to compare against - and the most
// useful thing about a rhythm is noticing the month it did not happen.
//
// All matching is deterministic and reason-carrying: every link records WHY it
// was made, because an unexplained merge of two real transactions is worse than
// no merge at all.
//
// Pure and dependency-free.

const DAY = 86_400_000;

/**
 * A calendar date from whatever the caller has: an ISO string, a Postgres
 * timestamp, or a Date object handed back by the `pg` driver.
 *
 * This exists because `String(dateObject).slice(0, 10)` yields "Sat Jan 04",
 * which `Date.parse` rejects, which makes every distance NaN - and `NaN > 4` is
 * FALSE, so a date window built on it silently admits everything. That turned
 * amount-only coincidences into six confident "you already logged this"
 * matches. Anything unparseable returns null and is treated as no-match.
 */
export function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (direct) return direct[1];
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

// Returns Infinity, never NaN, when either side has no usable date - so every
// `distance <= window` test fails closed instead of passing silently.
function dayDiff(a, b) {
  const left = isoDay(a);
  const right = isoDay(b);
  if (!left || !right) return Infinity;
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / DAY;
}

function amountOf(t) {
  return Number(t.debit || t.credit || 0);
}

function money(t) {
  return Math.round(amountOf(t) * 100);
}

// ---------------------------------------------------------------------------
// Self-transfers between the user's own accounts
// ---------------------------------------------------------------------------

/**
 * Pair a debit on one account with the matching credit on another.
 *
 * Two accounts imported together double-count every rupee moved between them:
 * the user's own statements show Rs 87,658.57 leaving HDFC and arriving at Kotak
 * on the same day, and counting both is a Rs 1.75 lakh error on a Rs 3.5 lakh
 * spend figure.
 *
 * A pair needs: same amount to the paisa, within `windowDays`, opposite
 * directions, and DIFFERENT accounts. The last condition is what stops two
 * unrelated equal payments on the same account being welded together.
 */
export function linkSelfTransfers(txns, { windowDays = 3 } = {}) {
  const debits = txns.filter((t) => t.debit && t.accountId);
  const credits = txns.filter((t) => t.credit && t.accountId);
  const byAmount = new Map();
  for (const c of credits) {
    const key = money(c);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(c);
  }

  const pairs = [];
  const used = new Set();
  for (const debit of debits) {
    const candidates = (byAmount.get(money(debit)) || [])
      .filter((c) => !used.has(c.id) && c.accountId !== debit.accountId && dayDiff(debit.date, c.date) <= windowDays)
      .sort((a, b) => dayDiff(debit.date, a.date) - dayDiff(debit.date, b.date));
    if (!candidates.length) continue;

    const credit = candidates[0];
    const flagged = isSelfFlow(debit.flow) || isSelfFlow(credit.flow);
    // Equal amounts on the same day across two accounts is a coincidence often
    // enough to matter: on 28 April the user paid Ayush Srivastava Rs 25,000 from
    // HDFC and separately received Rs 25,000 from Aayush Anand into Kotak. Two
    // different named people are two different events, whatever the arithmetic
    // looks like.
    if (!flagged && namesConflict(debit, credit)) continue;
    // Either side already recognising itself as own-account movement is proof.
    // Without that, an equal-and-opposite pair across two accounts on the same
    // day is strong but not certain, so it is offered for review rather than
    // applied - two people can genuinely settle the same amount both ways.
    const confidence = flagged ? 0.98 : 0.8;
    pairs.push({
      debitId: debit.id,
      creditId: credit.id,
      amount: amountOf(debit),
      date: debit.date,
      daysApart: dayDiff(debit.date, credit.date),
      fromAccountId: debit.accountId,
      toAccountId: credit.accountId,
      confidence,
      reason: flagged ? "own_account_named_and_amount_matched" : "cross_account_amount_and_date_matched",
      autoApply: flagged,
    });
    used.add(credit.id);
  }
  return pairs;
}

function isSelfFlow(flow) {
  return flow === "self_transfer_out" || flow === "self_transfer_in";
}

// Both sides naming a counterparty, and the two names sharing no word, is
// positive evidence AGAINST a pair - not merely an absence of evidence for one.
function namesConflict(a, b) {
  const wordsOf = (s) =>
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
  const left = wordsOf(a.counterparty);
  const right = wordsOf(b.counterparty);
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return !left.some((w) => rightSet.has(w));
}

// ---------------------------------------------------------------------------
// Refunds and reversals
// ---------------------------------------------------------------------------

/**
 * Match money coming back to the payment that sent it out.
 *
 * Three strengths of evidence, strongest first:
 *  1. the reversal narration names the original RRN (UPIRET-...) - exact
 *  2. same counterparty, same amount, credit after debit - strong
 *  3. the credit is an exact multiple of N identical same-day debits, which is
 *     what a bank refunding a double- or triple-charge actually looks like:
 *     three card payments of 9,809.73 on 26 March, one credit of 19,619.46 on
 *     27 March. Amount-only matching never finds this, because no single debit
 *     equals the refund.
 */
export function linkRefunds(txns, { windowDays = 90, excludeIds = [] } = {}) {
  // Money the user moved between their own accounts is equal-and-opposite by
  // construction, so it satisfies every same-amount refund test. Left in, the
  // Rs 87,658.57 HDFC-to-Kotak transfer was reported as a refund of itself.
  const skip = new Set(excludeIds);
  const eligible = txns.filter((t) => !isSelfFlow(t.flow) && !skip.has(t.id));
  const debits = eligible.filter((t) => t.debit);
  const credits = eligible.filter((t) => t.credit);
  const links = [];
  const claimed = new Set();

  for (const credit of credits) {
    const before = debits.filter(
      (d) => !claimed.has(d.id) && d.date <= credit.date && dayDiff(d.date, credit.date) <= windowDays,
    );

    // 1. The reversal names its original.
    const ref = credit.parsed?.reversesRef || credit.reversesRef;
    if (ref) {
      const exact = before.find((d) => d.parsed?.ref === ref || d.reference === ref || String(d.reference || "").includes(ref));
      if (exact) {
        links.push(link(credit, [exact], "reversal_names_original_reference", 0.99));
        claimed.add(exact.id);
        continue;
      }
    }

    // 2. Same counterparty, same amount.
    const sameParty = before.filter(
      (d) => money(d) === money(credit) && d.counterparty && d.counterparty === credit.counterparty,
    );
    if (sameParty.length) {
      const chosen = sameParty[sameParty.length - 1];
      links.push(link(credit, [chosen], "same_counterparty_and_amount", 0.85));
      claimed.add(chosen.id);
      continue;
    }

    // 3. An exact multiple of a same-day repeated charge.
    const multi = findRepeatedChargeRefund(credit, before);
    if (multi) {
      links.push(link(credit, multi.debits, "refund_of_repeated_charge", 0.88, { multiple: multi.count }));
      for (const d of multi.debits) claimed.add(d.id);
    }
  }
  return links;
}

function findRepeatedChargeRefund(credit, debits) {
  const groups = new Map();
  for (const d of debits) {
    const key = `${d.date}|${money(d)}|${d.counterparty || d.parsed?.cardLast4 || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const unit = money(group[0]);
    if (!unit) continue;
    const target = money(credit);
    if (target % unit !== 0) continue;
    const count = target / unit;
    if (count < 1 || count > group.length) continue;
    return { debits: group.slice(0, count), count };
  }
  return null;
}

function link(credit, debits, reason, confidence, extra = {}) {
  return {
    creditId: credit.id,
    debitIds: debits.map((d) => d.id),
    amount: amountOf(credit),
    date: credit.date,
    reason,
    confidence,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Duplicate charges
// ---------------------------------------------------------------------------

/**
 * The same counterparty charging the same amount more than once in a day.
 *
 * Reported, never auto-removed. Two identical chai payments an hour apart are
 * completely normal, and deleting one because it looked odd would be inventing
 * a correction to the bank's own record. `refunded` says whether the money
 * actually came back, which is the part worth acting on.
 */
// A SIP is BUILT to fire the same amount to the same fund several times over,
// and four Rs 25,000 mutual-fund purchases in one day are four purchases. Only
// flows where a repeat is unexpected are examined.
const REPEAT_IS_NORMAL = new Set(["investment", "investment_return", "self_transfer_out", "self_transfer_in", "loan_emi"]);

export function detectDuplicateCharges(txns, refundLinks = []) {
  const refunded = new Set(refundLinks.flatMap((l) => l.debitIds));
  const groups = new Map();
  for (const t of txns) {
    if (!t.debit || REPEAT_IS_NORMAL.has(t.flow)) continue;
    const key = `${t.date}|${money(t)}|${(t.counterparty || t.description || "").toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const recovered = group.filter((t) => refunded.has(t.id));
    out.push({
      date: group[0].date,
      counterparty: group[0].counterparty || group[0].description,
      amount: amountOf(group[0]),
      count: group.length,
      totalCharged: Math.round(amountOf(group[0]) * group.length * 100) / 100,
      ids: group.map((t) => t.id),
      refundedCount: recovered.length,
      stillOut: Math.round(amountOf(group[0]) * (group.length - recovered.length) * 100) / 100,
    });
  }
  return out.sort((a, b) => b.totalCharged - a.totalCharged);
}

// ---------------------------------------------------------------------------
// Recurring payments
// ---------------------------------------------------------------------------

const CADENCES = [
  { name: "monthly", days: 30, tolerance: 6 },
  { name: "weekly", days: 7, tolerance: 2 },
  { name: "quarterly", days: 91, tolerance: 12 },
  { name: "yearly", days: 365, tolerance: 20 },
];

/**
 * Find payments with a rhythm, and say when the rhythm broke.
 *
 * The missed instance is the point. A subscription that silently kept charging
 * is visible in any category total; an EMI that stopped in June because the loan
 * was foreclosed in May is only visible if something was expecting it.
 */
export function detectRecurring(txns, { minOccurrences = 3, asOf = null } = {}) {
  const groups = new Map();
  for (const t of txns) {
    if (!t.debit && !t.credit) continue;
    const key = recurringKey(t);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const series = [];
  for (const [key, rows] of groups) {
    if (rows.length < minOccurrences) continue;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(dayDiff(sorted[i - 1].date, sorted[i].date));
    const median = medianOf(gaps);
    const cadence = CADENCES.find((c) => Math.abs(median - c.days) <= c.tolerance);
    if (!cadence) continue;
    // Every gap must fit the cadence, or it is a coincidence rather than a rhythm.
    const regular = gaps.every((g) => Math.abs(g - cadence.days) <= cadence.tolerance * 2);
    if (!regular) continue;

    const amounts = sorted.map(amountOf);
    const last = sorted[sorted.length - 1];
    const expectedNext = addDays(last.date, cadence.days);
    const today = asOf || last.date;
    const overdueDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${expectedNext}T00:00:00Z`)) / DAY);

    series.push({
      key,
      counterparty: last.counterparty || last.description,
      direction: last.debit ? "out" : "in",
      cadence: cadence.name,
      occurrences: sorted.length,
      amount: Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) / 100,
      amountVaries: Math.max(...amounts) - Math.min(...amounts) > 1,
      firstSeen: sorted[0].date,
      lastSeen: last.date,
      expectedNext,
      // Only claimed once a full extra cadence has gone by, so a payment that is
      // three days late is not announced as a missed one.
      missed: overdueDays > cadence.tolerance,
      overdueDays: overdueDays > 0 ? overdueDays : 0,
      annualised: Math.round(((amounts.reduce((a, b) => a + b, 0) / amounts.length) * (365 / cadence.days)) * 100) / 100,
      ids: sorted.map((t) => t.id),
    });
  }
  return series.sort((a, b) => b.annualised - a.annualised);
}

function recurringKey(t) {
  const party = (t.counterparty || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (party) return `${party}|${t.debit ? "out" : "in"}`;
  const card = t.parsed?.cardLast4 || t.parsed?.loanAccount;
  return card ? `${card}|${t.debit ? "out" : "in"}` : null;
}

function medianOf(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Matching a bank row against what the user already logged by hand
// ---------------------------------------------------------------------------

/**
 * Find the manual entry that a bank row is the same event as.
 *
 * The user types "lunch 110" at the till; three days later the bank row for the
 * same lunch arrives. Importing it blind doubles the day's spending. But the two
 * records disagree slightly by nature - a rounded amount, a date that slipped
 * past midnight, no merchant - so this is scored, not exact-matched, and only a
 * strong score is auto-merged.
 *
 * The bank row is the survivor: it has the true amount, the true date and a
 * reference. The manual note is kept as its description, because "lunch" is
 * something the statement will never know.
 */
export function matchManualEntries(bankRows, manualEntries, { windowDays = 4, tolerance = 0.02 } = {}) {
  const matches = [];
  const taken = new Set();
  for (const bank of bankRows) {
    if (!bank.debit) continue;
    let best = null;
    for (const manual of manualEntries) {
      if (taken.has(manual.id)) continue;
      const manualAmount = Number(manual.amount || 0);
      if (!manualAmount) continue;
      const diff = Math.abs(manualAmount - amountOf(bank));
      const relative = diff / Math.max(manualAmount, amountOf(bank));
      if (relative > tolerance) continue;
      const days = dayDiff(bank.date, manual.occurred_at);
      if (!Number.isFinite(days) || days > windowDays) continue;

      let score = 0.55 + (relative === 0 ? 0.2 : 0.1) + Math.max(0, 0.15 - days * 0.04);
      const reasons = [relative === 0 ? "exact_amount" : "amount_within_tolerance", `${days}d_apart`];
      if (textOverlap(bank.counterparty, manual.merchant) || textOverlap(bank.counterparty, manual.description)) {
        score += 0.2;
        reasons.push("merchant_overlap");
      }
      if (!best || score > best.score) best = { manual, score: Math.min(score, 0.99), reasons };
    }
    if (!best) continue;
    matches.push({
      bankId: bank.id,
      manualId: best.manual.id,
      amount: amountOf(bank),
      score: Math.round(best.score * 100) / 100,
      reasons: best.reasons,
      // Below this the two are shown side by side and the user decides. A wrong
      // auto-merge deletes a real transaction and is not recoverable from the UI.
      autoMerge: best.score >= 0.85,
      keepDescription: best.manual.description || best.manual.merchant || null,
    });
    taken.add(best.manual.id);
  }
  return matches;
}

function textOverlap(a, b) {
  const wordsOf = (s) =>
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
  const left = wordsOf(a);
  const right = new Set(wordsOf(b));
  return left.some((w) => right.has(w));
}

// ---------------------------------------------------------------------------
// One pass over everything
// ---------------------------------------------------------------------------

/**
 * Run every cross-row analysis and return the links plus a corrected view of
 * what was actually spent and earned.
 */
export function analyseTransactions(txns, { manualEntries = [], asOf = null } = {}) {
  const transfers = linkSelfTransfers(txns);
  // A row already accounted for as one leg of a transfer cannot also be a refund.
  const refunds = linkRefunds(txns, {
    excludeIds: transfers.filter((p) => p.autoApply).flatMap((p) => [p.debitId, p.creditId]),
  });
  const duplicates = detectDuplicateCharges(txns, refunds);
  const recurring = detectRecurring(txns, { asOf });
  const manualMatches = matchManualEntries(txns, manualEntries);

  // A refund cancels the spending it reverses, so the net figure subtracts it
  // rather than adding it to income - otherwise a refunded purchase inflates
  // both sides of the ledger and nets to zero only by accident.
  const refundedDebitIds = new Set(refunds.flatMap((l) => l.debitIds));
  const refundCreditIds = new Set(refunds.map((l) => l.creditId));
  const pairedTransferIds = new Set(transfers.flatMap((p) => [p.debitId, p.creditId]));

  return {
    transfers,
    refunds,
    duplicates,
    recurring,
    manualMatches,
    counts: {
      transferPairs: transfers.length,
      refundLinks: refunds.length,
      duplicateGroups: duplicates.length,
      recurringSeries: recurring.length,
      manualMatches: manualMatches.length,
    },
    refundedDebitIds: [...refundedDebitIds],
    refundCreditIds: [...refundCreditIds],
    pairedTransferIds: [...pairedTransferIds],
  };
}
