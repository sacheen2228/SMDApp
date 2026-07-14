// Recorders that push Terminal-tab strategy candidates (Zero Hero + Smart Money)
// into the Trade Audit (backtest verification) engine on :4001.
//
// Browser + server safe. Each signal uses a deterministic, date-scoped tradeId
// (STRAT-SYMBOL-STRIKE-TYPE-YYYYMMDD) so re-scans/polls are idempotent.

import { recordSignal, updatePrice, type SignalInput } from "./trade-audit-client";

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
  const slPct = 0.22;
  let recorded = 0;
  for (const c of candidates) {
    const rr = c.rr ?? 2;
    const isCE = c.type === "CE";
    const entry = c.entry;
    const sl = c.sl ?? (isCE ? entry * (1 - slPct) : entry * (1 + slPct));
    const tp1 = c.tp1 ?? (isCE ? entry * (1 + slPct) : entry * (1 - slPct));
    const tp2 = c.tp2 ?? (isCE ? entry * (1 + slPct * rr) : entry * (1 - slPct * rr));
    const tp3 = c.tp3;

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
