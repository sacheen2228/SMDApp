// Keyword-based sentiment analyzer for Indian market news.
// Deterministic — same headline always produces same score.
// No Math.random() — pure keyword matching with weighted scoring.

interface SentimentResult {
  score: number;       // -1.0 to +1.0
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;  // 0.0 to 1.0
  eventType: string;
}

// Weighted keywords: [keyword, score_delta]
// Positive = bullish, negative = bearish
// Higher weight = stronger signal
const BULLISH_KEYWORDS: [string, number][] = [
  // Strong bullish (weight 0.3-0.5)
  ["surge", 0.4], ["soar", 0.4], ["rally", 0.35], ["boom", 0.35],
  ["record high", 0.4], ["all-time high", 0.4], ["breakout", 0.3],
  ["massive gain", 0.4], ["skyrocket", 0.4], ["bull run", 0.35],
  ["strong buy", 0.3], ["outperform", 0.25], ["upgrade", 0.25],
  ["beat estimate", 0.3], ["exceed expectation", 0.3], ["better than expected", 0.3],
  ["profit surge", 0.35], ["revenue jump", 0.3], ["bonus issue", 0.25],
  ["stock split", 0.2], ["buyback", 0.25], ["dividend increase", 0.2],

  // Moderate bullish (weight 0.1-0.2)
  ["rise", 0.15], ["gain", 0.15], ["jump", 0.2], ["climb", 0.15],
  ["up", 0.1], ["higher", 0.1], ["positive", 0.15], ["growth", 0.15],
  ["optimistic", 0.2], ["recovery", 0.15], ["rebound", 0.15],
  ["strong", 0.1], ["robust", 0.15], ["solid", 0.1],
  ["fii buy", 0.25], ["dii buy", 0.25], ["institutional buying", 0.25],
  ["foreign inflow", 0.2], ["investment inflow", 0.15],

  // Indian market specific
  ["sebi approval", 0.2], ["rbi pause", 0.15], ["rate cut", 0.25],
  ["gdp growth", 0.15], ["fiscal deficit target", 0.1],
  ["make in india", 0.1], ["atmanirbhar", 0.1], ["production linked", 0.15],
  ["fpi inflow", 0.2], ["mutual fund inflow", 0.15],
];

const BEARISH_KEYWORDS: [string, number][] = [
  // Strong bearish (weight -0.3 to -0.5)
  ["crash", -0.4], ["plummet", -0.4], ["collapse", -0.35], ["tumble", -0.3],
  ["freefall", -0.4], ["meltdown", -0.4], ["bloodbath", -0.4],
  ["circuit down", -0.35], ["lower circuit", -0.35], ["panic sell", -0.35],
  ["strong sell", -0.3], ["underperform", -0.25], ["downgrade", -0.25],
  ["miss estimate", -0.3], ["worse than expected", -0.3], ["below expectation", -0.3],
  ["loss widen", -0.3], ["profit decline", -0.25], ["revenue drop", -0.25],

  // Moderate bearish (weight -0.1 to -0.2)
  ["fall", -0.15], ["drop", -0.15], ["decline", -0.15], ["dip", -0.1],
  ["down", -0.1], ["lower", -0.1], ["negative", -0.15], ["weak", -0.15],
  ["pessimistic", -0.2], ["slump", -0.2], ["correction", -0.1],
  ["fii sell", -0.25], ["dii sell", -0.2], ["institutional selling", -0.25],
  ["foreign outflow", -0.2], ["capital outflow", -0.15],

  // Indian market specific
  ["sebi warning", -0.2], ["rbi rate hike", -0.2], ["inflation rise", -0.15],
  ["gdp slowdown", -0.15], ["recession", -0.25], ["default", -0.3],
  ["bankruptcy", -0.3], ["insolvency", -0.3], ["npa rise", -0.2],
  ["fpi outflow", -0.25], ["mutual fund outflow", -0.15],
  ["trade war", -0.2], ["sanction", -0.2], ["tariff", -0.15],
];

// Event type detection
const EVENT_PATTERNS: [RegExp, string][] = [
  [/rbi|reserve bank|monetary policy|repo rate|interest rate/i, "RBI_POLICY"],
  [/sebi|regulat/i, "REGULATORY"],
  [/budget|fiscal|govt|government|parliament/i, "GOVT_POLICY"],
  [/earnings|quarterly|result|profit|revenue|eps/i, "EARNINGS"],
  [/ipo|initial public|listing/i, "IPO"],
  [/fii|foreign.*investor|fpi|foreign.*portfolio/i, "FII_FLOW"],
  [/dii|domestic.*investor|mutual.*fund/i, "DII_FLOW"],
  [/gdp|inflation|cpi|wpi|economic/i, "MACRO"],
  [/merger|acquisition|buyout|takeover/i, "MNA"],
  [/split|bonus|dividend/i, "CORPORATE_ACTION"],
  [/oil|crude|brent|opec/i, "COMMODITY"],
  [/dollar|usd|inr|rupee|forex|currency/i, "FOREX"],
  [/nifty|sensex|banknifty|finnifty/i, "INDEX"],
];

export function analyzeSentiment(text: string): SentimentResult {
  const lower = text.toLowerCase();
  let score = 0;
  let matches = 0;

  // Score bullish keywords
  for (const [keyword, weight] of BULLISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += weight;
      matches++;
    }
  }

  // Score bearish keywords
  for (const [keyword, weight] of BEARISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += weight; // weight is already negative
      matches++;
    }
  }

  // Negation handling: flip sentiment if negation words precede sentiment words
  const negations = ["not", "no", "never", "neither", "nor", "barely", "hardly", "without", "lack of", "despite"];
  for (const neg of negations) {
    if (lower.includes(neg)) {
      // Reduce score by 30% if negation present (partial flip)
      score *= 0.7;
    }
  }

  // Cap score to [-1, 1]
  score = Math.max(-1, Math.min(1, score));

  // Determine label
  let label: "BULLISH" | "BEARISH" | "NEUTRAL";
  if (score > 0.1) label = "BULLISH";
  else if (score < -0.1) label = "BEARISH";
  else label = "NEUTRAL";

  // Confidence: based on number of keyword matches and score magnitude
  // More matches = higher confidence. Higher absolute score = higher confidence.
  const matchConfidence = Math.min(1, matches / 5); // 5+ matches = max match confidence
  const scoreConfidence = Math.min(1, Math.abs(score) / 0.5); // 0.5+ score = max score confidence
  const confidence = Math.round((matchConfidence * 0.6 + scoreConfidence * 0.4) * 100) / 100;
  // Minimum confidence of 0.3 if any keywords matched, 0.1 if none
  const finalConfidence = matches > 0 ? Math.max(0.3, confidence) : 0.1;

  // Detect event type
  let eventType = "NEWS";
  for (const [pattern, type] of EVENT_PATTERNS) {
    if (pattern.test(text)) {
      eventType = type;
      break;
    }
  }

  return {
    score: Math.round(score * 100) / 100,
    label,
    confidence: finalConfidence,
    eventType,
  };
}

/**
 * Analyze sentiment for multiple headlines and return aggregated result.
 */
export function analyzeHeadlines(headlines: string[]): {
  avgScore: number;
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  avgConfidence: number;
  topEvent: string;
  breakdown: SentimentResult[];
} {
  if (headlines.length === 0) {
    return { avgScore: 0, label: "NEUTRAL", avgConfidence: 0.1, topEvent: "NEWS", breakdown: [] };
  }

  const breakdown = headlines.map(analyzeSentiment);
  const avgScore = Math.round((breakdown.reduce((sum, r) => sum + r.score, 0) / breakdown.length) * 100) / 100;
  const avgConfidence = Math.round((breakdown.reduce((sum, r) => sum + r.confidence, 0) / breakdown.length) * 100) / 100;

  // Most common event type
  const eventCounts: Record<string, number> = {};
  for (const r of breakdown) {
    eventCounts[r.eventType] = (eventCounts[r.eventType] || 0) + 1;
  }
  const topEvent = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "NEWS";

  let label: "BULLISH" | "BEARISH" | "NEUTRAL";
  if (avgScore > 0.1) label = "BULLISH";
  else if (avgScore < -0.1) label = "BEARISH";
  else label = "NEUTRAL";

  return { avgScore, label, avgConfidence, topEvent, breakdown };
}
