import { scoreExpenseDuplicate } from "../../lib/agent-core.mjs";
import { clusterByPossibleSum } from "./dedupe-matrix.js";
import { currencyConflict } from "./score-pair.js";

export function clusterExpenseDuplicates(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const score = scoreExpenseDuplicate(rows[i], rows[j]);
      if (score.score >= 0.6) {
        pairs.push({ a: rows[i].id, b: rows[j].id, ...score });
      }
    }
  }
  return pairs;
}

// One row that equals the sum of several others is the shape of a double-apply:
// "just ate 20 rupees lays and 60 for 3 boiled eggs" landed once as a single
// Rs 80 row and again as Rs 20 + Rs 60 (2026-07-09, ~Rs 240 booked for an Rs 80
// purchase). Pairwise scoring can never see it — no two of those rows have the
// same amount — so the whole incident was invisible to the scanner.
const DEFAULTS = {
  toleranceInr: 2,      // line items sum exactly; 2 absorbs paise rounding only
  windowHours: 4,       // matches the pair scanner's time bucket
  maxItems: 4,
  maxCandidates: 8,     // caps the subset enumeration at 2^8 masks per parent
};

// Returns [{ parent, items, sumAmount, diff, reason }], at most one group per
// parent row, preferring the smallest exact subset.
export function clusterExpenseSubsetSums(rows, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const groups = [];
  const claimed = new Set();

  // The merchant-anchored matcher in dedupe-matrix.js only fires when the big
  // row came from a bank/file import AND shares a merchant with its children
  // ("ZOMATO 280" vs "lunch 250 + chai 30"). Its evidence is stronger, so it
  // gets first claim on a parent.
  for (const group of clusterByPossibleSum(rows)) {
    const id = group.parent?.id;
    if (!id || claimed.has(id)) continue;
    claimed.add(id);
    groups.push({ ...group, reason: "subset_sum_merchant" });
  }

  // Largest row first: the row that is the WHOLE is the big one, and trying it
  // first keeps the result independent of the order the DB handed rows back.
  const byAmountDesc = [...rows].sort((x, y) => Math.abs(Number(y?.amount || 0)) - Math.abs(Number(x?.amount || 0)));
  for (const parent of byAmountDesc) {
    if (!parent?.id || claimed.has(parent.id)) continue;
    const parentAmt = Math.abs(Number(parent.amount || 0));
    if (!parentAmt) continue;

    const children = rows.filter((child) => (
      child?.id
      && child.id !== parent.id
      && !claimed.has(child.id)
      && Math.abs(Number(child.amount || 0)) > 0
      && Math.abs(Number(child.amount || 0)) < parentAmt
      && (!child.direction || !parent.direction || child.direction === parent.direction)
      && !currencyConflict(parent, child)
      && withinHours(parent.occurred_at, child.occurred_at, opts.windowHours)
    ));
    if (children.length < 2) continue;

    const subset = bestSubset(children, parentAmt, opts);
    if (!subset) continue;
    for (const item of subset.items) claimed.add(item.id);
    claimed.add(parent.id);
    groups.push({
      parent,
      items: subset.items,
      sumAmount: subset.total,
      diff: subset.total - parentAmt,
      reason: "subset_sum",
    });
  }

  return groups;
}

function withinHours(a, b, hours) {
  const tA = new Date(a).getTime();
  const tB = new Date(b).getTime();
  // An unparseable timestamp must not silently pass as "close enough".
  if (Number.isNaN(tA) || Number.isNaN(tB)) return false;
  return Math.abs(tA - tB) / 3_600_000 <= hours;
}

// Smallest subset wins, then the tightest sum: two rows that add up exactly are
// far better evidence of a split capture than four rows that add up loosely.
function bestSubset(children, target, opts) {
  const pool = [...children]
    .sort((x, y) => Math.abs(Number(y.amount || 0)) - Math.abs(Number(x.amount || 0)))
    .slice(0, opts.maxCandidates);
  let best = null;
  for (let mask = 1; mask < 1 << pool.length; mask += 1) {
    const items = [];
    let total = 0;
    for (let i = 0; i < pool.length; i += 1) {
      if (mask & (1 << i)) { items.push(pool[i]); total += Math.abs(Number(pool[i].amount || 0)); }
    }
    if (items.length < 2 || items.length > opts.maxItems) continue;
    const diff = Math.abs(total - target);
    if (diff > opts.toleranceInr) continue;
    if (!best || items.length < best.items.length || (items.length === best.items.length && diff < Math.abs(best.total - target))) {
      best = { items, total };
    }
  }
  return best;
}
