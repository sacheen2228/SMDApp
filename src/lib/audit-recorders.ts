// Recorders that push Terminal-tab strategy candidates (Zero Hero + Smart Money)
// into the Trade Audit (backtest verification) engine on :4001.
//
// Browser + server safe. Each signal uses a deterministic, date-scoped tradeId
// (STRAT-SYMBOL-STRIKE-TYPE-YYYYMMDD) so re-scans/polls are idempotent.

import { recordSignal, updatePrice, type SignalInput } from "./trade-audit-client";
import { GATE_CONFIG } from "./agent-brain-gate";

const istYmd = (when = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(when)
    .replace(/-/g, ""); // YYYYMMDD in IST

/** Map current IST time → a MarketSession bucket for the recorded signal. */
export function istSession(): SignalInput["marketSession"] {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  if (mins < 555) return "PRE_OPEN";
  if (mins < 570) return "OPENING";
  if (mins < 720) return "MORNING";
  if (mins < 780) return "MIDDAY";
  if (mins < 900) return "AFTERNOON";
  if (mins < 930) return "CLOSING";
  return "POST_CLOSE";
}

export interface AuditOptionCandidate {
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  rr?: number; // risk:reward (default 2)
  conf: number; // 0-100
  reason?: string;
  price?: number; // current live premium — fed as a tracking tick so the
  // engine can compute MFE/MAE and auto-close on SL/TP (real backtest)
}

/**
 * The levels the audit engine records when a candidate does not carry them.
 *
 * PER-TRADE MODEL (user rule, 2026-10-20): the deployed amount IS the premium
 * (premium × units), so "risk = 20% of the amount DEPLOYED" means 1R = 20% of
 * the premium. The targets are the model's R ladder: 2R / 3R / 4R.
 *
 * The old defaults were stop = 22% and TP1 = 22% → R:R 1:1, which needs >50%
 * win-rate BEFORE costs. That is the exact bug the option plan fixed.
 */
export function auditLevels(c: AuditOptionCandidate): {
  sl: number; tp1: number; tp2: number; tp3?: number; rPoints: number;
} {
  const entry = Number(c.entry);
  const isCE = c.type === "CE";
  const rPct = GATE_CONFIG.riskPctOfTrade / 100; // 1R = 20% of the premium
  const rPoints = entry * rPct;
  const sign = isCE ? 1 : -1;               // CE targets above, PE targets below
  const sl = c.sl ?? entry - sign * rPoints;
  const tp1 = c.tp1 ?? entry + sign * rPoints * 2;   // 2R
  const tp2 = c.tp2 ?? entry + sign * rPoints * 3;   // 3R
  const tp3 = c.tp3 ?? entry + sign * rPoints * 4;   // 4R
  return { sl, tp1, tp2, tp3, rPoints };
}

/**
 * Record option candidates as signals. Levels are made direction-correct
 * (CE bullish / PE bearish) so the audit engine's long/short P&L + R math is
 * accurate for the backtest. Fire-and-forget per candidate.
 */
export async function recordOptionSignals(
  strategyId: string,
  symbol: string,
  candidates: AuditOptionCandidate[]
): Promise<number> {
  const ymd = istYmd();
  let recorded = 0;
  for (const c of candidates) {
    const rr = c.rr ?? 2;
    const isCE = c.type === "CE";
    const entry = c.entry;
    const { sl, tp1, tp2, tp3 } = auditLevels(c);

    const ok = await recordSignal({
      tradeId: `${strategyId}-${symbol}-${c.strike}-${c.type}-${ymd}`,
      strategyId,
      strategyVersion: "1.0",
      symbol,
      exchange: "NSE",
      instrumentType: "OPTIONS",
      spotPrice: c.price ?? entry,
      strikePrice: c.strike,
      optionType: c.type,
      entryPrice: entry,
      stopLoss: Math.round(sl * 100) / 100,
      tp1: Math.round(tp1 * 100) / 100,
      tp2: Math.round(tp2 * 100) / 100,
      tp3: tp3 != null ? Math.round(tp3 * 100) / 100 : undefined,
      signalConfidence: Math.round(c.conf),
      trendDirection: isCE ? "BULLISH" : "BEARISH",
      signalReason: c.reason ?? `${strategyId} candidate`,
      marketSession: istSession(),
      marketContext: { rr, source: strategyId },
    });
    if (ok) recorded++;
    // Feed the live premium as a tracking tick (FIFO queue guarantees the
    // insert runs first, so the engine can track MFE/MAE + auto-close on SL/TP).
    if (c.price && c.price > 0) {
      updatePrice(`${strategyId}-${symbol}-${c.strike}-${c.type}-${ymd}`, c.price).catch(() => {});
    }
  }
  return recorded;
}
