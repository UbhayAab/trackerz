export const COST_MODEL = {
  geminiFlashLiteImageInputPerMillion: 0.25,
  geminiFlashLiteAudioInputPerMillion: 0.50,
  geminiFlashLiteOutputPerMillion: 1.50,
  deepseekProInputPerMillion: 0.435,
  deepseekProOutputPerMillion: 0.87,
  geminiHighImageTokens: 1120,
  audioTokensPerSecond: 32,
};

export function normalizeMerchant(value = "") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(pvt|ltd|limited|upi|payments|india)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAmount(value) {
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? Math.abs(Number(number.toFixed(2))) : null;
}

export function dateDistanceDays(a, b) {
  const left = new Date(a);
  const right = new Date(b);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return Infinity;
  return Math.abs(left.getTime() - right.getTime()) / 86_400_000;
}

export function scoreExpenseDuplicate(a, b) {
  let score = 0;
  const reasons = [];

  const amountA = normalizeAmount(a.amount);
  const amountB = normalizeAmount(b.amount);
  if (amountA !== null && amountB !== null && Math.abs(amountA - amountB) <= 1) {
    score += 0.38;
    reasons.push("amount");
  }

  const days = dateDistanceDays(a.occurredAt, b.occurredAt);
  if (days <= 0.1) {
    score += 0.24;
    reasons.push("same_time_window");
  } else if (days <= 1) {
    score += 0.14;
    reasons.push("near_date");
  }

  const merchantA = normalizeMerchant(a.merchant || a.description || "");
  const merchantB = normalizeMerchant(b.merchant || b.description || "");
  if (merchantA && merchantB && (merchantA.includes(merchantB) || merchantB.includes(merchantA))) {
    score += 0.24;
    reasons.push("merchant");
  }

  if (a.reference && b.reference && a.reference === b.reference) {
    score += 0.30;
    reasons.push("reference");
  }

  if (a.direction && b.direction && a.direction === b.direction) {
    score += 0.08;
    reasons.push("direction");
  }

  const hasHardLink = reasons.includes("reference") || reasons.includes("same_time_window");

  return {
    score: Math.min(1, Number(score.toFixed(4))),
    isDuplicate: score >= 0.72 && hasHardLink,
    reasons,
  };
}

export function estimateMonthlyAiCost({ imagesPerDay, voiceMinutesPerDay, agentEventsPerDay }) {
  const imageTokens = imagesPerDay * COST_MODEL.geminiHighImageTokens;
  const audioTokens = voiceMinutesPerDay * 60 * COST_MODEL.audioTokensPerSecond;
  const geminiOutputTokens = imagesPerDay * 350 + voiceMinutesPerDay * 250;
  const deepseekInputTokens = agentEventsPerDay * 1800;
  const deepseekOutputTokens = agentEventsPerDay * 500;

  const dailyGemini =
    (imageTokens / 1_000_000) * COST_MODEL.geminiFlashLiteImageInputPerMillion +
    (audioTokens / 1_000_000) * COST_MODEL.geminiFlashLiteAudioInputPerMillion +
    (geminiOutputTokens / 1_000_000) * COST_MODEL.geminiFlashLiteOutputPerMillion;

  const dailyDeepseek =
    (deepseekInputTokens / 1_000_000) * COST_MODEL.deepseekProInputPerMillion +
    (deepseekOutputTokens / 1_000_000) * COST_MODEL.deepseekProOutputPerMillion;

  return {
    monthlyGemini: Number((dailyGemini * 30).toFixed(4)),
    monthlyDeepseek: Number((dailyDeepseek * 30).toFixed(4)),
    monthlyTotal: Number(((dailyGemini + dailyDeepseek) * 30).toFixed(4)),
  };
}

export function classifyImportColumns(headers) {
  const normalized = headers.map((header) => normalizeMerchant(header));
  const find = (candidates) =>
    headers[
      normalized.findIndex((header) =>
        candidates.some((candidate) => header.includes(candidate)),
      )
    ] ?? null;

  return {
    date: find(["date", "txn date", "transaction date", "value date", "posted"]),
    description: find(["description", "narration", "particular", "remark", "merchant"]),
    debit: find(["debit", "withdrawal", "paid out", "dr"]),
    credit: find(["credit", "deposit", "paid in", "cr"]),
    amount: find(["amount", "transaction amount"]),
    balance: find(["balance", "closing balance", "running balance"]),
    reference: find(["reference", "utr", "upi", "transaction id", "cheque"]),
  };
}

export function classifyCaptureInput({ text = "", files = [] }) {
  const lower = text.toLowerCase();
  const fileKinds = files.map((file) => file.kind || file.type || file.name || "").join(" ").toLowerCase();

  if (/\b(xls|xlsx|csv|statement|bank|credit card|pdf)\b/.test(fileKinds) || /\bstatement|excel|csv|bank export|monthly dump|month end\b/.test(lower)) {
    return "file_import";
  }

  if (/\b(spent|paid|rs|inr|upi|gpay|phonepe|paytm|debit|credit|refund|zomato|swiggy|fuel|petrol|amazon|uber|ola|blinkit|zepto)\b/.test(lower)) {
    return "money";
  }

  if (/\b(ate|breakfast|lunch|dinner|protein|calorie|roti|dal|rice|paneer|egg|chicken)\b/.test(lower)) {
    return "diet";
  }

  if (/\b(steps|walk|workout|gym|bench|squat|weight|kg|sleep|mood|stress|energy)\b/.test(lower)) {
    return "wellness";
  }

  if (files.length > 0) {
    return "media_review";
  }

  return "general_note";
}

export function routeModelForCapture({ captureType, risk = "normal" }) {
  if (captureType === "file_import") {
    return {
      mediaModel: "deterministic-parser-plus-ocr",
      brainModel: "deepseek-ai/deepseek-v4-pro",
      reason: "Imports need deterministic extraction, AI column mapping, and strict dedupe.",
    };
  }

  if (captureType === "media_review") {
    return {
      mediaModel: risk === "high" ? "gemini-2.5-pro" : "gemini-2.5-flash",
      brainModel: "deepseek-ai/deepseek-v4-pro",
      reason: "Images/audio need multimodal extraction before DeepSeek tool planning.",
    };
  }

  return {
    mediaModel: null,
    brainModel: "deepseek-ai/deepseek-v4-pro",
    reason: "Text can go straight to the reasoning and tool-call layer.",
  };
}

export function validateToolAction(action) {
  const allowed = new Set([
    "create_expense_candidate",
    "create_income_candidate",
    "create_transfer_candidate",
    "create_statement_row_candidate",
    "create_food_log_candidate",
    "create_workout_log_candidate",
    "create_body_metric_candidate",
    "create_wellness_note_candidate",
    "link_duplicate_candidates",
    "request_user_review",
    "apply_verified_action",
  ]);

  const errors = [];
  if (!allowed.has(action.name)) errors.push("unknown_tool");
  if (!action.arguments || typeof action.arguments !== "object") errors.push("missing_arguments");
  if (typeof action.confidence !== "number" || action.confidence < 0 || action.confidence > 1) errors.push("bad_confidence");
  if (/delete|drop|truncate/i.test(action.name)) errors.push("destructive_tool_blocked");
  if (action.confidence < 0.72 && action.name !== "request_user_review") errors.push("low_confidence_must_review");

  return {
    ok: errors.length === 0,
    errors,
  };
}
