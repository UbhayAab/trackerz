export const reviewRows = [
  { item: "PhonePe Zomato Rs 240", domain: "Money", confidence: "94%", risk: "duplicate", action: "merge with bank row" },
  { item: "Dinner photo + EOD voice", domain: "Diet", confidence: "82%", risk: "portion", action: "keep photo as evidence" },
  { item: "HDFC row UPI-RAHUL", domain: "Money", confidence: "61%", risk: "split", action: "review receivable" },
  { item: "Sleep screenshot", domain: "Wellness", confidence: "91%", risk: "none", action: "auto apply" },
];

export const importRows = [
  { file: "HDFC-May.xlsx", rows: "412", mapped: "98%", duplicate: "63", status: "preview ready" },
  { file: "ICICI-card.pdf", rows: "87", mapped: "91%", duplicate: "12", status: "needs OCR review" },
  { file: "PhonePe screenshots", rows: "38", mapped: "95%", duplicate: "21", status: "clustered" },
];

export const ledgerRows = [
  { date: "Today", merchant: "Zomato", category: "Food delivery", amount: "Rs 240", evidence: "UPI + bank", state: "duplicate winner" },
  { date: "Today", merchant: "Indian Oil", category: "Fuel", amount: "Rs 500", evidence: "GPay", state: "unique" },
  { date: "Yesterday", merchant: "Rahul", category: "Split dinner", amount: "Rs 900", evidence: "text", state: "review" },
  { date: "May", merchant: "Netflix", category: "Subscription", amount: "Rs 649", evidence: "statement", state: "recurring" },
];

export const budgetRows = [
  { category: "Food delivery", spent: "Rs 8,420", pace: "136%", forecast: "Rs 18,400", next: "cap to Rs 240/day" },
  { category: "Fuel", spent: "Rs 3,100", pace: "92%", forecast: "Rs 7,600", next: "on track" },
  { category: "Subscriptions", spent: "Rs 2,487", pace: "101%", forecast: "Rs 2,487", next: "audit annual fees" },
];

export const macroRows = [
  { meal: "Breakfast", calories: "420", protein: "13g", confidence: "medium", note: "poha + chai" },
  { meal: "Lunch", calories: "690", protein: "24g", confidence: "high", note: "3 roti, dal, sabzi, curd" },
  { meal: "Dinner", calories: "760", protein: "42g", confidence: "review", note: "photo + voice duplicate" },
];
