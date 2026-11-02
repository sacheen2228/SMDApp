// Statistical analytics — gap, imbalance, futures, breadth, volatility, volume.
// Pure functions on normalized study days / series. No network.

import type { PreopenStudyDay, CmPreopenRow, FuturesPreopenRow } from "./types";
import { normalizedImbalance, imbalanceQty } from "./normalize";

// ── A. Gap analytics ─────────────────────────────────────────────────

export function gapPct(open: number | null, prevClose: number | null): number | null {
  if (open == null || prevClose == null || prevClose === 0) return null;
  return ((open - prevClose) / prevClose) * 100;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function zScore(value: number, series: number[]): number | null {
  const m = mean(series);
  const s = stdev(series);
  if (m == null || s == null || s === 0) return null;
  return (value - m) / s;
}

/** Percentile rank of value in series (0–100). */
export function percentileRank(value: number, series: number[]): number | null {
  if (series.length === 0) return null;
  let below = 0;
  for (const x of series) if (x < value) below++;
  return (below / series.length) * 100;
}

export interface GapHistoryStats {
  meanGap: number | null;
  stdGap: number | null;
  gapUpFreq: number | null;
  gapDownFreq: number | null;
  n: number;
}

/** Gap continuation: same direction as gap held through day (close beyond open in gap direction). */
export function gapContinued(gap: number | null | undefined, open: number | null | undefined, close: number | null | undefined): boolean | null {
  if (gap == null || open == null || close == null) return null;
  if (Math.abs(gap) < 0.05) return null; // flat gap — not scored
  if (gap > 0) return close > open;
  return close < open;
}

/** Gap reversal: price closed on the opposite side of prevClose from the gap. */
export function gapReversed(gap: number | null | undefined, prevClose: number | null | undefined, close: number | null | undefined): boolean | null {
  if (gap == null || prevClose == null || close == null) return null;
  if (Math.abs(gap) < 0.05) return null;
  if (gap > 0) return close < prevClose;
  return close > prevClose;
}

export function gapAtsRatio(gapAbsPct: number | null, atrPct: number | null): number | null {
  if (gapAbsPct == null || atrPct == null || atrPct === 0) return null;
  return gapAbsPct / atrPct;
}

export function computeGapHistory(gaps: number[]): GapHistoryStats {
  const n = gaps.length;
  if (n === 0) return { meanGap: null, stdGap: null, gapUpFreq: null, gapDownFreq: null, n: 0 };
  const ups = gaps.filter((g) => g > 0.05).length;
  const downs = gaps.filter((g) => g < -0.05).length;
  const scored = gaps.filter((g) => Math.abs(g) >= 0.05).length || n;
  return {
    meanGap: mean(gaps),
    stdGap: stdev(gaps),
    gapUpFreq: ups / scored,
    gapDownFreq: downs / scored,
    n,
  };
}

// ── B. Order imbalance ───────────────────────────────────────────────

export interface ImbalanceMetrics {
  raw: number | null;
  normalized: number | null;
  vsFinalVolume: number | null;
}

export function computeImbalance(row: {
  totalBuyQuantity?: number | null;
  totalSellQuantity?: number | null;
  finalQuantity?: number | null;
  imbalanceQty?: number | null;
}): ImbalanceMetrics {
  const buy = row.totalBuyQuantity ?? null;
  const sell = row.totalSellQuantity ?? null;
  const raw = buy != null && sell != null ? imbalanceQty(buy, sell) : (row.imbalanceQty ?? null);
  const normalized = buy != null && sell != null ? normalizedImbalance(buy, sell) : null;
  const denom = buy != null && sell != null ? buy + sell : null;
  const vsFinalVolume =
    denom != null && row.finalQuantity != null && row.finalQuantity > 0 ? denom / row.finalQuantity : null;
  return { raw, normalized, vsFinalVolume };
}

/** Snapshot-to-snapshot imbalance change (persistence / acceleration). */
export function imbalanceDelta(prev: number | null, curr: number | null): number | null {
  if (prev == null || curr == null) return null;
  return curr - prev;
}

export function imbalanceAcceleration(d1: number | null, d2: number | null): number | null {
  // d2 = later delta, d1 = earlier delta
  if (d1 == null || d2 == null) return null;
  return d2 - d1;
}

// ── C. Futures analytics ─────────────────────────────────────────────

export function basis(futures: number | null | undefined, spot: number | null | undefined): number | null {
  if (futures == null || spot == null) return null;
  return futures - spot;
}

export function basisPct(futures: number | null | undefined, spot: number | null | undefined): number | null {
  if (futures == null || spot == null || spot === 0) return null;
  return ((futures - spot) / spot) * 100;
}

export function futuresOpeningStrength(
  fut: { iep: number | null; previousClose: number | null; pChange: number | null },
): number | null {
  // Prefer pChange; else derive from IEP vs prevClose. Scale-free 0-100 optional later.
  if (fut.pChange != null) return fut.pChange;
  if (fut.iep != null && fut.previousClose != null && fut.previousClose !== 0) {
    return ((fut.iep - fut.previousClose) / fut.previousClose) * 100;
  }
  return null;
}

export function spotFuturesDivergence(
  spotChangePct: number | null,
  futChangePct: number | null,
): number | null {
  if (spotChangePct == null || futChangePct == null) return null;
  return futChangePct - spotChangePct;
}

export function idxStkFuturesConfirmation(
  idxStrengthPct: number | null,
  stkAvgStrengthPct: number | null,
): { confirmed: boolean | null; agreement: number | null } {
  if (idxStrengthPct == null || stkAvgStrengthPct == null) return { confirmed: null, agreement: null };
  const sameSign = Math.sign(idxStrengthPct) === Math.sign(stkAvgStrengthPct) || idxStrengthPct === 0 || stkAvgStrengthPct === 0;
  // Both near-zero counts as neutral agreement
  const idxN = Math.abs(idxStrengthPct) < 0.05;
  const stkN = Math.abs(stkAvgStrengthPct) < 0.05;
  const confirmed = idxN && stkN ? true : sameSign && !(idxN !== stkN && Math.abs(idxStrengthPct - stkAvgStrengthPct) > 0.5);
  const agreement = 1 - Math.min(1, Math.abs(idxStrengthPct - stkAvgStrengthPct) / 2);
  return { confirmed, agreement };
}

// ── D. Market breadth ────────────────────────────────────────────────

export interface BreadthResult {
  adv: number;
  dec: number;
  unchanged: number;
  advPct: number | null;
  equalWeighted: number | null; // mean pChange
  indexWeighted: number | null; // Σ w*pChange / Σw (equal weight if no weights)
  topContribution: { symbol: string; contribution: number } | null;
}

export function computeBreadth(
  rows: Array<{ symbol: string; pChange: number | null; weightPct?: number }>,
): BreadthResult {
  const withChg = rows.filter((r) => r.pChange != null && Number.isFinite(r.pChange));
  const adv = withChg.filter((r) => r.pChange! > 0).length;
  const dec = withChg.filter((r) => r.pChange! < 0).length;
  const unchanged = withChg.length - adv - dec;
  const total = withChg.length;
  const advPct = total > 0 ? adv / total : null;
  const equalWeighted = mean(withChg.map((r) => r.pChange!));

  let indexWeighted: number | null = null;
  let topContribution: BreadthResult["topContribution"] = null;
  if (total > 0) {
    const hasWeights = withChg.some((r) => (r.weightPct ?? 0) > 0);
    if (hasWeights) {
      let wSum = 0;
      let acc = 0;
      let best: { symbol: string; contribution: number } | null = null;
      for (const r of withChg) {
        const w = r.weightPct && r.weightPct > 0 ? r.weightPct : 0;
        const c = w * r.pChange!;
        wSum += w;
        acc += c;
        if (!best || Math.abs(c) > Math.abs(best.contribution)) best = { symbol: r.symbol, contribution: c };
      }
      indexWeighted = wSum > 0 ? acc / wSum : null;
      topContribution = best;
    } else {
      indexWeighted = equalWeighted;
      const sorted = [...withChg].sort((a, b) => Math.abs(b.pChange!) - Math.abs(a.pChange!));
      if (sorted[0]) topContribution = { symbol: sorted[0].symbol, contribution: sorted[0].pChange! };
    }
  }
  return { adv, dec, unchanged, advPct, equalWeighted, indexWeighted, topContribution };
}

export function concentrationTopN(rows: Array<{ pChange: number | null }>, n = 5): number {
  // Share of absolute move held by top-N |pChange| constituents
  const abs = rows.filter((r) => r.pChange != null).map((r) => Math.abs(r.pChange!)).sort((a, b) => b - a);
  const total = abs.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return abs.slice(0, n).reduce((a, b) => a + b, 0) / total;
}

// ── E. Volatility ────────────────────────────────────────────────────

export function atrPct(candles: Array<{ high: number; low: number; close: number }>, period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const window = trs.slice(-period);
  const avg = mean(window);
  const lastClose = candles[candles.length - 1].close;
  if (avg == null || lastClose === 0) return null;
  return (avg / lastClose) * 100;
}

export function realizedVolPct(closes: number[], annualize = Math.sqrt(252)): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const s = stdev(rets);
  if (s == null) return null;
  return s * annualize * 100;
}

export function expectedMovePct(vix: number | null): number | null {
  if (vix == null || vix <= 0) return null;
  return vix / Math.sqrt(252);
}

export function volExpansion(currentVol: number | null, baselineVol: number | null): number | null {
  if (currentVol == null || baselineVol == null || baselineVol === 0) return null;
  return currentVol / baselineVol;
}

// ── F. Volume analytics ──────────────────────────────────────────────

export function relativeVolume(todayVol: number | null, avgPriorVol: number | null): number | null {
  if (todayVol == null || avgPriorVol == null || avgPriorVol === 0) return null;
  return todayVol / avgPriorVol;
}

export function vwap(candles: Array<{ high: number; low: number; close: number; volume: number }>): number | null {
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const t = (c.high + c.low + c.close) / 3;
    pv += t * c.volume;
    v += c.volume;
  }
  return v > 0 ? pv / v : null;
}

// ── Study-day convenience wrappers ───────────────────────────────────

export function studyGapFromIep(day: PreopenStudyDay): number | null {
  if (!day.cm) return null;
  return gapPct(day.cm.iep ?? day.cm.finalPrice, day.cm.previousClose);
}

export function studyFuturesGap(day: PreopenStudyDay): number | null {
  if (!day.futures) return null;
  return gapPct(day.futures.iep ?? day.futures.finalPrice, day.futures.previousClose);
}

export function studyBasis(day: PreopenStudyDay): { basis: number | null; basisPct: number | null } {
  const spot = day.cm?.iep ?? day.cm?.finalPrice ?? day.open?.spotOpen;
  const fut = day.futures?.iep ?? day.futures?.finalPrice ?? day.open?.futuresOpen;
  return { basis: basis(fut, spot), basisPct: basisPct(fut, spot) };
}

export function cmImbalanceFromRow(row: Pick<CmPreopenRow, "totalBuyQuantity" | "totalSellQuantity" | "finalQuantity">): ImbalanceMetrics {
  return computeImbalance(row);
}

export function fnoImbalanceFromRow(row: Pick<FuturesPreopenRow, "totalBuyQuantity" | "totalSellQuantity" | "finalQuantity">): ImbalanceMetrics {
  return computeImbalance(row);
}
