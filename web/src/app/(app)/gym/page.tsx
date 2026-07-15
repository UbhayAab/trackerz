import { ComingSoon } from "@/components/coming-soon";

export default function GymPage() {
  return (
    <ComingSoon
      title="Gym"
      points={[
        "Hevy-style per-set tracker (exercise / reps / weight / RPE)",
        "Auto-check prescribed exercises from a captured workout",
        "Negation-aware: 'didn't go to the gym' never ticks the day",
        "Strength trend + volume-by-muscle + body-recomp charts",
      ]}
    />
  );
}
