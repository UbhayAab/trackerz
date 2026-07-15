import { ComingSoon } from "@/components/coming-soon";

export default function AnalyticsPage() {
  return (
    <ComingSoon
      title="Analytics"
      points={[
        "Spend trajectory + opportunity-cost (what that money could've grown to)",
        "Macro pace, habit score & streaks, recovery/sleep-debt",
        "Period aggregations (week / month) with day-over-day deltas",
        "Charts via Recharts, animated on scroll",
      ]}
    />
  );
}
