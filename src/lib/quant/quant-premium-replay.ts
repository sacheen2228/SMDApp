// quant-premium-replay.ts — replay helper for RECORDED option-premium history.
//
// The live engine reads an option chain snapshot (NSE/BSE live, EOD files).
// For HISTORICAL validation we need the same shape from recorded prices: the
// frozen datasets carry per-contract option bars captured from ICICI Breeze
// getHistoricalDatav2 (read-only historical data — real open/high/low/close,
// volume and open interest).
//
// WHAT IS RECORDED vs WHAT IS MODELED (never mixed silently):
//   RECORDED  — option premium OHLC/volume/OI, underlying OHLC, contract
//               identity (strike/expiry), lot size and tick size.
//   MODELED   — the bid/ask pair around the recorded close (exchange history
//               carries no book), and the fee/slippage constants.
//
// The chain built here is therefore labelled "BREEZE-HIST" and every consumer
// reports the modeled spread explicitly. A missing recorded bar is NEVER
// replaced by an underlying price — no bar means "no observation", so no hit
// can be claimed from it.

import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { OptionLeg, OptionStrike } from "@/lib/data-layer/types";

export interface QuantPremiumBar {
  timestamp: string; // ISO with +05:30 offset
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
}

export interface QuantPremiumSeries {
  tradingsymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiry: string; // ISO YYYY-MM-DD
  lotSize: number;
  tickSize: number;
  bars: QuantPremiumBar[];
}

export interface QuantPremiumReplayConfig {
  /**
   * MODELED half-spread around the recorded close, as a fraction of the close
   * (0.005 = 0.5% per side → 1% total). The exchange history carries no bid/
   * ask book, so this is an explicit assumption — never a recorded value.
   */
  spreadModelPct: number;
}

export const DEFAULT_PREMIUM_REPLAY_CONFIG: QuantPremiumReplayConfig = { spreadModelPct: 0.005 };

/** Latest recorded bar at or before `ts` (ISO). Null when the contract has no bar yet. */
export function barAt(series: QuantPremiumSeries, ts: string): QuantPremiumBar | null {
  const target = Date.parse(ts);
  if (!Number.isFinite(target)) return null;
  let found: QuantPremiumBar | null = null;
  for (const bar of series.bars) {
    const t = Date.parse(bar.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t <= target) found = bar;
    else break; // bars are sorted ascending
  }
  return found;
}

function legFromBar(bar: QuantPremiumBar, cfg: QuantPremiumReplayConfig): OptionLeg {
  const half = bar.close * cfg.spreadModelPct;
  return {
    ltp: bar.close,
    volume: bar.volume || null,
    oi: bar.oi,
    oiChange: null, // a single recorded bar carries no day-over-day delta
    iv: null, // not published in the historical bars
    bid: Math.max(0.01, bar.close - half), // MODELED
    ask: bar.close + half, // MODELLED
    delta: null,
    gamma: null,
    theta: null,
    rho: null,
  };
}

/**
 * Builds the option chain as it was RECORDED at `ts` from the frozen option
 * series. `spot` is the recorded underlying close at the same instant.
 * Returns null when no contract has a recorded bar at/before `ts`.
 */
export function buildChainAt(
  seriesList: QuantPremiumSeries[],
  ts: string,
  spot: number,
  cfg: QuantPremiumReplayConfig = DEFAULT_PREMIUM_REPLAY_CONFIG,
): CanonicalOptionChain | null {
  const byStrike = new Map<number, { ce?: QuantPremiumBar; pe?: QuantPremiumBar }>();
  let expiry: string | null = null;
  let any = false;

  for (const series of seriesList) {
    const bar = barAt(series, ts);
    if (!bar) continue;
    any = true;
    expiry = expiry ?? series.expiry;
    const entry = byStrike.get(series.strike) ?? {};
    if (series.optionType === "CE") entry.ce = bar;
    else entry.pe = bar;
    byStrike.set(series.strike, entry);
  }
  if (!any) return null;

  const strikes: OptionStrike[] = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, v]) => ({
      strike,
      ce: v.ce ? legFromBar(v.ce, cfg) : null,
      pe: v.pe ? legFromBar(v.pe, cfg) : null,
    }));

  return {
    underlying: "NIFTY",
    spot,
    expiry,
    strikes,
    timestamp: ts,
    source: "BREEZE-HIST",
    fallbackUsed: false,
    freshness: "FRESH",
    asOf: ts,
    expiryRequested: expiry,
    expirySelection: "recorded",
    isEod: false,
  };
}

/** The recorded option bar for a contract at `ts` (null → no observation). */
export function recordedBarFor(
  seriesList: QuantPremiumSeries[],
  tradingsymbol: string,
  expiry: string | null,
  strike: number | null,
  ts: string,
): QuantPremiumBar | null {
  if (strike == null) return null;
  const match =
    seriesList.find(
      (s) =>
        s.tradingsymbol === tradingsymbol &&
        (expiry == null || s.expiry === expiry) &&
        s.strike === strike,
    ) ?? seriesList.find((s) => s.strike === strike && (expiry == null || s.expiry === expiry));
  if (!match) return null;
  return barAt(match, ts);
}
