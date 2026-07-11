// lib/tradeAlertEngine.ts
//
// Single source of truth for "give me a trade" style responses —
// used by the in-app SDM chat AND the Telegram bot, so both surfaces
// always say the same thing from the same data.
//
// Wire your real data sources into the three fetch* functions at the
// bottom. Everything above them is pure logic and doesn't care where
// the numbers come from.

export type OptionSide = "CE" | "PE";

export interface OptionChainRow {
  strike: number;
  ce: { ltp: number; oi: number; oiChg: number; iv: number; delta: number; vol: number };
  pe: { ltp: number; oi: number; oiChg: number; iv: number; delta: number; vol: number };
}

export interface TradeAlert {
  id: string;
  kind: "option" | "equity";
  symbol: string;
  side: "BUY" | "SELL";
  instrument: string;       // e.g. "NIFTY 24200 CE" or "RELIANCE"
  strike?: number;
  optionType?: OptionSide;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  rr: 1 | 2 | 3 | 4;
  confidence: number;       // 0-100
  rationale: string;
  expiry?: string;
  generatedAt: string;
}

interface EngineInputs {
  symbol: string;
  spot: number;
  pcr: number;
  vix: number;
  chain: OptionChainRow[];
  newsSentiment: NewsSentiment;
  fiiNetCr?: number;
  diiNetCr?: number;
  expiryLabel?: string;
}

export interface NewsSentiment {
  score: number;          // -1 (very bearish) to +1 (very bullish)
  topHeadline?: string;
  source?: string;
}

// ─── Core scoring: reuse the same bias logic as Gap Analysis so the
// chatbot's "why" lines up with what the Gap Analysis tab shows. ────
function computeBias(inputs: EngineInputs) {
  let score = 0;
  const reasons: string[] = [];

  if (inputs.pcr > 1.2) { score += 12; reasons.push(`PCR ${inputs.pcr.toFixed(2)} favors upside`); }
  else if (inputs.pcr < 0.8) { score -= 12; reasons.push(`PCR ${inputs.pcr.toFixed(2)} favors downside`); }

  if (inputs.newsSentiment.score > 0.2) { score += 15 * inputs.newsSentiment.score; reasons.push(`News flow leaning positive${inputs.newsSentiment.topHeadline ? `: "${inputs.newsSentiment.topHeadline.slice(0, 60)}"` : ""}`); }
  else if (inputs.newsSentiment.score < -0.2) { score += 15 * inputs.newsSentiment.score; reasons.push(`News flow leaning negative${inputs.newsSentiment.topHeadline ? `: "${inputs.newsSentiment.topHeadline.slice(0, 60)}"` : ""}`); }

  const net = (inputs.fiiNetCr ?? 0) + (inputs.diiNetCr ?? 0);
  if (Math.abs(net) > 200) { score += Math.max(-10, Math.min(10, net / 500)); reasons.push(`FII+DII net ₹${net.toFixed(0)} Cr`); }

  // Chain-wide OI buildup, distance-weighted (same approach as Gap Analysis).
  let ceScore = 0, peScore = 0;
  for (const row of inputs.chain) {
    const dist = Math.abs(row.strike - inputs.spot);
    const w = 1 / (1 + dist / (inputs.spot * 0.01));
    ceScore += row.ce.oiChg * w;
    peScore += row.pe.oiChg * w;
  }
  const oiNet = peScore - ceScore;
  const oiMag = Math.abs(ceScore) + Math.abs(peScore) || 1;
  if (Math.abs(oiNet) / oiMag > 0.08) {
    const bullish = oiNet > 0;
    score += bullish ? 10 : -10;
    reasons.push(`Chain-wide OI ${bullish ? "put writing (support building)" : "call writing (resistance building)"}`);
  }

  return { score, bullish: score >= 0, reasons };
}

function nearestStrike(chain: OptionChainRow[], target: number): OptionChainRow {
  return chain.reduce((best, row) =>
    Math.abs(row.strike - target) < Math.abs(best.strike - target) ? row : best
  , chain[0]);
}

// ─── Option trade suggestion ────────────────────────────────────
export function generateOptionAlert(inputs: EngineInputs): TradeAlert | null {
  if (!inputs.chain.length) return null;
  const atm = nearestStrike(inputs.chain, inputs.spot);
  const bias = computeBias(inputs);

  const step = inputs.chain.length > 1
    ? Math.abs(inputs.chain[1].strike - inputs.chain[0].strike)
    : 50;

  const targetStrike = atm.strike + (bias.bullish ? step : -step);
  const row = nearestStrike(inputs.chain, targetStrike);
  const type: OptionSide = bias.bullish ? "CE" : "PE";
  const data = type === "CE" ? row.ce : row.pe;
  const entry = data.ltp;

  const slPct = 0.22;
  const sl = entry * (1 - slPct);
  const rr: 1 | 2 | 3 | 4 = Math.abs(bias.score) > 20 ? 3 : Math.abs(bias.score) > 10 ? 2 : 1;
  const tp1 = entry * (1 + slPct);
  const tp2 = entry * (1 + slPct * rr);
  const confidence = Math.max(50, Math.min(90, 60 + Math.abs(bias.score)));

  return {
    id: `opt-${inputs.symbol}-${Date.now()}`,
    kind: "option",
    symbol: inputs.symbol,
    side: "BUY",
    instrument: `${inputs.symbol} ${row.strike} ${type}`,
    strike: row.strike,
    optionType: type,
    entry, sl, tp1, tp2, rr,
    confidence: Math.round(confidence),
    rationale: bias.reasons.join(" · ") || "Neutral setup — low conviction",
    expiry: inputs.expiryLabel,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Equity swing trade suggestion (simple momentum + news overlay) ──
export function generateEquityAlert(params: {
  symbol: string;
  ltp: number;
  dayChangePct: number;
  newsSentiment: NewsSentiment;
  avgVolRatio?: number; // today's volume / 20-day avg volume
}): TradeAlert | null {
  const { symbol, ltp, dayChangePct, newsSentiment, avgVolRatio = 1 } = params;

  let score = dayChangePct * 5 + newsSentiment.score * 15;
  if (avgVolRatio > 1.5) score += 8; // above-average volume adds conviction
  const bullish = score >= 0;

  const slPct = 0.015; // equities: tighter % than options premium
  const sl = bullish ? ltp * (1 - slPct) : ltp * (1 + slPct);
  const rr: 1 | 2 | 3 | 4 = Math.abs(score) > 20 ? 3 : Math.abs(score) > 10 ? 2 : 1;
  const tp1 = bullish ? ltp * (1 + slPct) : ltp * (1 - slPct);
  const tp2 = bullish ? ltp * (1 + slPct * rr) : ltp * (1 - slPct * rr);
  const confidence = Math.max(50, Math.min(88, 58 + Math.abs(score)));

  const reasons: string[] = [];
  reasons.push(`Day change ${dayChangePct > 0 ? "+" : ""}${dayChangePct.toFixed(2)}%`);
  if (Math.abs(newsSentiment.score) > 0.2) reasons.push(`News ${newsSentiment.score > 0 ? "positive" : "negative"}${newsSentiment.topHeadline ? `: "${newsSentiment.topHeadline.slice(0, 60)}"` : ""}`);
  if (avgVolRatio > 1.5) reasons.push(`Volume ${avgVolRatio.toFixed(1)}x average`);

  return {
    id: `eq-${symbol}-${Date.now()}`,
    kind: "equity",
    symbol,
    side: bullish ? "BUY" : "SELL",
    instrument: symbol,
    entry: ltp, sl, tp1, tp2, rr,
    confidence: Math.round(confidence),
    rationale: reasons.join(" · "),
    generatedAt: new Date().toISOString(),
  };
}

// ─── Formatting: one function, used by both chat UI and Telegram ────
export function formatAlertMessage(alert: TradeAlert, opts?: { markdown?: boolean }): string {
  const b = opts?.markdown ? "*" : "";
  const rrLine = `R:R 1:${alert.rr}`;
  const lines = [
    `${b}${alert.side} ${alert.instrument}${b}  (${alert.confidence}% confidence)`,
    `Entry ₹${alert.entry.toFixed(2)}  •  SL ₹${alert.sl.toFixed(2)}  •  TP1 ₹${alert.tp1.toFixed(2)}  •  TP2 ₹${alert.tp2.toFixed(2)}  •  ${rrLine}`,
    `Why: ${alert.rationale}`,
  ];
  if (alert.expiry) lines.splice(1, 0, `Expiry: ${alert.expiry}`);
  return lines.join("\n");
}

// ─── Intent detection for free-text chat / Telegram messages ────────
// Covers trades (all indices + equities), news, gap (Gift Nifty),
// correlation (Nifty–Sensex), greetings, and unknown.
export type IntentKind =
  | "trade"
  | "news"
  | "gap"
  | "correlation"
  | "greeting"
  | "unknown";

export interface DetectedIntent {
  kind: IntentKind;
  symbol?: string;
  raw: string;
}

const EQUITY_MAP: Record<string, string> = {
  reliance: "RELIANCE", tcs: "TCS", infy: "INFY", infosys: "INFY",
  hdfcbank: "HDFCBANK", icicibank: "ICICIBANK", sbin: "SBIN",
  wipro: "WIPRO", tatamotors: "TATAMOTORS", titan: "TITAN",
  kotak: "KOTAKBANK",
};

function pickSymbol(text: string): string | undefined {
  const idx = text.match(/\b(nifty|banknifty|sensex|finnifty|midcpnifty)\b/);
  if (idx) return idx[0].toUpperCase();
  const eq = text.match(/\b(reliance|tcs|infy|infosys|hdfcbank|icicibank|sbin|wipro|tatamotors|titan|kotak)\b/);
  if (eq) return EQUITY_MAP[eq[0]];
  return undefined;
}

export function detectIntent(message: string): DetectedIntent {
  const text = message.toLowerCase().trim();
  const symbol = pickSymbol(text);

  if (/^(hi|hii|hello|hey|namaste|good\s(morning|evening|afternoon)|kaisa|kya\s*hai)\b/.test(text)) {
    return { kind: "greeting", symbol, raw: text };
  }
  if (/(correlation|correlat|co-?movement|moving together|beta|diverg|drift|spread)/.test(text)) {
    return { kind: "correlation", symbol, raw: text };
  }
  if (/(gap|gift\s*nifty|giftnifty|tomorrow'?s?\s*open|next\s*open|opening\s*(bell|trade)|pre-?market)/.test(text)) {
    return { kind: "gap", symbol, raw: text };
  }
  if (/trade|signal|setup|entry|buy|sell|call|put|alert|option|strike|\bce\b|\bpe\b/.test(text)) {
    return { kind: "trade", symbol, raw: text };
  }
  if (/(news|sentiment|headline|market\s*(mood|analysis|today|now)|how'?s?\s*the\s*market|what'?s?\s*the\s*news)/.test(text)) {
    return { kind: "news", symbol, raw: text };
  }
  return { kind: "unknown", symbol, raw: text };
}

