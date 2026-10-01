// News + sentiment. You said you already hold API keys for a news source
// and for an LLM (Groq/OpenRouter, per your README's llm-client.ts) — this
// file gives you two building blocks instead of picking a vendor for you:
//
//  1. `fetchHeadlines(...)`: generic HTTP fetch against any "articles" style
//     news API (NewsAPI.org, Marketaux, GNews, Finnhub news, etc. all return
//     a similar {title, source, url, publishedAt} shape). Point NEWS_API_URL
//     and NEWS_API_KEY_ENV at whichever one you actually pay for.
//  2. `scoreSentimentWithLlm(...)`: calls YOUR existing llm-client.ts style
//     chat-completion endpoint (pass in the function) to turn headlines into
//     a -100..100 score + notes, instead of a naive keyword count.
//
// Wire one of these (or your own) behind the `NewsSentimentProvider`
// interface from types.ts and pass it into runJarvisCycle.

import type { NewsItem, Instrument } from "./types";

export interface NewsApiConfig {
  /** Full URL template; `{query}` is replaced with the instrument's search term. */
  urlTemplate: string;
  /** Header name/value for auth, e.g. { "X-Api-Key": process.env.NEWS_API_KEY! } */
  headers: Record<string, string>;
  /** Given the raw JSON, map it to NewsItem[]. Differs per vendor. */
  mapResponse: (json: any) => NewsItem[];
}

const SEARCH_TERMS: Record<string, string> = {
  NIFTY: "Nifty OR \"Indian stock market\" OR Sensex OR RBI OR \"Nifty 50\"",
  BANKNIFTY: "\"Bank Nifty\" OR \"Indian banks\" OR RBI OR \"repo rate\"",
  FINNIFTY: "\"Nifty Financial Services\" OR \"Indian financial stocks\"",
};

export async function fetchHeadlines(
  instrument: Instrument,
  cfg: NewsApiConfig,
  limit = 15
): Promise<NewsItem[]> {
  const q = SEARCH_TERMS[instrument] ?? `${instrument} stock India`;
  const url = cfg.urlTemplate.replace("{query}", encodeURIComponent(q));
  const res = await fetch(url, { headers: cfg.headers });
  if (!res.ok) throw new Error(`news fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return cfg.mapResponse(json).slice(0, limit);
}

/** Minimal, dependency-free keyword sentiment as a fallback when the LLM path is down. Not a replacement for it. */
export function naiveKeywordSentiment(headlines: NewsItem[]): { score: number; notes: string[] } {
  const bullish = [
    "rally", "surge", "record high", "beats estimates", "upgrade", "inflow",
    "rate cut", "strong growth", "outperform", "bullish", "gains",
  ];
  const bearish = [
    "crash", "plunge", "sell-off", "selloff", "downgrade", "outflow",
    "rate hike", "slowdown", "recession", "bearish", "losses", "default",
    "war", "conflict", "ban", "tariff", "inflation surge",
  ];
  let hits = 0, total = 0, score = 0;
  const notes: string[] = [];
  for (const h of headlines) {
    const t = (h.title + " " + (h.summary ?? "")).toLowerCase();
    let s = 0;
    for (const w of bullish) if (t.includes(w)) s += 1;
    for (const w of bearish) if (t.includes(w)) s -= 1;
    if (s !== 0) { score += s; hits++; notes.push(`"${h.title}" -> ${s > 0 ? "+" : ""}${s}`); }
    total++;
  }
  const normalised = total ? Math.max(-15, Math.min(15, (score / Math.max(hits, 1)) * 8)) : 0;
  return { score: Math.round(normalised), notes: notes.slice(0, 5) };
}

/**
 * Preferred path: score sentiment with your existing LLM client instead of
 * keyword matching. Pass in a thin wrapper around your llm-client.ts chat
 * call: `(prompt: string) => Promise<string>` returning raw model text.
 */
export async function scoreSentimentWithLlm(
  headlines: NewsItem[],
  callLlm: (prompt: string) => Promise<string>
): Promise<{ score: number; notes: string[] }> {
  if (headlines.length === 0) return { score: 0, notes: ["no headlines"] };
  const list = headlines
    .slice(0, 15)
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title}`)
    .join("\n");
  const prompt = [
    "You are scoring news sentiment for Indian equity index traders (NIFTY/BANKNIFTY).",
    "Score how these headlines, taken together, likely affect the index over the next 1-3 trading sessions.",
    "Return STRICT JSON only, no prose, no markdown fences:",
    '{"score": <integer -15..15, positive = bullish for the index>, "notes": ["short reason", ...max 4]}',
    "Weigh macro/RBI/global-cues headlines heavily; ignore single-stock news unless it is an index heavyweight.",
    "",
    "Headlines:",
    list,
  ].join("\n");
  const raw = await callLlm(prompt);
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const score = Math.max(-15, Math.min(15, Number(parsed.score) || 0));
    const notes: string[] = Array.isArray(parsed.notes) ? parsed.notes.slice(0, 4) : [];
    return { score, notes };
  } catch {
    // LLM didn't return clean JSON -> fall back to keyword scoring rather than guessing a number.
    return naiveKeywordSentiment(headlines);
  }
}
