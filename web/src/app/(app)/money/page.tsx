import { ComingSoon } from "@/components/coming-soon";

export default function MoneyPage() {
  return (
    <ComingSoon
      title="Money"
      points={[
        "Ledger with expense / income / transfer + discretionary split",
        "Bank statement import (format detection + column mapping)",
        "Budgets & spend-cap trajectory, subscription detection",
        "Cross-source dedupe: a voice ₹250 lunch links to the ₹252 bank row",
      ]}
    />
  );
}
