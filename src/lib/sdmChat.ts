// lib/sdmChat.ts
//
// SDM's reply logic. Handles trades (all indices), news, gap
// (Gift Nifty), and correlation (Nifty–Sensex) — pulling live
// data through the lookup callbacks in SDMContext. Used by both the
// in-app chat and the Telegram webhook.
//
// Intent resolution is hybrid: a fast regex path (detectIntent) handles
// clear-cut messages for free. When that comes back "unknown", or the
// message looks like a follow-up ("same for banknifty", "kal ka kya"),
// it falls back to an LLM call that reads recent conversation history
// to resolve the real intent + symbol.

import {
  detectIntent,
  generateOptionAlert,
  generateEquityAlert,
  formatAlertMessage,
  type TradeAlert,
  type OptionChainRow,
  type NewsSentiment,
} from "./tradeAlertEngine";

export interface NewsSummary {
  mood: string;            // "Greed", "Fear", ...
  score: number;            // 0-100
  topBullish: string[];
  topBearish: string[];
  headlines: { title: string; sentiment: string }[];
}

export interface GapInfo {
  available: boolean;
  price?: number;
  change?: number;
  changePct?: number;
  previousClose?: number;
  source?: string;
}

export interface CorrInfo {
  overall: number;
  last5d: number;
  beta: number;
  signal: string;
  reason: string;
  tip: string;
  niftyPrice: number;
  sensexPrice: number;
}

// ─── Conversation context ──────────────────────────────────────
export interface ChatTurn {
  role: "user" | "bot";
  text: string;
  intent?: string;   // "trade" | "news" | "gap" | "correlation" | "greeting" | "unknown"
  symbol?: string;    // resolved symbol, if any
}

export interface SDMContext {
  symbol: string;         // currently selected instrument, e.g. "NIFTY 50"
  spot: number;
  pcr: number;
  vix: number;
  chain: OptionChainRow[];
  expiryLabel?: string;
  fiiNetCr?: number;
  diiNetCr?: number;
  newsSentiment: NewsSentiment;
  // For equity fallback when the user asks for a stock trade
  equityLookup?: (symbol: string) => Promise<{
    ltp: number;
    dayChangePct: number;
    avgVolRatio?: number;
    newsSentiment: NewsSentiment;
  } | null>;
  // Live lookups for info intents
  newsLookup?: () => Promise<NewsSummary | null>;
  gapLookup?: () => Promise<GapInfo | null>;
  correlationLookup?: () => Promise<CorrInfo | null>;
  // Conversation memory + hybrid intent resolution
  history?: ChatTurn[]; // last ~6 turns, most recent last
  llmResolve?: (
    message: string,
    history: ChatTurn[]
  ) => Promise<{ kind: string; symbol?: string } | null>;
}

export interface SDMReply {
  text: string;
  alert?: TradeAlert;
  language: "en" | "hi";
  intentKind: string;   // exposed so the caller can log the resolved turn
  symbol?: string;       // resolved symbol, if any — same reason
}

function isHindi(message: string): boolean {
  // crude Devanagari check + common romanized Hindi trading words
  return /[ऀ-ॿ]/.test(message) || /\b(kya|kaisa|batao|acha|kharido|becho|namaste)\b/i.test(message);
}

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ─── Hybrid intent resolution ──────────────────────────────────
const FOLLOWUP_HINTS = /\b(same|iske|isके|uske|isका|that|it|too|also|aur|फिर से|वही|उसी|tomorrow|kal|abhi)\b/i;

function looksLikeFollowUp(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= 5 || FOLLOWUP_HINTS.test(message);
}

async function resolveIntent(
  message: string,
  history: ChatTurn[],
  llmResolve?: SDMContext["llmResolve"]
): Promise<{ kind: string; symbol?: string }> {
  const regexResult = detectIntent(message);

  // Confident regex hit that doesn't look like a bare follow-up — trust it, skip the LLM call.
  if (regexResult.kind !== "unknown" && !looksLikeFollowUp(message)) {
    return regexResult;
  }

  // Ambiguous or follow-up-shaped — try the LLM with recent context, if wired up.
  if (llmResolve) {
    const resolved = await llmResolve(message, history.slice(-6)).catch(() => null);
    if (resolved) {
      // LLM explicitly said "unknown" → don't inherit a stale prior turn.
      if (resolved.kind === "unknown") return { kind: "unknown" };
      // Keep an explicit symbol from the regex if the LLM didn't supply one
      // (e.g. "banknifty trade" with empty history → LLM may omit symbol).
      if (!resolved.symbol && regexResult.symbol) {
        return { kind: resolved.kind, symbol: regexResult.symbol };
      }
      return resolved;
    }
    // LLM unavailable (threw) → fall through to last-turn heuristic below.
  }

  // Last resort (only when no LLM, or it errored): if this reads as a bare
  // follow-up, reuse the last bot turn's intent/symbol.
  if (looksLikeFollowUp(message)) {
    const lastBotTurn = [...history].reverse().find((t) => t.role === "bot" && t.intent);
    if (lastBotTurn) {
      return { kind: lastBotTurn.intent!, symbol: lastBotTurn.symbol ?? regexResult.symbol };
    }
  }

  return regexResult; // give up, return whatever regex said (likely "unknown")
}

// ─── Info formatters ──────────────────────────────────────────
function formatNews(n: NewsSummary, lang: "en" | "hi"): string {
  if (lang === "hi") {
    const lines = [
      `📰 बाज़ार का मूड: ${n.mood} (${n.score}/100)`,
      `टॉप बुलिश: ${n.topBullish.join(", ") || "—"}`,
      `टॉप बियरिश: ${n.topBearish.join(", ") || "—"}`,
      ``,
      `ताज़ा ख़बरें:`,
      ...n.headlines.slice(0, 4).map((h) => `• [${h.sentiment}] ${h.title}`),
    ];
    return lines.join("\n");
  }
  const lines = [
    `📰 Market Mood: ${n.mood} (${n.score}/100)`,
    ``,
    `Top Bullish: ${n.topBullish.join(", ") || "—"}`,
    `Top Bearish: ${n.topBearish.join(", ") || "—"}`,
    ``,
    `Latest headlines:`,
    ...n.headlines.slice(0, 4).map((h) => `• [${h.sentiment}] ${h.title}`),
  ];
  return lines.join("\n");
}

function formatGap(g: GapInfo, lang: "en" | "hi"): string {
  if (!g.available) {
    return lang === "hi"
      ? "📉 गैप डेटा अभी उपलब्ध नहीं है (मार्केट बंद)। मार्केट के समय फिर ट्राई करें।"
      : "📉 Gap data isn't available right now (market closed / Gift Nifty offline). Try during market hours.";
  }
  const dir = (g.changePct ?? 0) > 0 ? (lang === "hi" ? "गैप ऊप" : "GAP UP") : (g.changePct ?? 0) < 0 ? (lang === "hi" ? "गैप डाउन" : "GAP DOWN") : (lang === "hi" ? "फ्लैट" : "FLAT");
  const sign = (g.change ?? 0) >= 0 ? "+" : "";
  const pctSign = (g.changePct ?? 0) >= 0 ? "+" : "";
  if (lang === "hi") {
    return `📈 गिफ़्ट निफ़्टी: ${fmt(g.price ?? 0)} (${sign}${fmt(g.change ?? 0)} पॉइंट / ${pctSign}${fmt(g.changePct ?? 0)}%)\nपिछला क्लोज़ ${fmt(g.previousClose ?? 0)} → ${dir} ओपन का संकेत। (स्रोत: ${g.source})`;
  }
  return `📈 Gift Nifty: ${fmt(g.price ?? 0)} (${sign}${fmt(g.change ?? 0)} pts / ${pctSign}${fmt(g.changePct ?? 0)}%)\nvs prev close ${fmt(g.previousClose ?? 0)} → suggests a ${dir} open. (source: ${g.source})`;
}

function formatCorrelation(c: CorrInfo, lang: "en" | "hi"): string {
  if (lang === "hi") {
    return [
      `🔗 निफ़्टी–सेंसेक्स कोरिलेशन: ${c.overall.toFixed(3)} (पिछले 5 दिन ${c.last5d.toFixed(3)})`,
      `बीटा: ${c.beta.toFixed(2)}`,
      `संकेत: ${c.signal} — ${c.reason}`,
      `टिप: ${c.tip}`,
      `निफ़्टी ${fmt(c.niftyPrice)} | सेंसेक्स ${fmt(c.sensexPrice)}`,
    ].join("\n");
  }
  return [
    `🔗 Nifty–Sensex Correlation: ${c.overall.toFixed(3)} (last 5d ${c.last5d.toFixed(3)})`,
    `Beta: ${c.beta.toFixed(2)}`,
    `Signal: ${c.signal} — ${c.reason}`,
    `Tip: ${c.tip}`,
    `Nifty ${fmt(c.niftyPrice)} | Sensex ${fmt(c.sensexPrice)}`,
  ].join("\n");
}

export async function handleSDMMessage(message: string, ctx: SDMContext): Promise<SDMReply> {
  const language: "en" | "hi" = isHindi(message) ? "hi" : "en";
  const intent = await resolveIntent(message, ctx.history ?? [], ctx.llmResolve);
  const target = intent.symbol ?? ctx.symbol;

  // ── Greeting ──
  if (intent.kind === "greeting") {
    if (language === "hi") {
      return {
        language,
        intentKind: "greeting",
        text: "नमस्ते सचिन! 👋 मैं SDM हूँ। मैं लाइव ट्रेड (निफ़्टी, बैंकनिफ़्टी, फिननिफ़्टी, मिडकैप, सेंसेक्स), न्यूज़, गैप (गिफ़्ट निफ़्टी) और कोरिलेशन बता सकता हूँ। बताओ क्या चाहिये?",
      };
    }
    return {
      language,
      intentKind: "greeting",
      text: "Hey sachin! 👋 I'm SDM. I can pull live **trades** (Nifty, BankNifty, FinNifty, Midcap, Sensex), **news**, **gap** (Gift Nifty) and **correlation** (Nifty–Sensex). What do you want?",
    };
  }

  // ── News / market sentiment ──
  if (intent.kind === "news") {
    const n = await ctx.newsLookup?.().catch(() => null) ?? null;
    if (!n) {
      return {
        language,
        intentKind: "news",
        text: language === "hi" ? "न्यूज़ डेटा लाने में दिक्कत हुई — थोड़ी देर में ट्राई करें।" : "Couldn't fetch news right now — try again in a moment.",
      };
    }
    return { language, intentKind: "news", text: formatNews(n, language) };
  }

  // ── Gap / Gift Nifty ──
  if (intent.kind === "gap") {
    const g = await ctx.gapLookup?.().catch(() => null) ?? null;
    return { language, intentKind: "gap", text: formatGap(g ?? { available: false }, language) };
  }

  // ── Correlation ──
  if (intent.kind === "correlation") {
    const c = await ctx.correlationLookup?.().catch(() => null) ?? null;
    if (!c) {
      return {
        language,
        intentKind: "correlation",
        text: language === "hi" ? "कोरिलेशन डेटा लाने में दिक्कत हुई — थोड़ी देर में ट्राई करें।" : "Couldn't fetch correlation right now — try again in a moment.",
      };
    }
    return { language, intentKind: "correlation", text: formatCorrelation(c, language) };
  }

  // ── Trade (all indices + equity fallback) ──
  if (intent.kind === "trade") {
    const indexNames = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
    // Equity / non-index symbol with no live equity data → say so, don't fake a Nifty trade
    if (intent.symbol && !indexNames.includes(intent.symbol)) {
      if (ctx.equityLookup) {
        const data = await ctx.equityLookup(intent.symbol);
        if (!data) {
          return {
            language,
            intentKind: "trade",
            symbol: intent.symbol,
            text: `Couldn't fetch live data for ${intent.symbol} right now — try again in a moment.`,
          };
        }
        const alert = generateEquityAlert({
          symbol: intent.symbol,
          ltp: data.ltp,
          dayChangePct: data.dayChangePct,
          newsSentiment: data.newsSentiment,
          avgVolRatio: data.avgVolRatio,
        });
        if (!alert) {
          return { language, intentKind: "trade", symbol: intent.symbol, text: `No clean setup on ${intent.symbol} right now.` };
        }
        return { language, intentKind: "trade", symbol: intent.symbol, alert, text: formatAlertMessage(alert) };
      }
      return {
        language,
        intentKind: "trade",
        symbol: intent.symbol,
        text: language === "hi"
          ? `${intent.symbol} के लिये लाइव ऑप्शन डेटा अभी वायर नहीं है — मैं NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX में ट्रेड दे सकता हूँ।`
          : `Live option data for ${intent.symbol} isn't wired yet — I can trade NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX.`,
      };
    }

    const alert = generateOptionAlert({
      symbol: target,
      spot: ctx.spot,
      pcr: ctx.pcr,
      vix: ctx.vix,
      chain: ctx.chain,
      newsSentiment: ctx.newsSentiment,
      fiiNetCr: ctx.fiiNetCr,
      diiNetCr: ctx.diiNetCr,
      expiryLabel: ctx.expiryLabel,
    });

    if (!alert) {
      return {
        language,
        intentKind: "trade",
        symbol: target,
        text: language === "hi"
          ? `अभी ${target} का ऑप्शन चेन डेटा उपलब्ध नहीं है, थोड़ी देर में ट्राई करें।`
          : `Option chain data for ${target} isn't available right now — try again shortly.`,
      };
    }

    const text = language === "hi"
      ? `यह रहा आपका ट्रेड:\n\n${formatAlertMessage(alert)}`
      : `Here's your trade:\n\n${formatAlertMessage(alert)}`;

    return { language, intentKind: "trade", symbol: target, alert, text };
  }

  // ── Unknown ──
  return {
    language,
    intentKind: "unknown",
    text: language === "hi"
      ? "मैं ट्रेड, न्यूज़, गैप और कोरिलेशन बता सकता हूँ। जैसे: \"निफ़्टी का ट्रेड दो\", \"मार्केट न्यूज़ क्या है\", \"गिफ़्ट निफ़्टी गैप\", \"कोरिलेशन सिग्नल\"।"
      : "I can help with trades, news, gap (Gift Nifty) and correlation. Try: \"Nifty trade\", \"market news\", \"Gift Nifty gap\", \"correlation signal\".",
  };
}
