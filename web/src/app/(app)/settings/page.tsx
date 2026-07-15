import { ComingSoon } from "@/components/coming-soon";

export default function SettingsPage() {
  return (
    <ComingSoon
      title="Settings"
      points={[
        "Profile, timezone, currency",
        "Push notifications + nightly briefing toggles",
        "Paste-a-plan: drop a full ChatGPT/coach diet or gym plan",
        "Account + sign out",
      ]}
    />
  );
}
