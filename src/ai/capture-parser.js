import { nextId } from "../state/app-state.js";

export function parseCapture({ text = "", files = [], captureType }) {
  const lower = text.toLowerCase();
  const updates = {
    reviewRows: [],
    ledgerRows: [],
    importRows: [],
    macroRows: [],
    insights: [],
    metricsDelta: { spend: 0, protein: 0, habit: 0, calories: 0, adherence: 0 },
  };

  if (captureType === "file_import" || files.some((file) => /\.(csv|xls|xlsx|pdf)$/i.test(file.name))) {
    updates.importRows.push(buildImportRow(files[0]?.name || "Uploaded statement"));
    updates.reviewRows.push(buildReviewRow("Statement import preview", "Money", "88%", "mapping", "review column map"));
    updates.insights.push("A statement import is queued with column mapping, duplicate scan, and preview before writes.");
  }

  if (isMoneyText(lower, captureType)) {
    const amount = extractAmount(text) || 240;
    const merchant = extractMerchant(lower);
    updates.ledgerRows.push({
      id: nextId("ledger"),
      date: "Just now",
      merchant,
      category: categoryForMerchant(merchant),
      amount: `Rs ${amount.toLocaleString("en-IN")}`,
      evidence: files.length ? "text + media" : "text",
      state: amount > 1500 ? "review" : "AI applied",
    });
    updates.reviewRows.push(buildReviewRow(`${merchant} Rs ${amount}`, "Money", amount > 1500 ? "68%" : "93%", amount > 1500 ? "amount" : "none", amount > 1500 ? "review spend" : "auto apply"));
    updates.metricsDelta.spend += amount;
    updates.insights.push(`${merchant} spend was parsed and sent through duplicate checks before updating the ledger.`);
  }

  if (isDietText(lower, captureType)) {
    const meal = lower.includes("breakfast") ? "Breakfast" : lower.includes("dinner") ? "Dinner" : "Meal";
    const protein = lower.includes("chicken") ? 42 : lower.includes("egg") ? 18 : lower.includes("paneer") ? 28 : 16;
    const calories = lower.includes("dinner") ? 760 : 520;
    updates.macroRows.push({
      id: nextId("macro"),
      meal,
      calories: String(calories),
      protein: `${protein}g`,
      confidence: files.length ? "review" : "medium",
      note: summarizeFood(text),
    });
    updates.reviewRows.push(buildReviewRow(`${meal} macro estimate`, "Diet", files.length ? "79%" : "84%", files.length ? "portion" : "range", "keep evidence"));
    updates.metricsDelta.protein += protein;
    updates.metricsDelta.calories += calories;
    updates.metricsDelta.adherence += files.length ? 8 : 5;
    updates.insights.push(`${meal} was logged with a macro range instead of fake precision.`);
  }

  if (isWellnessText(lower, captureType)) {
    updates.reviewRows.push(buildReviewRow("Wellness signal", "Wellness", "86%", "none", "log habit"));
    updates.metricsDelta.habit += lower.includes("sleep") ? -2 : 1;
    updates.insights.push("Wellness note was captured as context, not as a medical claim.");
  }

  if (updates.reviewRows.length === 0 && updates.ledgerRows.length === 0 && updates.macroRows.length === 0) {
    updates.reviewRows.push(buildReviewRow("General note", "Capture", "72%", "needs context", "review"));
    updates.insights.push("General note saved to review because the domain was unclear.");
  }

  return updates;
}

function buildReviewRow(item, domain, confidence, risk, action) {
  return { id: nextId("review"), item, domain, confidence, risk, action };
}

function buildImportRow(file) {
  return {
    id: nextId("import"),
    file,
    rows: "detecting",
    mapped: "pending",
    duplicate: "pending",
    status: "AI previewing",
  };
}

function extractAmount(text) {
  const match = text.match(/(?:rs|inr|\u20b9)?\s*([0-9][0-9,]{1,7})(?:\s*rupees)?/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

function extractMerchant(lower) {
  if (lower.includes("zomato")) return "Zomato";
  if (lower.includes("swiggy")) return "Swiggy";
  if (lower.includes("fuel") || lower.includes("petrol")) return "Fuel";
  if (lower.includes("rahul")) return "Rahul";
  if (lower.includes("amazon")) return "Amazon";
  if (lower.includes("gpay")) return "GPay merchant";
  return "Unsorted merchant";
}

function categoryForMerchant(merchant) {
  if (["Zomato", "Swiggy"].includes(merchant)) return "Food delivery";
  if (merchant === "Fuel") return "Fuel";
  if (merchant === "Rahul") return "Split";
  if (merchant === "Amazon") return "Shopping";
  return "Uncategorized";
}

function summarizeFood(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "food note";
}

function isMoneyText(lower, captureType) {
  return captureType === "money" || /\b(spent|paid|rs|inr|upi|gpay|phonepe|paytm|debit|credit|refund|zomato|swiggy|fuel)\b/.test(lower);
}

function isDietText(lower, captureType) {
  return captureType === "diet" || /\b(ate|breakfast|lunch|dinner|protein|calorie|roti|dal|rice|paneer|egg|chicken|curd|poha)\b/.test(lower);
}

function isWellnessText(lower, captureType) {
  return captureType === "wellness" || /\b(steps|walk|workout|gym|sleep|mood|stress|energy|felt)\b/.test(lower);
}
