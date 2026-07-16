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
  generateMultiAlerts,
  formatAlertMessage,
  type TradeAlert,
  type OptionChainRow,
  type IndexChainData,
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
  // Multi-symbol data: option chains for all 5 indices (NIFTY, BANKNIFTY,
  // FINNIFTY, MIDCPNIFTY, SENSEX) so the handler can pick the best 2-3
  // trades instead of always returning the requested symbol.
  allChains?: IndexChainData[];
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
  fiiDiiLookup?: () => Promise<{
    fiiNet: number | null; diiNet: number | null; totalNet: number | null;
    regime: string | null; asOf: string | null; stale: boolean;
  } | null>;
  gapPredictionLookup?: () => Promise<{
    prediction: "UP" | "DOWN" | "FLAT";
    probability: number;
    confidence: number;
    bullScore: number;
    bearScore: number;
    factors: { name: string; score: number; weightedScore: number; dataStatus: string; explanation: string }[];
    insufficientData: boolean;
  } | null>;
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
  const moodDesc = n.score >= 75 ? "greed — be cautious, crowded trades reverse fast" :
                   n.score >= 60 ? "optimism — healthy, but watch for complacency" :
                   n.score >= 40 ? "neutral — no extreme positioning" :
                   n.score >= 25 ? "fear — often creates the best entry points" :
                   "extreme fear — historically, these are buying zones";

  if (lang === "hi") {
    const lines = [
      `बाज़ार का मूड: ${n.mood} (${n.score}/100) — ${n.score >= 60 ? "सावधानी ज़रूरी है, भीड़ में मत चलो" : "डर में मौके छिपे हैं"}`,
      ``,
      `जहाँ पैसा जा रहा है: ${n.topBullish.join(", ") || "—"}`,
      `जहाँ से पैसा निकल रहा है: ${n.topBearish.join(", ") || "—"}`,
      ``,
      `अहम ख़बरें:`,
      ...n.headlines.slice(0, 4).map((h) => `• [${h.sentiment}] ${h.title}`),
      ``,
      `तीस साल का अनुभव कहता है: खबरों के पीछे मत भागो — देखो बड़ा पैसा क्या कर रहा है। जब खबरें बहुत बुलिश हों, तो समझो मुनाफ़ा बुक करने का वक़्त आ गया।`,
    ];
    return lines.join("\n");
  }
  const lines = [
    `Here's the market picture I'm seeing right now:`,
    ``,
    `Mood: ${n.mood} (${n.score}/100) — ${moodDesc}.`,
    ``,
    `Where the smart money is flowing:`,
    `  Buying: ${n.topBullish.join(", ") || "—"}`,
    `  Selling: ${n.topBearish.join(", ") || "—"}`,
    ``,
    `Headlines that matter:`,
    ...n.headlines.slice(0, 4).map((h) => `  • [${h.sentiment}] ${h.title}`),
    ``,
    `What I've learned watching this for 29 years: don't trade the news — trade the reaction to the news. By the time a headline hits your screen, the professionals have already positioned. Watch what price DOES after the news, not the news itself. If good news can't push the market higher, that tells you everything you need to know.`,
  ];
  return lines.join("\n");
}

function formatGap(g: GapInfo, lang: "en" | "hi"): string {
  if (!g.available) {
    return lang === "hi"
      ? "गैप डेटा अभी नहीं आया — मार्केट बंद है। कल सुबह 8:30 बजे के बाद देखियेगा, तब गिफ़्ट निफ़्टी में लिक्विडिटी आती है।"
      : "Gap data isn't available yet — the market is closed. Check after 8:30 AM when Gift Nifty liquidity picks up.";
  }
  const dir = (g.changePct ?? 0) > 0 ? (lang === "hi" ? "गैप ऊप" : "GAP UP") : (g.changePct ?? 0) < 0 ? (lang === "hi" ? "गैप डाउन" : "GAP DOWN") : (lang === "hi" ? "फ्लैट" : "FLAT");
  const sign = (g.change ?? 0) >= 0 ? "+" : "";
  const pctSign = (g.changePct ?? 0) >= 0 ? "+" : "";

  if (lang === "hi") {
    return [
      `गिफ़्ट निफ़्टी क्या कह रहा है:`,
      ``,
      `${fmt(g.price ?? 0)} (${sign}${fmt(g.change ?? 0)} / ${pctSign}${fmt(g.changePct ?? 0)}%)`,
      `कल का क्लोज़: ${fmt(g.previousClose ?? 0)}`,
      ``,
      `${dir} ओपन का संकेत है।`,
      ``,
      `29 साल में ये सीखा है: गैप हमेशा होल्ड नहीं होता। पहले 15-30 मिनट में मार्केट टेस्ट करता है कि गैप वैलिड है या नहीं। जल्दीबाज़ी में मत लीजिये — पहली घंटी के बाद 30 मिनट ज़रूर रुकिये। असली दिशा 10 बजे के बाद पता चलती है।`,
    ].join("\n");
  }
  return [
    `Here's what Gift Nifty is telling us about tomorrow's open:`,
    ``,
    `Gift Nifty: ${fmt(g.price ?? 0)} (${sign}${fmt(g.change ?? 0)} pts / ${pctSign}${fmt(g.changePct ?? 0)}%)`,
    `Previous close: ${fmt(g.previousClose ?? 0)}`,
    ``,
    `This points to a ${dir} open.`,
    ``,
    `Here's what 29 years has taught me about gaps: they fill more often than they hold. The first 30 minutes of the session is the market's way of testing whether the gap is real or just noise. Don't chase the open. Let the auction settle — watch what happens at the 10:00 AM mark. If the gap holds with volume confirming, then you can act. If it starts fading, the opening range gives you the real levels for the day.`,
    ``,
    `${(g.changePct ?? 0) > 0 ? "In a gap-up, the professionals are usually selling into strength. Be patient and wait for your entry — don't get caught in the opening auction frenzy." : (g.changePct ?? 0) < 0 ? "In a gap-down, the professionals are usually waiting to buy into weakness. Let the initial panic subside before you act." : "With no significant gap, the overnight session didn't give us a clear edge. Focus on the opening range — the real levels for the day get established in the first 30 minutes."}`,
  ].join("\n");
}
function formatCorrelation(c: CorrInfo, lang: "en" | "hi"): string {
  if (lang === "hi") {
    return [
      `निफ़्टी और सेंसेक्स का रिश्ता:`,
      ``,
      `कोरिलेशन: ${c.overall.toFixed(3)} (पिछले 5 दिन: ${c.last5d.toFixed(3)})`,
      `बीटा: ${c.beta.toFixed(2)} — मतलब जब निफ़्टी 1% चलता है, सेंसेक्स ${(c.beta * 100).toFixed(1)}% चलता है`,
      ``,
      `संकेत: ${c.signal}`,
      `क्यों: ${c.reason}`,
      `क्या करें: ${c.tip}`,
      ``,
      `निफ़्टी: ${fmt(c.niftyPrice)} | सेंसेक्स: ${fmt(c.sensexPrice)}`,
      ``,
      `तीस साल का तजुर्बा बताता है: जब निफ़्टी और सेंसेक्स में डाइवर्जेंस हो, तो आमतौर पर निफ़्टी सही होता है — सेंसेक्स उसका पीछा करता है। अगर कोरिलेशन टूट रहा है, तो मार्केट में कोई बुनियादी बदलाव हो रहा है, उसे नज़रअंदाज़ मत कीजिये।`,
    ].join("\n");
  }
  const corrDesc = c.overall > 0.95 ? "extremely tight — the two indices are moving almost in lockstep, which is normal for a bull phase" :
                   c.overall > 0.8 ? "strong — they generally agree on direction" :
                   c.overall > 0.5 ? "moderate — some divergence worth watching" :
                   "breaking down — this is unusual and signals a regime shift";

  const divergenceNote = Math.abs(c.last5d - c.overall) > 0.05
    ? `What catches my eye: the 5-day correlation (${c.last5d.toFixed(3)}) has diverged from the long-term (${c.overall.toFixed(3)}). In my experience, this kind of short-term break often precedes a catch-up move — either Sensex accelerates or Nifty slows down. Watch for which one leads.`
    : `Both indices are moving in sync, which tells me there's no hidden sector rotation creating arbitrage. Clean, directional market.`;

  return [
    `Here's what the Nifty-Sensex relationship is telling me:`,
    ``,
    `Correlation: ${c.overall.toFixed(3)} (last 5 days: ${c.last5d.toFixed(3)}) — ${corrDesc}.`,
    `Beta: ${c.beta.toFixed(2)} — when Nifty moves 1%, Sensex moves ${(c.beta * 100).toFixed(1)}% on average.`,
    ``,
    `Signal: ${c.signal}`,
    `Why: ${c.reason}`,
    `What this means for you: ${c.tip}`,
    ``,
    `Nifty: ${fmt(c.niftyPrice)} | Sensex: ${fmt(c.sensexPrice)}`,
    ``,
    `${divergenceNote}`,
    ``,
    `One thing I've learned in 29 years: correlation is a snapshot, not a prediction. When it breaks, pay attention — a divergence between Nifty and Sensex usually means money is rotating between large-caps and the broader market. That's a signal in itself.`,
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
        text: "सचिन जी, नमस्ते। मैं 29 सालों से भारतीय बाज़ार देख रहा हूँ — Harshad Mehta के ज़माने से लेकर आज तक। मैं सिर्फ़ नंबर नहीं देता, बताता हूँ कि उनका मतलब क्या है। निफ़्टी, बैंकनिफ़्टी, फिननिफ़्टी, मिडकैप, सेंसेक्स — किसी का ट्रेड चाहिये? या मार्केट का मूड, गैप, कोरिलेशन देखना है? बताइये।",
      };
    }
    return {
      language,
      intentKind: "greeting",
      text: "Good to see you, Sachin. I've been watching these markets since before online trading existed — 29 years of Nifty openings, budget days, bear markets, bull runs, and everything in between. I don't just give you numbers; I read the tape and tell you what the smart money is doing. I can scan for trades across NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX, give you the broader picture with news and sentiment, analyze the Gift Nifty gap for tomorrow's open, or break down the Nifty-Sensex correlation. What would you like me to look at?",
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

  // ── FII / DII institutional flow ──
  if (intent.kind === "fiidii") {
    const f = await ctx.fiiDiiLookup?.().catch(() => null) ?? null;
    if (!f || (f.fiiNet === null && f.diiNet === null)) {
      return {
        language,
        intentKind: "fiidii",
        text: language === "hi" ? "FII/DII डेटा अभी लोड नहीं हुआ — थोड़ी देर में ट्राई करें।" : "Couldn't load FII/DII flow right now — try again in a moment.",
      };
    }
    const cr = (n: number | null) => (n === null ? "N/A" : `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("en-IN")} Cr`);
    const tone = (n: number | null) => (n === null ? "" : n < 0 ? " 🔴 net selling" : " 🟢 net buying");
    const overall = f.totalNet ?? ((f.fiiNet ?? 0) + (f.diiNet ?? 0));
    const bias = overall < -300 ? "net institutional selling pressure — that's a headwind for bulls"
      : overall > 300 ? "net institutional buying support — tailwind for bulls"
      : "roughly balanced institutional flow";
    if (language === "hi") {
      return {
        language,
        intentKind: "fiidii",
        text: `आज का FII/DII फ्लो (कैश मार्केट):\n\n• FII नेट: ${cr(f.fiiNet)}${tone(f.fiiNet)}\n• DII नेट: ${cr(f.diiNet)}${tone(f.diiNet)}\n• कुल नेट: ${cr(overall)}\n\nरेजिम: ${f.regime ?? "N/A"}\nअपडेट: ${f.asOf ?? ""}${f.stale ? " (पुराना डेटा)" : ""}\n\nमतलब: ${bias}।`,
      };
    }
    return {
      language,
      intentKind: "fiidii",
      text: `Here's today's institutional cash flow (NSE-derived):\n\n• FII Net: ${cr(f.fiiNet)}${tone(f.fiiNet)}\n• DII Net: ${cr(f.diiNet)}${tone(f.diiNet)}\n• Combined Net: ${cr(overall)}\n\nRegime: ${f.regime ?? "N/A"}\nAs of: ${f.asOf ?? ""}${f.stale ? " (stale — last known)" : ""}\n\nRead: ${bias}.`,
    };
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

    // Multi-symbol scan when all-chains data is available.
    // If user asked for a specific symbol, scope the scan to that one.
    const scanChains = target && ctx.allChains
      ? ctx.allChains.filter(c => c.symbol === target)
      : ctx.allChains;
    if (scanChains && scanChains.length >= 1) {
      const alerts = generateMultiAlerts(
        scanChains,
        ctx.newsSentiment,
        ctx.fiiNetCr,
        ctx.diiNetCr
      );

      const isScoped = Boolean(target && ctx.allChains && ctx.allChains.length >= 2);
      const scopeLabel = isScoped ? target : "all indices";

      if (alerts.length === 0) {
        // Fallback: return the best single trade even if low conviction,
        // with an honest note that conviction is low.
        const fallbackAlerts = scanChains
          .map(idx => generateOptionAlert({
            symbol: idx.symbol,
            spot: idx.spot,
            pcr: idx.pcr,
            vix: idx.vix,
            chain: idx.chain,
            newsSentiment: ctx.newsSentiment,
            fiiNetCr: ctx.fiiNetCr,
            diiNetCr: ctx.diiNetCr,
            expiryLabel: idx.expiryLabel,
          }))
          .filter((a): a is TradeAlert => a !== null)
          .sort((a, b) => b.confidence - a.confidence);

        if (fallbackAlerts.length > 0) {
          const best = fallbackAlerts[0];
          const text = language === "hi"
            ? `${scopeLabel} स्कैन किया, लेकिन आज कोई हाई-कॉन्फिडेंस सेटअप नहीं मिला। बाज़ार की तस्वीर साफ़ नहीं है — OI डेटा कमज़ोर है, और न्यूज़ फ़्लो न्यूट्रल है। फिर भी जो सबसे अच्छा दिख रहा है वो ये है — लेकिन साइज़ छोटा रखिये, क्योंकि कन्विक्शन ज़्यादा नहीं है:\n\n${formatAlertMessage(best)}`
            : `I scanned ${scopeLabel}, but nothing with high conviction is forming today. The picture isn't clean — OI data is thin and news flow is neutral. That said, here's the closest thing I found to a setup. Keep the size small — conviction is low:\n\n${formatAlertMessage(best)}`;
          return { language, intentKind: "trade", alert: best, text };
        }

        return {
          language,
          intentKind: "trade",
          text: language === "hi"
            ? `${scopeLabel} स्कैन किया, लेकिन आज कोई सेटअप नहीं मिला। OI बिल्डअप और न्यूज़ फ़्लो कन्फर्म नहीं हो रहे — शायद मार्केट रेंज में है। एक बार और चेक करता हूँ।`
            : `I scanned ${scopeLabel}, but found no actionable setup. OI buildup and news flow aren't aligning cleanly — the market may be in a range. I'll keep watching for a better entry.`,
        };
      }

      // Format multi-trade text
      const lines: string[] = [];
      const introLine = isScoped
        ? (language === "hi" ? `${target} के लिये आज का सेटअप:` : `Here's my read on ${target}:`)
        : (language === "hi"
          ? `आज सभी इंडेक्स स्कैन करने के बाद ये ट्रेड दिख रहे हैं:`
          : `I scanned all 5 indices. Here's what's worth your attention today:`
        );
      lines.push(introLine);
      lines.push(``);

      alerts.forEach((a, i) => {
        const isCall = a.optionType === "CE";
        const dirEmoji = isCall ? "🟢" : "🔴";
        const sideLabel = a.side === "BUY" ? (isCall ? "Bull Call" : "Bull Put") : (isCall ? "Bear Call" : "Bear Put");
        const riskPct = a.entry > 0 ? Math.abs((a.entry - a.sl) / a.entry * 100).toFixed(1) : "—";
        const rewardPct = a.entry > 0 ? Math.abs((a.tp1 - a.entry) / a.entry * 100).toFixed(1) : "—";
        lines.push(`${dirEmoji} **${a.side} ${a.instrument}** — ${a.confidence}% confidence, Grade ${a.confidence >= 80 ? "A" : a.confidence >= 70 ? "B+" : "B"}`);
        lines.push(`   Entry ₹${a.entry.toFixed(2)} • SL ₹${a.sl.toFixed(2)} (${riskPct}% risk)`);
        if (a.tp2 !== a.tp1) {
          lines.push(`   TP1 ₹${a.tp1.toFixed(2)} (${rewardPct}% gain) → TP2 ₹${a.tp2.toFixed(2)}`);
        } else {
          lines.push(`   Target ₹${a.tp1.toFixed(2)} (${rewardPct}% gain)`);
        }
        lines.push(`   R:R 1:${a.rr.toFixed(1)} • ${a.rationale.split("·").map(r => r.trim()).filter(Boolean)[0] || ""}`);
        lines.push(``);
      });

      // Veteran closing note
      lines.push(isScoped
        ? (language === "hi"
          ? `साइज़ छोटा रखिये, स्टॉप का सम्मान कीजिये। ${target} में आज यही दिख रहा है।`
          : `Keep your size in check and respect your stops. That's what I'm seeing in ${target} right now.`
        )
        : (language === "hi"
          ? `ये मेरे टॉप पिक्स हैं। हर ट्रेड में 2% से ज़्यादा रिस्क मत लीजिये। मार्केट आपका इंतज़ार करेगा — धैर्य रखिये।`
          : `Those are my top picks across the board. Remember: risk per trade stays under 2% of capital. The market will wait for you — patience is what separates the professionals from the rest.`
        )
      );

      // Market context footer: FII/DII flow + gap prediction (real data)
      const fii = await ctx.fiiDiiLookup?.().catch(() => null) ?? null;
      const gap = await ctx.gapPredictionLookup?.().catch(() => null) ?? null;
      const foot: string[] = [];
      if (fii && (fii.fiiNet !== null || fii.diiNet !== null)) {
        const cr = (n: number | null) => (n === null ? "N/A" : `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("en-IN")}`);
        foot.push(language === "hi"
          ? `📊 FII/DII: FII ${cr(fii.fiiNet)} | DII ${cr(fii.diiNet)} Cr${fii.regime ? ` · ${fii.regime}` : ""}`
          : `📊 Institutional flow — FII ${cr(fii.fiiNet)} | DII ${cr(fii.diiNet)} Cr${fii.regime ? ` · ${fii.regime}` : ""}`);
      }
      if (gap && !gap.insufficientData) {
        const dir = gap.prediction === "UP" ? (language === "hi" ? "गैप अप" : "Gap Up") : gap.prediction === "DOWN" ? (language === "hi" ? "गैप डाउन" : "Gap Down") : (language === "hi" ? "फ्लैट" : "Flat");
        foot.push(language === "hi"
          ? `🔮 गैप प्रेडिक्शन: ${dir} (${gap.probability}% · कॉन्फिडेंस ${gap.confidence}%)`
          : `🔮 Gap prediction: ${dir} (${gap.probability}% · confidence ${gap.confidence}%)`);
      }
      if (foot.length) lines.push(``, ...foot);

      return {
        language,
        intentKind: "trade",
        alert: alerts[0], // show the top card in the UI
        text: lines.join("\n"),
      };
    }

    // Fallback: single-symbol scan (Telegram / no multi-chain data)
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

    return {
      language,
      intentKind: "trade",
      symbol: target,
      alert,
      text: formatAlertMessage(alert),
    };
  }

  // ── Unknown ──
  return {
    language,
    intentKind: "unknown",
    text: language === "hi"
      ? "मैं निफ़्टी, बैंकनिफ़्टी, फिननिफ़्टी, मिडकैप और सेंसेक्स में ट्रेड बता सकता हूँ। इसके अलावा मार्केट न्यूज़, गिफ़्ट निफ़्टी गैप, और निफ़्टी-सेंसेक्स कोरिलेशन भी देख सकता हूँ। आप क्या जानना चाहेंगे?"
      : "I can help with trades across NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX — plus market news, Gift Nifty gap analysis for tomorrow's open, and Nifty-Sensex correlation. What interests you?",
  };
}
