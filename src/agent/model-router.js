export function chooseModelRoute({ inputKind, risk = "normal", budgetMode = "balanced" }) {
  if (inputKind === "text") {
    return { extractor: null, brain: "deepseek-ai/deepseek-v4-pro" };
  }

  if (inputKind === "statement") {
    return { extractor: "deterministic-parser", brain: "deepseek-ai/deepseek-v4-pro" };
  }

  if (budgetMode === "cheap" && risk !== "high") {
    return { extractor: "gemini-3.1-flash-lite", brain: "deepseek-ai/deepseek-v4-pro" };
  }

  return {
    extractor: risk === "high" ? "gemini-3.1-pro-preview" : "gemini-3.1-flash-lite",
    brain: "deepseek-ai/deepseek-v4-pro",
  };
}
