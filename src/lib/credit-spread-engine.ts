// ─── Credit Spread Auto-Suggest Engine ───────────────────────────
// Pure functions over a live option chain: ranks defined-risk vertical
// spreads (bull put / bear call) + iron condors with full per-lot
// economics: margin, max/min profit & loss, win probability.
// Decision-support only — NOT investment advice.

import { parseExpiryToYears } from "@/lib/greeks";

export interface ChainLeg {
  ltp: number;
  oi?: number;
  oiChg?: number;
  volume?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  bid?: number;
  ask?: number;
}

export interface ChainRow {
  strike: number;
  ce: ChainLeg | null;
  pe: ChainLeg | null;
}

export interface SpreadLeg {
  action: "BUY" | "SELL";
  type: "CE" | "PE";
  strike: number;
  premium: number;
}

export interface SpreadSuggestion {
  id: string;
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "IRON_CONDOR";
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  direction: "CREDIT" | "DEBIT";
  legs: SpreadLeg[];
  netCredit: number;          // per unit
  width: number;              // strike gap
  marginPerLot: number;       // capital blocked per lot
  maxProfitPerLot: number;    // held to expiry, short strike OTM
  maxLossPerLot: number;      // held to expiry, beyond long strike
  minProfitPerLot: number;    // early exit at 50% credit capture
  minLossPerLot: number;      // stop-loss exit (spread costs 2x credit)
  breakeven: number[];
  winProb: number;            // 0-100 estimate
  score: number;              // 0-100 ranking
  affordableLots: number;     // for the supplied capital (1 if none)
  reasons: string[];
}

export interface SuggestOptions {
  chain: ChainRow[];
  spot: number;
  lotSize: number;
  vix?: number;
  dte?: number;               // days to expiry (default 7)
  expiry?: string;            // ISO expiry — used to derive dte
  capital?: number;           // budget for lot sizing
  maxPerStrategy?: number;    // default 3
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

export function lotsForCapital(capital: number, marginPerLot: number): number {
  if (marginPerLot <= 0) return 0;
  return Math.floor(capital / marginPerLot);
}

function normCdf(x: number): number {
  // Abramowitz-Stegun erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? (y + 1) / 2 : (1 - y) / 2;
}

function strikeStep(chain: ChainRow[]): number {
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].strike - sorted[i - 1].strike;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 50;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function estimatePutDelta(strike: number, spot: number, vix: number, years: number): number {
  const sd = (spot * (vix / 100) * Math.sqrt(Math.max(years, 1 / 365))) || 1;
  return -normCdf((spot - strike) / sd); // negative
}

function estimateCallDelta(strike: number, spot: number, vix: number, years: number): number {
  const sd = (spot * (vix / 100) * Math.sqrt(Math.max(years, 1 / 365))) || 1;
  return normCdf((spot - strike) / sd);
}

function mid(leg: ChainLeg): number {
  if (leg.bid != null && leg.ask != null && leg.bid > 0 && leg.ask > 0) {
    return (leg.bid + leg.ask) / 2;
  }
  return leg.ltp;
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

export function suggestSpreads(opts: SuggestOptions): SpreadSuggestion[] {
  const { chain, spot, lotSize, vix = 14, expiry, capital, maxPerStrategy = 3 } = opts;
  if (!chain?.length || !spot) return [];

  const years = expiry
    ? (parseExpiryToYears(expiry) ?? Math.max(opts.dte ?? 7, 0.5) / 365)
    : Math.max(opts.dte ?? 7, 0.5) / 365;
  const dteDisplay = Math.max(1, Math.round(years * 365));
  const step = strikeStep(chain);
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);

  const valid = sorted.filter(
    (r) => r.ce && r.pe && r.ce.ltp > 0 && r.pe.ltp > 0
  );
  if (valid.length < 4) return [];

  // Candidate widths: 1x, 2x, 4x the strike step
  const widths = [step, step * 2, step * 4];

  const bullPuts: SpreadSuggestion[] = [];
  const bearCalls: SpreadSuggestion[] = [];

  for (const short of valid) {
    // ── Bull put spread: sell OTM put, buy further OTM put ──
    if (short.strike < spot && short.pe) {
      const shortPrem = mid(short.pe);
      const shortDelta = short.pe.delta ?? estimatePutDelta(short.strike, spot, vix, years);
      const absD = Math.abs(shortDelta);

      for (const w of widths) {
        const longStrike = short.strike - w;
        const long = valid.find((r) => r.strike === longStrike && r.pe);
        if (!long?.pe) continue;
        const longPrem = mid(long.pe);
        const credit = +(shortPrem - longPrem).toFixed(2);
        if (credit <= 0 || credit >= w) continue;
        const ratio = credit / w;
        if (ratio < 0.15) continue;

        const winProb = Math.round(Math.max(0, Math.min(0.95, 1 - absD)) * 100);
        const margin = (w - credit) * lotSize;
        const score = scoreSpread(ratio, absD, short.pe.oi ?? 0, valid.map((r) => r.pe?.oi ?? 0));

        const reasons = [
          `${(ratio * 100).toFixed(0)}% of width captured`,
          `short Δ ${absD.toFixed(2)} (~${winProb}% win est)`,
          `${dteDisplay} DTE`,
        ];
        if (short.pe.oiChg && short.pe.oiChg > 0) reasons.push("short OI building");

        bullPuts.push({
          id: `BPS-${short.strike}-${longStrike}`,
          strategy: "BULL_PUT_SPREAD",
          bias: "BULLISH",
          direction: "CREDIT",
          legs: [
            { action: "SELL", type: "PE", strike: short.strike, premium: +shortPrem.toFixed(2) },
            { action: "BUY", type: "PE", strike: longStrike, premium: +longPrem.toFixed(2) },
          ],
          netCredit: credit,
          width: w,
          marginPerLot: margin,
          maxProfitPerLot: credit * lotSize,
          maxLossPerLot: (w - credit) * lotSize,
          minProfitPerLot: credit * 0.5 * lotSize,   // exit at 50% credit
          minLossPerLot: credit * lotSize,            // stop at 2x spread cost
          breakeven: [+(short.strike - credit).toFixed(2)],
          winProb,
          score,
          affordableLots: 1,
          reasons,
        });
      }
    }

    // ── Bear call spread: sell OTM call, buy further OTM call ──
    if (short.strike > spot && short.ce) {
      const shortPrem = mid(short.ce);
      const shortDelta = short.ce.delta ?? estimateCallDelta(short.strike, spot, vix, years);
      const absD = Math.abs(shortDelta);

      for (const w of widths) {
        const longStrike = short.strike + w;
        const long = valid.find((r) => r.strike === longStrike && r.ce);
        if (!long?.ce) continue;
        const longPrem = mid(long.ce);
        const credit = +(shortPrem - longPrem).toFixed(2);
        if (credit <= 0 || credit >= w) continue;
        const ratio = credit / w;
        if (ratio < 0.15) continue;

        const winProb = Math.round(Math.max(0, Math.min(0.95, 1 - absD)) * 100);
        const margin = (w - credit) * lotSize;
        const score = scoreSpread(ratio, absD, short.ce.oi ?? 0, valid.map((r) => r.ce?.oi ?? 0));

        const reasons = [
          `${(ratio * 100).toFixed(0)}% of width captured`,
          `short Δ ${absD.toFixed(2)} (~${winProb}% win est)`,
          `${dteDisplay} DTE`,
        ];
        if (short.ce.oiChg && short.ce.oiChg > 0) reasons.push("short OI building");

        bearCalls.push({
          id: `BCS-${short.strike}-${longStrike}`,
          strategy: "BEAR_CALL_SPREAD",
          bias: "BEARISH",
          direction: "CREDIT",
          legs: [
            { action: "SELL", type: "CE", strike: short.strike, premium: +shortPrem.toFixed(2) },
            { action: "BUY", type: "CE", strike: longStrike, premium: +longPrem.toFixed(2) },
          ],
          netCredit: credit,
          width: w,
          marginPerLot: margin,
          maxProfitPerLot: credit * lotSize,
          maxLossPerLot: (w - credit) * lotSize,
          minProfitPerLot: credit * 0.5 * lotSize,
          minLossPerLot: credit * lotSize,
          breakeven: [+(short.strike + credit).toFixed(2)],
          winProb,
          score,
          affordableLots: 1,
          reasons,
        });
      }
    }
  }

  bullPuts.sort((a, b) => b.score - a.score);
  bearCalls.sort((a, b) => b.score - a.score);

  const topBull = bullPuts.slice(0, maxPerStrategy);
  const topBear = bearCalls.slice(0, maxPerStrategy);

  // ── Iron condor: best bull put + best bear call, non-overlapping ──
  const condors: SpreadSuggestion[] = [];
  const putPick = topBull[0] ?? bullPuts[0];
  const callPick = topBear[0] ?? bearCalls[0];
  if (putPick && callPick) {
    const credit = +(putPick.netCredit + callPick.netCredit).toFixed(2);
    const width = Math.max(putPick.width, callPick.width);
    const margin = (width - credit) * lotSize;
    if (credit > 0 && credit < width) {
      condors.push({
        id: `IC-${putPick.legs[0].strike}-${callPick.legs[0].strike}`,
        strategy: "IRON_CONDOR",
        bias: "NEUTRAL",
        direction: "CREDIT",
        legs: [...putPick.legs, ...callPick.legs],
        netCredit: credit,
        width,
        marginPerLot: margin,
        maxProfitPerLot: credit * lotSize,
        maxLossPerLot: (width - credit) * lotSize,
        minProfitPerLot: credit * 0.5 * lotSize,
        minLossPerLot: credit * lotSize,
        breakeven: [...putPick.breakeven, ...callPick.breakeven],
        winProb: Math.round((putPick.winProb + callPick.winProb) / 2),
        score: Math.round((putPick.score + callPick.score) / 2),
        affordableLots: 1,
        reasons: [
          `both sides: ₹${fmt(credit)} credit`,
          `range ${putPick.breakeven[0]} – ${callPick.breakeven[0]}`,
          `${dteDisplay} DTE`,
        ],
      });
    }
  }

  let all = [...topBull, ...topBear, ...condors];

  // Capital filter + lot sizing
  if (capital && capital > 0) {
    all = all.filter((s) => s.marginPerLot <= capital);
    for (const s of all) {
      s.affordableLots = Math.max(1, lotsForCapital(capital, s.marginPerLot));
    }
  }

  return all;
}

function scoreSpread(
  creditRatio: number,
  absDelta: number,
  shortOi: number,
  allOi: number[],
): number {
  // Credit capture (0-40): prefer 25%+ of width
  const creditScore = Math.min(creditRatio / 0.35, 1) * 40;
  // Delta fit (0-30): sweet spot 0.10-0.20
  const d = absDelta;
  const deltaScore = d >= 0.1 && d <= 0.2 ? 30 : d < 0.1 ? Math.max(0, 30 - (0.1 - d) * 200) : Math.max(0, 30 - (d - 0.2) * 150);
  // Liquidity (0-30): short-leg OI percentile
  const sortedOi = [...allOi].sort((a, b) => a - b);
  const rank = sortedOi.filter((x) => x <= shortOi).length / Math.max(sortedOi.length, 1);
  const liqScore = rank * 30;
  return Math.round(creditScore + deltaScore + liqScore);
}
