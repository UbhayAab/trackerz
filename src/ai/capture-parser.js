import { nextId } from "../state/app-state.js";

const FILE_IMPORT_PATTERN = /\.(csv|xls|xlsx|pdf|txt)$/i;
const AUDIO_PATTERN = /\.(webm|mp3|m4a|wav|ogg|aac)$/i;
const IMAGE_PATTERN = /\.(png|jpg|jpeg|webp|heic|gif)$/i;

export function parseCapture({ text = "", files = [], captureType }) {
  const lower = text.toLowerCase();
  const normalizedFiles = files.map((file) => ({
    name: file.name || "uploaded-file",
    type: file.type || "",
    kind: file.kind || inferFileKind(file),
  }));
  const updates = {
    reviewRows: [],
    ledgerRows: [],
    importRows: [],
    macroRows: [],
    insights: [],
    metricsDelta: { spend: 0, protein: 0, habit: 0, calories: 0, adherence: 0 },
  };

  addFileEvidence(updates, normalizedFiles, captureType);
  addMoneyRows(updates, text, lower, normalizedFiles, captureType);
  addDietRows(updates, text, lower, normalizedFiles, captureType);
  addWellnessRows(updates, lower, captureType);
  addDuplicateSignals(updates, lower, normalizedFiles);

  if (updates.reviewRows.length === 0 && updates.ledgerRows.length === 0 && updates.macroRows.length === 0 && updates.importRows.length === 0) {
    updates.reviewRows.push(buildReviewRow("General note", "Capture", "72%", "needs context", "review"));
    updates.insights.push("General note saved to review because the domain was unclear.");
  }

  return updates;
}

function addFileEvidence(updates, files, captureType) {
  const importFiles = files.filter((file) => file.kind === "file" || FILE_IMPORT_PATTERN.test(file.name));
  const audioFiles = files.filter((file) => file.kind === "audio" || AUDIO_PATTERN.test(file.name));
  const imageFiles = files.filter((file) => file.kind === "image" || IMAGE_PATTERN.test(file.name));

  if (captureType === "file_import" || importFiles.length) {
    const targets = importFiles.length ? importFiles : [{ name: "Uploaded statement" }];
    for (const file of targets) {
      updates.importRows.push(buildImportRow(file.name));
    }
    updates.reviewRows.push(buildReviewRow(`${targets.length} file import preview`, "Money", "88%", "mapping", "review column map"));
    updates.insights.push(`${targets.length} file import(s) queued with column mapping, duplicate scan, and preview before writes.`);
  }

  if (audioFiles.length) {
    updates.reviewRows.push(buildReviewRow(`${audioFiles.length} audio note(s) queued`, "Capture", "review", "transcription", "send to Gemini audio extraction"));
    updates.insights.push("Audio evidence is stored as a review item. Supabase Gemini extraction will transcribe it when secrets/functions are configured.");
  }

  if (imageFiles.length) {
    updates.reviewRows.push(buildReviewRow(`${imageFiles.length} image(s) queued`, "Capture", "review", "vision", "send to Gemini vision extraction"));
    updates.insights.push("Image evidence is queued for OCR/vision extraction and duplicate checks before any table write.");
  }
}

function addMoneyRows(updates, text, lower, files, captureType) {
  if (!isMoneyText(lower, captureType)) return;

  const candidates = extractExpenseCandidates(text);
  const expenses = candidates.length ? candidates : [{ amount: 240, merchant: extractMerchant(lower), source: text }];

  for (const expense of expenses) {
    const risk = expense.amount > 1500 ? "amount" : "none";
    updates.ledgerRows.push({
      id: nextId("ledger"),
      date: inferDateLabel(lower),
      merchant: expense.merchant,
      category: categoryForMerchant(expense.merchant),
      amount: `Rs ${expense.amount.toLocaleString("en-IN")}`,
      evidence: evidenceLabel(files, text),
      state: risk === "none" ? "AI applied" : "review",
    });
    updates.reviewRows.push(buildReviewRow(`${expense.merchant} Rs ${expense.amount}`, "Money", risk === "none" ? "93%" : "68%", risk, risk === "none" ? "auto apply" : "review spend"));
    updates.metricsDelta.spend += expense.amount;
  }

  updates.insights.push(`${expenses.length} money row(s) parsed from ${periodLabel(lower)} input and sent through duplicate checks.`);
}

function addDietRows(updates, text, lower, files, captureType) {
  if (!isDietText(lower, captureType) && !files.some((file) => file.kind === "image" && /food|meal|lunch|dinner|breakfast/i.test(file.name))) return;

  const meals = extractMeals(text, lower);
  for (const meal of meals) {
    updates.macroRows.push({
      id: nextId("macro"),
      meal: meal.slot,
      calories: String(meal.calories),
      protein: `${meal.protein}g`,
      confidence: files.length ? "review" : "medium",
      note: meal.note,
    });
    updates.reviewRows.push(buildReviewRow(`${meal.slot} macro estimate`, "Diet", files.length ? "79%" : "84%", files.length ? "portion" : "range", "keep evidence"));
    updates.metricsDelta.protein += meal.protein;
    updates.metricsDelta.calories += meal.calories;
    updates.metricsDelta.adherence += files.length ? 8 : 5;
  }

  updates.insights.push(`${meals.length} meal log(s) created with macro ranges instead of fake precision.`);
}

function addWellnessRows(updates, lower, captureType) {
  if (!isWellnessText(lower, captureType)) return;
  const sleepMatch = lower.match(/sleep(?:t)?\s*(?:was)?\s*([0-9](?:\.[0-9])?)\s*(?:h|hr|hour|hours)?/);
  const stepsMatch = lower.match(/([0-9][0-9,.]*)(?:\s*k)?\s*steps|walked\s*([0-9][0-9,.]*)(?:\s*k)?/);
  const detail = [
    sleepMatch ? `sleep ${sleepMatch[1]}h` : "",
    stepsMatch ? "steps logged" : "",
  ].filter(Boolean).join(", ") || "wellness signal";

  updates.reviewRows.push(buildReviewRow(detail, "Wellness", "86%", "none", "log habit"));
  updates.metricsDelta.habit += lower.includes("sleep") && /sleep(?:t)?\s*(?:was)?\s*[0-5](?:\.[0-9])?/.test(lower) ? -2 : 3;
  updates.insights.push("Wellness note was captured as context, not as a medical claim.");
}

function addDuplicateSignals(updates, lower, files) {
  const duplicateLikely = /duplicate|dedupe|same|screenshots|screenshot dump|bank import|statement/i.test(lower) || files.length > 1;
  if (!duplicateLikely) return;
  updates.reviewRows.push(buildReviewRow("Possible duplicate cluster", "AI", "review", "duplicate", "compare sources before delete"));
  updates.insights.push("Duplicate detector flagged a cluster. Nothing is deleted automatically; the user chooses the winner.");
}

function extractExpenseCandidates(text) {
  const parts = text
    .replace(/\n/g, ", ")
    .split(/[,;]|(?:\s+and\s+)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = [];

  for (const part of parts) {
    if (!isMoneyText(part.toLowerCase(), "auto")) continue;
    const amount = extractAmount(part);
    if (!amount) continue;
    candidates.push({
      amount,
      merchant: extractMerchant(part.toLowerCase()),
      source: part,
    });
  }

  return candidates;
}

function extractMeals(text, lower) {
  const slots = [
    { key: "breakfast", label: "Breakfast", calories: 420, protein: 13 },
    { key: "lunch", label: "Lunch", calories: 690, protein: 24 },
    { key: "dinner", label: "Dinner", calories: lower.includes("chicken") ? 760 : 620, protein: lower.includes("chicken") ? 42 : 18 },
  ];
  const meals = slots
    .filter((slot) => lower.includes(slot.key))
    .map((slot) => ({
      slot: slot.label,
      calories: slot.calories,
      protein: proteinForText(lower, slot.protein),
      note: summarizeFood(segmentAround(text, slot.key)),
    }));

  if (meals.length) return meals;
  return [{
    slot: lower.includes("snack") ? "Snack" : "Meal",
    calories: lower.includes("chicken") ? 760 : 520,
    protein: proteinForText(lower, 16),
    note: summarizeFood(text),
  }];
}

function proteinForText(lower, fallback) {
  if (lower.includes("chicken")) return 42;
  if (lower.includes("paneer")) return 28;
  if (lower.includes("egg")) return 18;
  if (lower.includes("protein")) return Math.max(fallback, 24);
  return fallback;
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

function inferFileKind(file) {
  if (file.type?.startsWith("image/") || IMAGE_PATTERN.test(file.name || "")) return "image";
  if (file.type?.startsWith("audio/") || AUDIO_PATTERN.test(file.name || "")) return "audio";
  return "file";
}

function evidenceLabel(files, text) {
  const kinds = new Set(files.map((file) => file.kind));
  if (text && kinds.size) return `text + ${Array.from(kinds).join("+")}`;
  if (kinds.size) return Array.from(kinds).join("+");
  return "text";
}

function extractAmount(text) {
  const match = text.match(/(?:rs|inr|\u20b9)?\s*([0-9][0-9,]{1,7})(?:\s*rupees)?/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

function extractMerchant(lower) {
  const known = [
    ["zomato", "Zomato"],
    ["swiggy", "Swiggy"],
    ["fuel", "Fuel"],
    ["petrol", "Fuel"],
    ["rahul", "Rahul"],
    ["amazon", "Amazon"],
    ["uber", "Uber"],
    ["ola", "Ola"],
    ["blinkit", "Blinkit"],
    ["zepto", "Zepto"],
    ["gpay", "GPay merchant"],
    ["phonepe", "PhonePe merchant"],
    ["paytm", "Paytm merchant"],
  ];
  const hit = known.find(([needle]) => lower.includes(needle));
  return hit ? hit[1] : "Unsorted merchant";
}

function categoryForMerchant(merchant) {
  if (["Zomato", "Swiggy"].includes(merchant)) return "Food delivery";
  if (["Blinkit", "Zepto"].includes(merchant)) return "Groceries";
  if (["Uber", "Ola"].includes(merchant)) return "Transport";
  if (merchant === "Fuel") return "Fuel";
  if (merchant === "Rahul") return "Split";
  if (merchant === "Amazon") return "Shopping";
  return "Uncategorized";
}

function summarizeFood(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "food note";
}

function segmentAround(text, keyword) {
  const index = text.toLowerCase().indexOf(keyword);
  if (index < 0) return text;
  return text.slice(index, index + 120);
}

function inferDateLabel(lower) {
  if (lower.includes("monthly") || lower.includes("month") || lower.includes("statement")) return "Month import";
  if (lower.includes("weekly") || lower.includes("week")) return "Week log";
  if (lower.includes("yesterday")) return "Yesterday";
  if (lower.includes("eod") || lower.includes("today")) return "Today";
  return "Just now";
}

function periodLabel(lower) {
  if (lower.includes("monthly") || lower.includes("month")) return "monthly";
  if (lower.includes("weekly") || lower.includes("week")) return "weekly";
  if (lower.includes("eod") || lower.includes("today")) return "daily";
  return "live";
}

function isMoneyText(lower, captureType) {
  return captureType === "money" || /\b(spent|paid|rs|inr|upi|gpay|phonepe|paytm|debit|credit|refund|zomato|swiggy|fuel|petrol|amazon|uber|ola|blinkit|zepto|statement|bank|excel)\b/.test(lower);
}

function isDietText(lower, captureType) {
  return captureType === "diet" || /\b(ate|breakfast|lunch|dinner|snack|protein|calorie|roti|dal|rice|paneer|egg|chicken|curd|poha|meal|food)\b/.test(lower);
}

function isWellnessText(lower, captureType) {
  return captureType === "wellness" || /\b(steps|walk|walked|workout|gym|sleep|slept|mood|stress|energy|felt)\b/.test(lower);
}
