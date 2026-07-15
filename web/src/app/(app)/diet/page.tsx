import { ComingSoon } from "@/components/coming-soon";

export default function DietPage() {
  return (
    <ComingSoon
      title="Diet"
      points={[
        "Date-aware plan with auto check-off from logged meals",
        "Macro gauges (calories / protein / carbs / fat) vs targets",
        "Everyday-food nutrition table overrides model guesses",
        "Eating window, protein gap, late-snack detection",
      ]}
    />
  );
}
