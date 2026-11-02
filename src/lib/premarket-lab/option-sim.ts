// Phase 11 option simulation — BUY CE / BUY PE against REAL bhavcopy OHLC.
// Daily granularity only: same-day SL+TP ambiguity resolved SL-first (conservative).
// No historical premium → outcome = NOT_VALIDATED (never substitute underlying returns).
// Phase 12: lot-aware ₹ charges and rupee P&L when lotSize is known.

import type { OptionSimResult } from "./types";
import type { PremiumCandle } from "@/lib/option-bhavcopy";

export interface OptionSimConfig {
  /** Risk as fraction of entry premium (default 0.20 → 20% stop). */
  stopPct?: number;
  /** Target as R multiple (default 2 → R:R 1:2). */
  targetRMultiple?: number;
  /** Slippage in premium points (default 0.5). */
  slippagePts?: number;
  /** Brokerage + STT estimate in ₹ per trade (default 40 — flat only when lot unknown). */
  chargesInr?: number;
  asOf?: string;
  /** Explicit lot size override (else taken from bhavcopy NewBrdLotQty). */
  lotSize?: number | null;
}

const DEFAULTS: Required<Omit<OptionSimConfig, "asOf" | "lotSize">> = {
  stopPct: 0.20,
  targetRMultiple: 2,
  slippagePts: 0.5,
  chargesInr: 40,
};

/**
 * Estimate round-trip charges for one BUY option lot.
 * When lot is unknown → flat base (honest: not lot-scaled).
 * When lot is known → base + proportional premium turnover estimate
 * (STT ~0.05% on sell side of premium turnover is the dominant term).
 */
export function estimateChargesInr(
  entry: number,
  lotSize: number | null | undefined,
  base = DEFAULTS.chargesInr,
): number {
  if (!lotSize || lotSize <= 0 || !Number.isFinite(entry) || entry <= 0) {
    return base;
  }
  // Approx: brokerage base + STT + exchange txn on premium turnover (both legs).
  const turnover = entry * lotSize * 2; // buy + sell notional of premium
  const sttAndFees = turnover * 0.00055; // ~5.5 bps blended
  return Math.round((base + sttAndFees) * 100) / 100;
}

/**
 * Simulate a same-day BUY CE/PE from one premium OHLC bar.
 * Pure — no network. Caller supplies PremiumCandle from bhavcopy.
 */
export function simulateBuyOption(
  tradeDate: string,
  symbol: string,
  side: "CE" | "PE",
  candle: PremiumCandle | null | undefined,
  cfg: OptionSimConfig = {},
): OptionSimResult {
  const c = { ...DEFAULTS, ...cfg };
  const asOf = c.asOf || new Date().toISOString();
  const lotFromCandle = Number(candle?.lotSize) > 0 ? Number(candle!.lotSize) : null;
  const lotSize = cfg.lotSize ?? lotFromCandle;
  const base: OptionSimResult = {
    tradeDate,
    symbol,
    side,
    strike: candle?.strike ?? null,
    expiry: candle?.expiry ?? null,
    entry: null,
    stopLoss: null,
    target: null,
    outcome: "NOT_VALIDATED",
    pnlR: null,
    mae: null,
    mfe: null,
    charges: null,
    slippagePts: c.slippagePts,
    validated: false,
    asOf,
    lotSize: lotSize ?? null,
    pnlInr: null,
  };

  if (!candle || !Number.isFinite(candle.open) || candle.open <= 0) {
    return { ...base, outcome: "NO_DATA", reason: "no_premium_ohlc" };
  }

  // Prefer open as entry; fall back to previousClose-style close if open missing
  const entry = Number.isFinite(candle.open) && candle.open > 0 ? candle.open : candle.close;
  if (!Number.isFinite(entry) || entry <= 0) {
    return { ...base, outcome: "NO_DATA", reason: "invalid_entry" };
  }

  const stopPts = entry * c.stopPct;
  const stopLoss = entry - stopPts;
  const target = entry + stopPts * c.targetRMultiple;

  const high = Number.isFinite(candle.high) ? candle.high : entry;
  const low = Number.isFinite(candle.low) ? candle.low : entry;
  const close = Number.isFinite(candle.close) ? candle.close : entry;

  // SL-first ambiguity: if both stop and target printed, treat as LOSS
  const hitStop = low <= stopLoss;
  const hitTarget = high >= target;

  let outcome: OptionSimResult["outcome"];
  let exit: number;
  if (hitStop && hitTarget) {
    outcome = "LOSS";
    exit = stopLoss;
  } else if (hitStop) {
    outcome = "LOSS";
    exit = stopLoss;
  } else if (hitTarget) {
    outcome = "WIN";
    exit = target;
  } else {
    // Neither — mark-to-close (still validated: real OHLC, no path invented)
    outcome = close > entry ? "WIN" : close < entry ? "LOSS" : "FLAT";
    exit = close;
  }

  const riskPts = stopPts > 0 ? stopPts : 1;
  const grossPts = exit - entry;
  // Apply slippage against the trader (BUY: worse entry, worse exit)
  const entryAdj = entry + c.slippagePts;
  const exitAdj =
    outcome === "LOSS"
      ? Math.max(0, exit - c.slippagePts)
      : exit + (outcome === "WIN" ? -c.slippagePts : 0);
  const netPts = exitAdj - entryAdj;
  const pnlR = netPts / riskPts;

  // MAE/MFE as % of entry from daily high/low (premium path proxy)
  const mae = ((entry - low) / entry) * 100;
  const mfe = ((high - entry) / entry) * 100;

  // Charges: lot-aware when lot known; flat base otherwise (never pretend lot=1).
  const charges = estimateChargesInr(entry, lotSize, c.chargesInr);
  const pnlInr =
    lotSize && lotSize > 0
      ? Math.round((netPts * lotSize - charges) * 100) / 100
      : null;

  return {
    tradeDate,
    symbol,
    side,
    strike: candle.strike,
    expiry: candle.expiry,
    entry: Number(entry.toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    target: Number(target.toFixed(2)),
    outcome,
    pnlR: Number(pnlR.toFixed(4)),
    mae: Number(mae.toFixed(4)),
    mfe: Number(mfe.toFixed(4)),
    charges,
    slippagePts: c.slippagePts,
    validated: true,
    reason: hitStop && hitTarget ? "sl_first_ambiguity" : undefined,
    asOf,
    lotSize: lotSize ?? null,
    pnlInr,
  };
}

/**
 * Score a list of sims. NOT_VALIDATED / NO_DATA excluded from win-rate.
 * Returns explicit NOT_VALIDATED counts — never invents option P&L.
 */
export function summarizeOptionSims(results: OptionSimResult[]): {
  n: number;
  validated: number;
  notValidated: number;
  noData: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number | null;
  message: string;
} {
  const validated = results.filter((r) => r.validated && (r.outcome === "WIN" || r.outcome === "LOSS" || r.outcome === "FLAT"));
  const notValidated = results.filter((r) => !r.validated && r.outcome !== "NO_DATA").length;
  const noData = results.filter((r) => r.outcome === "NO_DATA").length;
  const wins = validated.filter((r) => r.outcome === "WIN").length;
  const losses = validated.filter((r) => r.outcome === "LOSS").length;
  const flats = validated.filter((r) => r.outcome === "FLAT").length;
  const n = validated.length;
  const rs = validated.map((r) => r.pnlR).filter((x): x is number => x != null && Number.isFinite(x));
  const totalR = rs.length ? rs.reduce((a, b) => a + b, 0) : null;
  const avgR = rs.length ? totalR! / rs.length : null;
  const winRate = n > 0 ? wins / n : null;
  return {
    n: results.length,
    validated: n,
    notValidated,
    noData,
    wins,
    losses,
    flats,
    winRate,
    avgR,
    totalR,
    message:
      n === 0
        ? "NOT_VALIDATED — no historical option premium OHLC for these sessions"
        : notValidated + noData > 0
          ? `validated ${n}/${results.length} — ${notValidated} NOT_VALIDATED, ${noData} NO_DATA`
          : `all ${n} sims validated on real premium OHLC`,
  };
}

/** Choose ATM-ish strike: nearest to spot among available candles. */
export function pickAtmStrike(
  candles: PremiumCandle[],
  spot: number,
  optionType: "CE" | "PE",
): PremiumCandle | null {
  const opts = candles.filter((c) => c.optionType === optionType);
  if (!opts.length || !Number.isFinite(spot)) return null;
  let best: PremiumCandle | null = null;
  let bestDist = Infinity;
  for (const c of opts) {
    const d = Math.abs(c.strike - spot);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
