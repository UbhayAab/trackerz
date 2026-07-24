// Pure money-intelligence engine for the Money page.
//
// Turns raw ledger rows (+ budgets + subscriptions) into evidence-based
// insights. No DOM, no Supabase, no dates-from-now-guessing: every number is
// derived from real rows and carries the count of rows it came from. When
// support is thin the field is null and the caller renders "-" / an explicit
// "not enough data" state - NEVER a fabricated 0 or invented average.
//
// THE UNBREAKABLE RULE lives here: if a metric was never recorded we return
// null, not zero. A cap that was never set is `hasCap:false`, not a cap of 0.

// --- expense selection -------------------------------------------------------
// Only real, own-standing expenses count. Transfers move money between the
// user's own accounts (not spending); income is not spending; a row merged into
// another (a dedupe duplicate) would double-count. All three are excluded.
export function isSpend(row) {
  if (!row || row.direction !== "expense") return false;
  if (row.merged_into) return false;
  return true;
}

function amountOf(row) {
  const n = Math.abs(Number(row.amount));
  return Number.isFinite(n) ? n : 0;
}

// --- keyword classification --------------------------------------------------
// A merchant is the truth when present. When it is blank (voice-logged "Rs 110
// lunch" has no merchant) we fall back to classifying the free-text
// description. Unmatched text is "Other" - we do not guess a category.
const CATEGORY_KEYWORDS = [
  ["Food", ["lunch", "dinner", "breakfast", "egg", "roti", "rice", "curry", "meal", "swiggy", "zomato", "restaurant", "cafe", "dosa", "chai", " tea", "coffee", "snack", "pizza", "dominos", "biryani", "thali", "milk", "whey", "protein", "paratha", "sandwich", "burger", "food"]],
  ["Fuel", ["fuel", "petrol", "diesel", "iocl", "bpcl", "hpcl", "indian oil", "bharat petroleum", "hindustan petroleum", "shell", "fuel station", "pump"]],
  ["Groceries", ["grocery", "groceries", "bigbasket", "blinkit", "zepto", "dmart", "d-mart", "supermarket", "kirana", "vegetable", "fruits", "instamart"]],
  ["Transport", ["uber", "ola", "rapido", "metro", "irctc", "railway", "cab", "auto", "toll", "parking", "namma yatri"]],
  ["Shopping", ["amazon", "flipkart", "myntra", "ajio", "meesho", "mall", "decathlon"]],
  ["Bills", ["recharge", "electricity", "broadband", "jio", "airtel", "vodafone", "wifi", "dth", "postpaid", "utility", "bill payment"]],
  ["Entertainment", ["netflix", "spotify", "hotstar", "prime video", "bookmyshow", "movie", "cinema", "pvr", "inox"]],
  ["Health", ["pharmacy", "medical", "medicine", "apollo", "hospital", "clinic", "gym", "supplement", "chemist", "1mg"]],
];

// Exported for tests: which bucket a free-text description falls into, or null.
export function classifyDescription(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;
  for (const [label, words] of CATEGORY_KEYWORDS) {
    for (const w of words) {
      if (t.includes(w)) return label;
    }
  }
  return null;
}

// The grouping key for a row: its merchant if it has one, else the keyword
// category, else "Other". Merchant strings are trimmed but otherwise kept as
// the user/bank recorded them.
export function groupKey(row) {
  const merchant = String(row.merchant || "").trim();
  if (merchant) return merchant;
  return classifyDescription(row.description) || "Other";
}

// --- category / merchant breakdown -------------------------------------------
export function categoryBreakdown(rows, { limit = 6 } = {}) {
  const spend = (rows || []).filter(isSpend);
  const total = spend.reduce((s, r) => s + amountOf(r), 0);
  if (!spend.length || total <= 0) return { total: 0, count: 0, groups: [] };

  const byKey = new Map();
  for (const row of spend) {
    const key = groupKey(row);
    const cur = byKey.get(key) || { label: key, amount: 0, count: 0 };
    cur.amount += amountOf(row);
    cur.count += 1;
    byKey.set(key, cur);
  }
  const groups = [...byKey.values()]
    .map((g) => ({ ...g, pct: g.amount / total }))
    .sort((a, b) => b.amount - a.amount);

  // Fold the long tail into a single honest "Other N groups" row rather than a
  // 30-bar chart, but only when there genuinely is a tail.
  if (limit && groups.length > limit) {
    const head = groups.slice(0, limit - 1);
    const tail = groups.slice(limit - 1);
    const tailAmount = tail.reduce((s, g) => s + g.amount, 0);
    const tailCount = tail.reduce((s, g) => s + g.count, 0);
    head.push({
      label: `Other (${tail.length})`,
      amount: tailAmount,
      count: tailCount,
      pct: tailAmount / total,
      isTail: true,
    });
    return { total, count: spend.length, groups: head };
  }
  return { total, count: spend.length, groups };
}

// --- biggest recurring cost --------------------------------------------------
// A recurring cost is the SAME thing bought repeatedly at a near-constant price
// (the Rs 110 lunch, ~4x/week). We cluster a group's rows by amount, keep the
// clusters with >= 3 real occurrences, and rank by projected monthly outlay.
const MS_PER_DAY = 86_400_000;

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function biggestRecurring(rows, { minCount = 3 } = {}) {
  const spend = (rows || []).filter(isSpend);
  if (spend.length < minCount) return null;

  const byKey = new Map();
  for (const row of spend) {
    const key = groupKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  let best = null;
  for (const [label, group] of byKey) {
    if (group.length < minCount) continue;
    const amounts = group.map(amountOf).filter((a) => a > 0);
    if (amounts.length < minCount) continue;
    const median = medianOf(amounts);
    if (median <= 0) continue;
    // Near-equal = within the larger of Rs 20 or 12% of the median. This keeps
    // the Rs 110 lunch (108/110/112) together without merging Rs 110 and Rs 900.
    const tol = Math.max(20, median * 0.12);
    const cluster = group.filter((r) => Math.abs(amountOf(r) - median) <= tol);
    if (cluster.length < minCount) continue;

    const times = cluster
      .map((r) => new Date(r.occurred_at).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    if (times.length < minCount) continue;
    const spanDays = (times[times.length - 1] - times[0]) / MS_PER_DAY;
    const clusterMedian = medianOf(cluster.map(amountOf));

    // Frequency needs at least a few days of span to be real; a burst on one
    // day is not a weekly habit. Below that we still report count + total but
    // not a fabricated per-week rate.
    let perWeek = null;
    let weeklyCost = null;
    let monthlyCost = null;
    if (spanDays >= 6) {
      perWeek = cluster.length / (spanDays / 7);
      weeklyCost = clusterMedian * perWeek;
      monthlyCost = weeklyCost * (365 / 12 / 7); // weeks-per-month
    }
    const observedTotal = clusterMedian * cluster.length;
    const rank = monthlyCost != null ? monthlyCost : observedTotal;

    if (!best || rank > best._rank) {
      best = {
        label,
        medianAmount: Math.round(clusterMedian),
        count: cluster.length,
        spanDays: Math.round(spanDays),
        perWeek: perWeek != null ? Math.round(perWeek * 10) / 10 : null,
        weeklyCost: weeklyCost != null ? Math.round(weeklyCost) : null,
        monthlyCost: monthlyCost != null ? Math.round(monthlyCost) : null,
        observedTotal: Math.round(observedTotal),
        sampleIds: cluster.map((r) => r.id),
        _rank: rank,
      };
    }
  }
  if (best) delete best._rank;
  return best;
}

// --- month forecast ----------------------------------------------------------
// Projects month-end spend from the pace so far, and compares it to the
// monthly_spend cap IF one is set. No cap set is a real, honest state - we say
// "set a cap" rather than invent one.
export function monthForecast(rows, budgets, today = new Date()) {
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth = today.getDate();

  const spent = (rows || [])
    .filter(isSpend)
    .filter((r) => {
      const t = new Date(r.occurred_at).getTime();
      return Number.isFinite(t) && t >= monthStart.getTime();
    })
    .reduce((s, r) => s + amountOf(r), 0);

  const cap = capAmount(budgets, "monthly_spend");
  // No spend yet + no cap: nothing to project honestly.
  const dailyPace = dayOfMonth > 0 ? spent / dayOfMonth : 0;
  const projected = Math.round(dailyPace * daysInMonth);

  const base = {
    spent: Math.round(spent),
    dayOfMonth,
    daysInMonth,
    projected: spent > 0 ? projected : null,
    hasCap: cap != null,
    cap: cap != null ? cap : null,
  };
  if (cap == null) return base;
  return {
    ...base,
    projectedVsCap: spent > 0 ? projected - cap : null,
    pctOfCapProjected: spent > 0 ? projected / cap : null,
    onTrack: spent > 0 ? projected <= cap : null,
  };
}

function capAmount(budgets, kind) {
  const row = (budgets || []).find((b) => b && b.kind === kind);
  const amount = row ? Number(row.amount) : NaN;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// --- discretionary vs essential split ---------------------------------------
// is_discretionary is a real tri-state: true, false, or never set. We keep the
// unknown bucket separate instead of silently calling it essential.
export function discretionarySplit(rows) {
  const spend = (rows || []).filter(isSpend);
  let discretionary = 0;
  let essential = 0;
  let unknown = 0;
  for (const row of spend) {
    const a = amountOf(row);
    if (row.is_discretionary === true) discretionary += a;
    else if (row.is_discretionary === false) essential += a;
    else unknown += a;
  }
  const total = discretionary + essential + unknown;
  if (total <= 0) return null;
  const classified = discretionary + essential;
  return {
    discretionary: Math.round(discretionary),
    essential: Math.round(essential),
    unknown: Math.round(unknown),
    total: Math.round(total),
    // Ratio is over CLASSIFIED spend only - dividing by a total that is mostly
    // "unknown" would understate the real discretionary share.
    discretionaryRatio: classified > 0 ? discretionary / classified : null,
  };
}

// --- upcoming subscriptions --------------------------------------------------
export function upcomingSubscriptions(subscriptions, today = new Date(), { withinDays = 30 } = {}) {
  const now = today.getTime();
  const horizon = now + withinDays * MS_PER_DAY;
  const due = (subscriptions || [])
    .filter((s) => s && s.is_active !== false && s.next_expected_at)
    .map((s) => {
      const t = new Date(s.next_expected_at).getTime();
      return {
        merchant: s.merchant || "Subscription",
        amount: Number.isFinite(Number(s.median_amount)) ? Math.round(Number(s.median_amount)) : null,
        nextAt: s.next_expected_at,
        cadenceDays: s.cadence_days != null ? Number(s.cadence_days) : null,
        daysAway: Number.isFinite(t) ? Math.round((t - now) / MS_PER_DAY) : null,
        _t: t,
      };
    })
    .filter((s) => Number.isFinite(s._t) && s._t >= now - MS_PER_DAY && s._t <= horizon)
    .sort((a, b) => a._t - b._t);
  due.forEach((s) => delete s._t);
  return due;
}

// --- where you could cut -----------------------------------------------------
// Grounded in the top DISCRETIONARY category only - we never tell the user to
// cut fuel or rent. Returns null when there is no discretionary spend to name.
export function whereToCut(rows) {
  const discretionaryRows = (rows || []).filter((r) => isSpend(r) && r.is_discretionary === true);
  if (!discretionaryRows.length) return null;
  const { total, groups } = categoryBreakdown(discretionaryRows, { limit: 99 });
  const top = groups.find((g) => !g.isTail);
  if (!top || top.amount <= 0) return null;
  return {
    label: top.label,
    amount: Math.round(top.amount),
    count: top.count,
    shareOfDiscretionary: total > 0 ? top.amount / total : null,
    halfSaving: Math.round(top.amount / 2),
  };
}

// --- top-level assembly ------------------------------------------------------
// One call the UI renders. `empty` is the honest "nothing to show" gate: no
// spend rows means every insight below would be an invention.
export function buildMoneyInsights({ ledger = [], budgets = [], subscriptions = [], today = new Date() } = {}) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const spend = rows.filter(isSpend);
  const breakdown = categoryBreakdown(rows);

  return {
    empty: spend.length === 0,
    spendRowCount: spend.length,
    breakdown,
    recurring: biggestRecurring(rows),
    forecast: monthForecast(rows, budgets, today),
    split: discretionarySplit(rows),
    upcoming: upcomingSubscriptions(subscriptions, today),
    cut: whereToCut(rows),
  };
}
