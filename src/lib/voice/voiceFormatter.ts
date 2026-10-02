// Voice Formatter — structured VoiceEvent → short spoken text.
// Rules (spec §20/§21/§22/§23):
//   - speaks ONLY structured fields; never parses free/LLM text for data
//   - missing data is omitted, never invented
//   - SELL signals spoken as alerts, never as confirmed/approved entries
//   - abbreviations converted to spoken words (CE→Call, SL→Stop loss, …)

export type VoiceEventType =
  | "SYSTEM_START"
  | "SYSTEM_READY"
  | "MARKET_OPEN"
  | "MARKET_CLOSE"
  | "MARKET_BRIEFING"
  | "TRADE_SIGNAL"
  | "TRADE_CONFIRMED"
  | "ENTRY"
  | "TP_HIT"
  | "SL_HIT"
  | "NO_TRADE"
  | "WAIT"
  | "STRONG_BULLISH"
  | "STRONG_BEARISH"
  | "NEWS_ALERT"
  | "VOLATILITY_ALERT"
  | "SYSTEM_WARNING"
  | "SYSTEM_ERROR";

export interface VoiceEvent {
  eventType: VoiceEventType;
  symbol?: string;
  instrument?: string;          // 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY'
  strike?: number;
  optionType?: "CE" | "PE";
  side?: string;                // engine action, e.g. "BUY CE" / "SELL PE" (spoken verbatim only as signal)
  entryPrice?: number;
  stopLoss?: number;
  target?: number;
  targetNumber?: number;        // 1 | 2 | 3 for TP_HIT
  confidence?: number;
  premium?: number;             // current premium (TP_HIT)
  spotPrice?: number;
  trend?: string;               // 'bullish' | 'bearish' | …
  vix?: number;
  pcr?: number;
  chainStatus?: "pending" | "confirmed" | "incomplete";
  reason?: string;              // engine-supplied reason (NO_TRADE / WAIT / alerts)
  headline?: string;            // NEWS_ALERT
  verified?: boolean;           // NEWS_ALERT source confidence
  tradeId?: string;             // used for dedup only — NEVER spoken
  source?: string;
  timestamp: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

function has(n: number | undefined | null): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "NIFTY 24500 Call" / "BANKNIFTY 52000 Put" / "NIFTY futures" / "RELIANCE" */
function optionPhrase(ev: VoiceEvent): string | null {
  if (!ev.symbol) return null;
  const parts = [ev.symbol];
  if (has(ev.strike)) parts.push(fmtNum(ev.strike));
  if (ev.optionType === "CE" || ev.instrument === "CALL") parts.push("Call");
  else if (ev.optionType === "PE" || ev.instrument === "PUT") parts.push("Put");
  else if (ev.instrument === "FUTURES") parts.push("futures");
  return parts.join(" ");
}

/** Spoken-text sanitizer: strips debug artifacts, maps abbreviations, caps length. */
function sanitize(raw: string): string {
  let s = raw;
  s = s.replace(/\{[^}]*\}/g, " ");        // JSON objects
  s = s.replace(/\[[^\]]*\]/g, " ");       // arrays
  s = s.replace(/```[\s\S]*?```/g, " ");   // code blocks
  s = s.replace(/https?:\/\/\S+/g, " ");   // URLs
  s = s.replace(/\/[\w./-]+:\d+/g, " ");   // file.ts:123 paths
  s = s.replace(/\bat\s+\S+\s*\(?[\w.]*\)?/g, " "); // stack frames ("at foo (bar)")
  s = s.replace(/[\u0000-\u001f]+/g, " "); // control chars
  // spoken abbreviations (spec §23)
  s = s.replace(/\bPCR\b/gi, "put-call ratio");
  s = s.replace(/\bOI\b/g, "open interest");
  s = s.replace(/\bSL\b/g, "stop loss");
  s = s.replace(/\bTP[123]?\b/g, "target");
  s = s.replace(/\bCE\b/g, "Call");
  s = s.replace(/\bPE\b/g, "Put");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 160) s = s.slice(0, 157).trimEnd() + "…";
  return s;
}

const TP_WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three" };

// ─── Formatter ────────────────────────────────────────────────────

export function formatVoiceEvent(ev: VoiceEvent): string | null {
  const phrase = optionPhrase(ev);
  const conf = has(ev.confidence) ? ` Confluence score ${fmtNum(ev.confidence)} percent.` : "";
  const entry = has(ev.entryPrice) ? ` Entry ${fmtNum(ev.entryPrice)}.` : "";
  const sl = has(ev.stopLoss) ? ` Stop loss ${fmtNum(ev.stopLoss)}.` : "";
  const tp = has(ev.target) ? ` Target ${fmtNum(ev.target)}.` : "";
  const isSell = !!ev.side && /SELL|SHORT/i.test(ev.side);
  // capitalize spoken reason (e.g. "put-call ratio …" → "Put-call ratio …")
  const speakReason = (raw?: string): string | null => {
    if (!raw) return null;
    const r = sanitize(raw);
    if (!r) return null;
    return r.charAt(0).toUpperCase() + r.slice(1);
  };

  switch (ev.eventType) {
    case "TRADE_SIGNAL": {
      if (!phrase) return null;
      return `Alert. ${phrase} detected.${conf}${entry}${sl}${tp}`.trim();
    }

    case "TRADE_CONFIRMED":
    case "ENTRY": {
      if (!phrase) return null;
      // SELL safety: never spoken as a confirmed/approved entry (spec §21)
      if (isSell) return `Alert. ${phrase} signal detected.${conf}${entry}${sl}${tp}`.trim();
      return `Entry confirmed. ${phrase}.${entry}${sl}${tp}`.trim();
    }

    case "TP_HIT": {
      if (!phrase) return null;
      const word = TP_WORDS[ev.targetNumber ?? 1] ?? "one";
      const prem = has(ev.premium) ? ` Current premium ${fmtNum(ev.premium)}.` : "";
      const active = (ev.targetNumber ?? 1) >= 2 ? " Position remains active." : "";
      return `Target ${word} achieved. ${phrase}.${prem}${active}`.trim();
    }

    case "SL_HIT": {
      if (!phrase) return "Stop loss triggered. Position exit required.";
      return `Stop loss triggered. ${phrase}. Position exit required.`;
    }

    case "NO_TRADE": {
      const r = speakReason(ev.reason);
      return r ? `No trade. ${r}` : "No trade.";
    }

    case "WAIT": {
      const r = speakReason(ev.reason);
      return r ? `Standing by. ${r}` : "Standing by.";
    }

    case "STRONG_BULLISH": {
      const where = ev.symbol ? ` ${ev.symbol}` : "";
      return `Strong bullish conditions detected.${where}${conf}`;
    }

    case "STRONG_BEARISH": {
      const where = ev.symbol ? ` ${ev.symbol}` : "";
      return `Strong bearish conditions detected.${where}${conf}`;
    }

    case "NEWS_ALERT": {
      if (ev.verified === false) return "News information is unverified. No action is recommended.";
      const headline = ev.headline ? sanitize(ev.headline) : null;
      if (!headline) return null;
      return `News alert. ${headline}. Market impact assessment is pending.`;
    }

    case "VOLATILITY_ALERT": {
      const r = ev.reason ? ` ${sanitize(ev.reason)}` : "";
      return `Volatility alert.${r}`;
    }

    case "SYSTEM_WARNING": {
      const r = ev.reason ? ` ${sanitize(ev.reason)}` : "";
      return `System warning.${r}`.trim();
    }

    case "SYSTEM_ERROR": {
      const r = ev.reason ? ` ${sanitize(ev.reason)}` : "";
      return `System error.${r}`.trim();
    }

    case "SYSTEM_START":
    case "SYSTEM_READY":
      return "SMDApp systems online. Market intelligence services are ready.";

    case "MARKET_OPEN":
      return "Market open. I am monitoring the market.";

    case "MARKET_CLOSE":
      return "Market closed. Monitoring continues.";

    case "MARKET_BRIEFING": {
      // every value must come from real data (spec §10)
      const spotOk = has(ev.spotPrice) && ev.spotPrice > 0;
      const vix = has(ev.vix);
      const pcr = has(ev.pcr);
      if (!spotOk && !vix && !pcr && !ev.trend) {
        return "Market data is incomplete. I am standing by.";
      }
      const lines: string[] = ["Good morning. SMDApp intelligence systems are online."];
      if (ev.trend && ev.symbol) lines.push(`${ev.symbol} structure is ${sanitize(ev.trend)}.`);
      if (vix) lines.push(`India VIX is ${fmtNum(ev.vix!)}.`);
      if (ev.chainStatus === "pending") lines.push("Option-chain confirmation is pending.");
      else if (ev.chainStatus === "confirmed") lines.push("Option-chain confirmation is complete.");
      else if (ev.chainStatus === "incomplete") lines.push("Option-chain confirmation is incomplete.");
      lines.push("I am monitoring the market.");
      return lines.join(" ");
    }

    default:
      return null;
  }
}
