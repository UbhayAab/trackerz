// Formatters. INR + Asia/Kolkata, matching the current app's conventions.

export function inr(n: number | null | undefined, opts: { compact?: boolean } = {}) {
  const v = Number(n || 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: opts.compact && Math.abs(v) >= 1000 ? 0 : 0,
    notation: opts.compact ? "compact" : "standard",
  }).format(v);
}

export function num(n: number | null | undefined) {
  return new Intl.NumberFormat("en-IN").format(Number(n || 0));
}

export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function startOfTodayIST(): string {
  // Midnight Asia/Kolkata expressed as an ISO instant.
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00+05:30`;
}
