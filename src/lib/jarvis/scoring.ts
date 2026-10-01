// Component scorers. Each returns a bounded score; see
// references/scoring-rules.md (from the nse-options-signal skill) for the
// full rationale behind every threshold — keep that doc in sync if you tune
// numbers here.
import type { OptionChain, FiiDiiRow, HeatmapConstituent } from "./types";

export function optionChainScore(oc: OptionChain): { score: number; support?: number; resistance?: number; pcr: number; maxPain?: number } {
  const S = oc.underlyingValue;
  const expiry = oc.expiryDates[0];
  const rows = oc.data.filter((r) => r.expiryDate === expiry);
  const ceOi = rows.reduce((s, r) => s + (r.CE?.openInterest ?? 0), 0);
  const peOi = rows.reduce((s, r) => s + (r.PE?.openInterest ?? 0), 0);
  const pcr = ceOi ? peOi / ceOi : 1;

  const above = rows.filter((r) => r.strikePrice >= S && r.CE);
  const below = rows.filter((r) => r.strikePrice <= S && r.PE);
  const resistance = above.length
    ? above.reduce((a, b) => (b.CE!.openInterest > a.CE!.openInterest ? b : a)).strikePrice
    : undefined;
  const support = below.length
    ? below.reduce((a, b) => (b.PE!.openInterest > a.PE!.openInterest ? b : a)).strikePrice
    : undefined;

  let s = pcr > 1.3 ? 8 : pcr > 1.0 ? 3 : pcr > 0.8 ? -3 : -8;
  if (pcr > 1.7) s = Math.min(s, 4);
  if (resistance !== undefined && Math.abs(S - resistance) / S < 0.003) s -= 6;
  if (support !== undefined && Math.abs(S - support) / S < 0.003) s += 6;

  const near = rows.filter((r) => Math.abs(r.strikePrice - S) / S < 0.02);
  const dPe = near.reduce((sum, r) => sum + (r.PE?.changeinOpenInterest ?? 0), 0);
  const dCe = near.reduce((sum, r) => sum + (r.CE?.changeinOpenInterest ?? 0), 0);
  s += dPe > dCe ? 8 : -8;

  return { score: Math.max(-25, Math.min(25, s)), support, resistance, pcr: round(pcr, 2) };
}

export function fiiScore(rows: FiiDiiRow[] | undefined): number {
  if (!rows?.length) return 0;
  const fii = rows.find((r) => /FII|FPI/i.test(r.category));
  if (!fii) return 0;
  const net = fii.netValue;
  if (net > 2000) return 6;
  if (net > 500) return 3;
  if (net < -2000) return -6;
  if (net < -500) return -3;
  return 0;
}

/** +/-3 boost/cancel based on whether BSE's FII derivatives summary agrees. Pass null when unavailable -> 0, never guessed. */
export function bseFiiAdjustment(agrees: boolean | null): number {
  if (agrees === null) return 0;
  return agrees ? 3 : -3;
}

export function breadthScore(gainersCount: number, losersCount: number): number {
  const total = gainersCount + losersCount;
  if (total === 0) return 0;
  const r = gainersCount / total;
  if (r > 0.65) return 5;
  if (r < 0.35) return -5;
  return 0;
}

/** Market-cap weighted index return from heatmap constituents, +/-10, with a narrow-rally penalty. */
export function heatmapScore(constituents: HeatmapConstituent[] | undefined): { score: number; weightedPct: number; narrow: boolean } {
  if (!constituents?.length) return { score: 0, weightedPct: 0, narrow: false };
  const weightedPct = constituents.reduce((s, c) => s + c.weightPct * c.pctChange, 0) / 100;
  let score = Math.max(-5, Math.min(5, (weightedPct / 0.4) * 5));
  const sorted = [...constituents].sort((a, b) => Math.abs(b.weightPct * b.pctChange) - Math.abs(a.weightPct * a.pctChange));
  const top3Contribution = sorted.slice(0, 3).reduce((s, c) => s + Math.abs(c.weightPct * c.pctChange), 0);
  const totalContribution = constituents.reduce((s, c) => s + Math.abs(c.weightPct * c.pctChange), 0) || 1;
  const narrow = top3Contribution / totalContribution > 0.7;
  if (narrow) score -= 2;
  return { score: round(score, 1), weightedPct: round(weightedPct, 3), narrow };
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
