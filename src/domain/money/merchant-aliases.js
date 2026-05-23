// Merges merchant aliases. Two layers:
// 1. Built-in rules for the most common Indian merchants (Zomato, Swiggy,
//    Amazon, Flipkart, Ola, Uber, PhonePe, GPay, Paytm, BigBasket, etc.).
// 2. User-supplied aliases from Supabase table `merchant_aliases`.
//
// The runtime resolver is `resolveMerchant(raw, { userAliases })`. Pure.

const BUILTIN_ALIASES = [
  { canonical: "zomato",    match: /zomato/i },
  { canonical: "swiggy",    match: /swiggy/i },
  { canonical: "amazon",    match: /amazon|amzn|amzon/i },
  { canonical: "flipkart",  match: /flipkart|fkrt/i },
  { canonical: "ola",       match: /\bola\b|olacabs/i },
  { canonical: "uber",      match: /\buber\b/i },
  { canonical: "rapido",    match: /rapido/i },
  { canonical: "phonepe",   match: /phonepe|phone\s*pe/i },
  { canonical: "gpay",      match: /gpay|google\s*pay/i },
  { canonical: "paytm",     match: /paytm/i },
  { canonical: "bigbasket", match: /bigbasket|big\s*basket/i },
  { canonical: "blinkit",   match: /blinkit|grofers/i },
  { canonical: "zepto",     match: /zepto/i },
  { canonical: "swiggyinstamart", match: /instamart/i },
  { canonical: "dunzo",     match: /dunzo/i },
  { canonical: "netflix",   match: /netflix/i },
  { canonical: "youtube",   match: /youtube\s*premium|yt\s*premium/i },
  { canonical: "spotify",   match: /spotify/i },
  { canonical: "primevideo", match: /prime\s*video|amazon\s*prime/i },
  { canonical: "hotstar",   match: /hotstar|disney\+/i },
  { canonical: "airbnb",    match: /airbnb/i },
  { canonical: "makemytrip", match: /makemytrip|mmt/i },
  { canonical: "ireland",   match: /ireland/i },
  { canonical: "irctc",     match: /irctc/i },
  { canonical: "bookmyshow", match: /bookmyshow|bms/i },
  { canonical: "starbucks", match: /starbucks/i },
  { canonical: "mcdonalds", match: /mcdonald|mc\s*d\b/i },
  { canonical: "kfc",       match: /\bkfc\b/i },
  { canonical: "dominos",   match: /dominos|domino's/i },
  { canonical: "indianoil", match: /indian\s*oil|iocl/i },
  { canonical: "hpcl",      match: /\bhpcl\b|hindustan\s*petroleum/i },
  { canonical: "bpcl",      match: /\bbpcl\b|bharat\s*petroleum/i },
  { canonical: "shell",     match: /shell\s*ind|shell\s*pet/i },
  { canonical: "tatapower", match: /tata\s*power/i },
  { canonical: "adanielectricity", match: /adani\s*electric/i },
  { canonical: "bsnl",      match: /\bbsnl\b/i },
  { canonical: "airtel",    match: /airtel/i },
  { canonical: "jio",       match: /\bjio\b|reliance\s*jio/i },
  { canonical: "vi",        match: /\bvi\s*postpaid|vodafone\s*idea/i },
];

function clean(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/upi-?/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(pvt|ltd|limited|payments|india|inc|corp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveMerchant(raw, { userAliases = [] } = {}) {
  if (!raw) return { canonical: null, source: "none" };
  const cleaned = clean(raw);
  for (const alias of userAliases) {
    if (alias.alias && cleaned.includes(clean(alias.alias))) {
      return { canonical: alias.canonical, source: "user" };
    }
  }
  for (const rule of BUILTIN_ALIASES) {
    if (rule.match.test(raw) || rule.match.test(cleaned)) {
      return { canonical: rule.canonical, source: "builtin" };
    }
  }
  return { canonical: cleaned, source: "fallback" };
}

export const builtinAliasList = BUILTIN_ALIASES.map((r) => r.canonical);
