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
  atmRead?: string;          // raw ATM Greeks/OI snapshot the engine read from the chain
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

// ─── Core scoring: multi-factor bias detection using live OI, Greeks,
// IV skew, volume, FII/DII flow, and news sentiment. ────
function computeBias(inputs: EngineInputs) {
  let score = 0;
  const reasons: string[] = [];

  // 1. PCR — put-call ratio tells us where option writers are leaning
  if (inputs.pcr > 1.2) { score += 10; reasons.push(`PCR ${inputs.pcr.toFixed(2)} — puts building, support forming`); }
  else if (inputs.pcr < 0.8) { score -= 10; reasons.push(`PCR ${inputs.pcr.toFixed(2)} — calls building, resistance forming`); }

  // 2. VIX regime — volatility tells us the market's fear level
  if (inputs.vix > 28) { score -= 5; reasons.push(`VIX ${inputs.vix.toFixed(1)} — elevated fear, wide stops needed`); }
  else if (inputs.vix > 22) { score -= 2; reasons.push(`VIX ${inputs.vix.toFixed(1)} — moderate volatility`); }
  else if (inputs.vix < 13) { score += 3; reasons.push(`VIX ${inputs.vix.toFixed(1)} — low vol, trending conditions`); }

  // 3. News sentiment — institutional flow via headlines
  if (Math.abs(inputs.newsSentiment.score) > 0.15) {
    const factor = 12 * inputs.newsSentiment.score;
    score += factor;
    reasons.push(`News flow ${factor > 0 ? "positive" : "negative"}${inputs.newsSentiment.topHeadline ? `: "${inputs.newsSentiment.topHeadline.slice(0, 60)}"` : ""}`);
  }

  // 4. FII/DII institutional flow
  const net = (inputs.fiiNetCr ?? 0) + (inputs.diiNetCr ?? 0);
  if (Math.abs(net) > 200) { score += Math.max(-8, Math.min(8, net / 500)); reasons.push(`FII+DII net ₹${net.toFixed(0)} Cr — ${net > 0 ? "institutions buying" : "institutions selling"}`); }

  // 5. Chain-wide OI buildup, distance-weighted
  let ceScore = 0, peScore = 0;
  for (const row of inputs.chain) {
    const dist = Math.abs(row.strike - inputs.spot);
    const w = 1 / (1 + dist / (inputs.spot * 0.01));
    ceScore += row.ce.oiChg * w;
    peScore += row.pe.oiChg * w;
  }
  const oiNet = peScore - ceScore;
  const oiMag = Math.abs(ceScore) + Math.abs(peScore) || 1;
  if (oiMag > 0 && Math.abs(oiNet) / oiMag > 0.05) {
    const bullish = oiNet > 0;
    score += bullish ? 8 : -8;
    reasons.push(`OI weighted ${bullish ? "put accumulation (support zone)" : "call accumulation (resistance zone)"}`);
  }

  // 6. IV skew — implied volatility premium between calls and puts at ATM
  const atmRow = nearestStrike(inputs.chain, inputs.spot);
  if (atmRow && atmRow.ce.iv > 0 && atmRow.pe.iv > 0) {
    const skew = atmRow.ce.iv / atmRow.pe.iv;
    if (skew > 1.12) { score -= 6; reasons.push(`CE IV premium ${(skew - 1) * 100 > 10 ? `${((skew - 1) * 100).toFixed(0)}%` : ""} over PE — call sellers active`); }
    else if (skew < 0.88) { score += 6; reasons.push(`PE IV premium ${((1 / skew - 1) * 100).toFixed(0)}% over CE — put sellers active`); }

    // Delta balance at ATM
    const ceDelta = Math.abs(atmRow.ce.delta || 0);
    const peDelta = Math.abs(atmRow.pe.delta || 0);
    if (ceDelta > 0 && peDelta > 0) {
      const deltaRatio = ceDelta / peDelta;
      if (deltaRatio > 1.5) { score += 4; reasons.push(`Delta skew favors calls (bullish positioning)`); }
      else if (deltaRatio < 0.67) { score -= 4; reasons.push(`Delta skew favors puts (bearish positioning)`); }
    }
  }

  // 7. Volume confirmation at ATM
  if (atmRow) {
    const atmVol = (atmRow.ce.vol || 0) + (atmRow.pe.vol || 0);
    if (atmVol > 50000) { score += 3; reasons.push(`High ATM volume — liquid, reliable contract`); }
    else if (atmVol > 10000) { score += 1; }
  }

  // 8. OI concentration — identify where the most OI sits relative to spot
  if (inputs.chain.length > 2) {
    const sorted = [...inputs.chain].sort((a, b) => (b.ce.oi + b.pe.oi) - (a.ce.oi + a.pe.oi));
    const topStrike = sorted[0];
    if (topStrike) {
      const diff = topStrike.strike - inputs.spot;
      if (diff > inputs.spot * 0.01) { score += 3; reasons.push(`Max OI above spot (₹${topStrike.strike}) — call wall`); }
      else if (diff < -inputs.spot * 0.01) { score -= 3; reasons.push(`Max OI below spot (₹${topStrike.strike}) — put wall`); }
    }
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

  const atmRead = (() => {
    const c = atm.ce, p = atm.pe;
    const parts = [
      `ATM ${atm.strike}`,
      `CE Δ${c.delta.toFixed(2)} IV${(c.iv).toFixed(1)} OI${(c.oi / 1000).toFixed(0)}K Chg${c.oiChg >= 0 ? "+" : ""}${c.oiChg}`,
      `PE Δ${p.delta.toFixed(2)} IV${(p.iv).toFixed(1)} OI${(p.oi / 1000).toFixed(0)}K Chg${p.oiChg >= 0 ? "+" : ""}${p.oiChg}`,
    ];
    return parts.join(" · ");
  })();

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
    atmRead,
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
  const isCall = alert.optionType === "CE";
  const sideLabel = alert.side === "BUY" ? (isCall ? "Bull Call" : "Bull Put") : (isCall ? "Bear Call" : "Bear Put");
  const entryVal = alert.entry;
  const slVal = alert.sl;
  const tp1Val = alert.tp1;
  const tp2Val = alert.tp2;
  const riskPct = entryVal > 0 ? Math.abs((entryVal - slVal) / entryVal * 100).toFixed(1) : "—";
  const rewardPct = entryVal > 0 ? Math.abs((tp1Val - entryVal) / entryVal * 100).toFixed(1) : "—";
  const rrText = `${(alert.rr).toFixed(1)}`;

  const lines: string[] = [];

  lines.push(`Here's my read on ${alert.symbol}:`);
  lines.push(``);
  lines.push(`${b}The setup I like → ${alert.side} ${alert.instrument}${b}`);
  if (alert.expiry) lines.push(`Expiry: ${alert.expiry}`);
  lines.push(``);
  lines.push(`Why this makes sense:`);
  lines.push(alert.rationale.split("·").map(r => r.trim()).filter(Boolean).join("\n"));
  lines.push(``);
  lines.push(`Entry: ₹${entryVal.toFixed(2)}`);
  lines.push(`Stop: ₹${slVal.toFixed(2)} (${riskPct}% risk)`);
  if (tp2Val !== tp1Val) {
    lines.push(`Target 1: ₹${tp1Val.toFixed(2)} (${rewardPct}% gain — book half here, move stop to breakeven)`);
    lines.push(`Target 2: ₹${tp2Val.toFixed(2)} (let the rest ride)`);
  } else {
    lines.push(`Target: ₹${tp1Val.toFixed(2)} (${rewardPct}% gain)`);
  }
  lines.push(`Risk:Reward — 1:${rrText}`);
  lines.push(``);

  // Veteran wisdom varies by confidence
  if (alert.confidence >= 80) {
    lines.push(`I've seen this pattern enough times to have conviction. The stars are aligned — PCR supporting, OI building in the right direction, and the flow is with us. Size according to your plan, but this is one where you can lean in a bit more.`);
  } else if (alert.confidence >= 65) {
    lines.push(`Decent setup, but I'd keep position size moderate. The probabilities tilt our way, but the market has a way of humbling you when you get overconfident. Take what it gives you and don't get greedy.`);
  } else {
    lines.push(`This is more of a feeler — not a conviction trade. If you take it, keep it small. The data is mixed: some things line up, others don't. In my experience, these are the trades where tight stops matter most.`);
  }

  lines.push(``);
  lines.push(`One thing I've learned in 29 years: the market loves to run stops before it runs in the real direction. If you see price dip just below your entry right after getting in, don't panic — professionals are triggering the weak hands. Stay with your plan unless the thesis breaks.`);
  lines.push(``);
  lines.push(`Size is everything. Never risk more than 2% of your capital on any single idea.`);

  return lines.join("\n");
}

// ─── Multi-symbol scanner (all 5 indices) ─────────────────────────
export interface IndexChainData {
  symbol: string;
  spot: number;
  pcr: number;
  vix: number;
  chain: OptionChainRow[];
  expiryLabel?: string;
}

export function generateMultiAlerts(
  chains: IndexChainData[],
  newsSentiment: NewsSentiment,
  fiiNetCr?: number,
  diiNetCr?: number
): TradeAlert[] {
  const candidates: TradeAlert[] = [];

  for (const idx of chains) {
    if (!idx.chain.length) continue;
    const alert = generateOptionAlert({
      symbol: idx.symbol,
      spot: idx.spot,
      pcr: idx.pcr,
      vix: idx.vix,
      chain: idx.chain,
      newsSentiment,
      fiiNetCr,
      diiNetCr,
      expiryLabel: idx.expiryLabel,
    });
    if (alert) candidates.push(alert);
  }

  // Filter out low-conviction trades — only show setups with meaningful R:R
  const filtered = candidates.filter(a => a.confidence >= 65 && a.rr >= 1.5);

  // Sort by confidence descending, top 3
  return filtered.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

// ─── Intent detection for free-text chat / Telegram messages ────────
// Covers trades (all indices + equities), news, gap (Gift Nifty),
// correlation (Nifty–Sensex), greetings, and unknown.
export type IntentKind =
  | "trade"
  | "news"
  | "gap"
  | "correlation"
  | "fiidii"
  | "scanner"
  | "breakout"
  | "btst"
  | "trades"
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
  // Specific intents MUST be checked before the generic "trade" rule,
  // because words like "trade"/"buy" appear inside "btst"/"my trades".
  if (/(scanner|scan|stock\s*pick|top\s*stock|candidate|breakout\s*stock|multibagger)/.test(text)) {
    return { kind: "scanner", symbol, raw: text };
  }
  if (/(breakout|break\s*out|sr\s*level|support\s*resistance|fakeout|pattern\s*confirm)/.test(text)) {
    return { kind: "breakout", symbol, raw: text };
  }
  if (/(btst|buy\s*today\s*sell\s*tomorrow|overnight\s*(trade|position)|carry\s*trade|positional)/.test(text)) {
    return { kind: "btst", symbol, raw: text };
  }
  if (/trade/.test(text) && /(my|today|journal|generated|we|active|open\s*position|what|did|do)/.test(text) && !/option|ce|pe|\bcall\b|\bput\b/.test(text)) {
    return { kind: "trades", symbol, raw: text };
  }
  if (/trade|signal|setup|entry|buy|sell|call|put|alert|option|strike|\bce\b|\bpe\b/.test(text)) {
    return { kind: "trade", symbol, raw: text };
  }
  if (/(fii|dii|institutional\s*flow|foreign\s*institutional|domestic\s*institutional|net\s*(buy|sell|flow)|cash\s*market\s*(flow|activity))/i.test(text)) {
    return { kind: "fiidii", symbol, raw: text };
  }
  if (/(news|sentiment|headline|market\s*(mood|analysis|today|now)|how'?s?\s*the\s*market|what'?s?\s*the\s*news)/.test(text)) {
    return { kind: "news", symbol, raw: text };
  }
  return { kind: "unknown", symbol, raw: text };
}

