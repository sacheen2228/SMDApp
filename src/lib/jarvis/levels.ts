// Level map: OI walls, max pain, expected-move bands, round numbers, plus
// whatever OHLC-derived levels you pass in (PDH/PDL, VWAP, opening range).
// Finds confluence zones (3+ levels within 0.15% of each other) and checks
// option-strike liquidity (top-5 OI, bid-ask spread).
import type { LevelsResult, LevelMap, OptionChain, Ohlc, ConfluenceZone } from "./types";

function maxPain(rows: OptionChain["data"]): number | undefined {
  const strikes = rows.map((r) => r.strikePrice);
  let best: number | undefined;
  let bestLoss = Infinity;
  for (const k of strikes) {
    let loss = 0;
    for (const r of rows) {
      loss += (r.CE?.openInterest ?? 0) * Math.max(0, k - r.strikePrice);
      loss += (r.PE?.openInterest ?? 0) * Math.max(0, r.strikePrice - k);
    }
    if (loss < bestLoss) { bestLoss = loss; best = k; }
  }
  return best;
}

export function buildLevels(
  oc: OptionChain,
  ohlc?: Ohlc,
  roundStep = 100
): LevelsResult {
  const S = oc.underlyingValue;
  const expiry = oc.expiryDates[0];
  const rows = oc.data.filter((r) => r.expiryDate === expiry);

  const above = rows.filter((r) => r.strikePrice >= S && r.CE);
  const below = rows.filter((r) => r.strikePrice <= S && r.PE);
  const byCeOiDesc = [...above].sort((a, b) => (b.CE!.openInterest) - (a.CE!.openInterest));
  const byPeOiDesc = [...below].sort((a, b) => (b.PE!.openInterest) - (a.PE!.openInterest));

  const levels: LevelMap = {
    oiResistance: byCeOiDesc[0]?.strikePrice,
    oiResistance2: byCeOiDesc[1]?.strikePrice,
    oiSupport: byPeOiDesc[0]?.strikePrice,
    oiSupport2: byPeOiDesc[1]?.strikePrice,
    maxPain: maxPain(rows),
    roundAbove: (Math.floor(S / roundStep) + 1) * roundStep,
    roundBelow: Math.floor(S / roundStep) * roundStep,
  };

  const atm = rows.reduce((a, b) => (Math.abs(b.strikePrice - S) < Math.abs(a.strikePrice - S) ? b : a));
  const straddle = (atm.CE?.lastPrice ?? 0) + (atm.PE?.lastPrice ?? 0);
  levels.expMoveUp = Math.round(S + 0.85 * straddle);
  levels.expMoveDown = Math.round(S - 0.85 * straddle);

  if (ohlc) {
    if (ohlc.pdh) levels.pdh = ohlc.pdh;
    if (ohlc.pdl) levels.pdl = ohlc.pdl;
    if (ohlc.vwap) levels.vwap = ohlc.vwap;
    if (ohlc.orHigh) levels.orHigh = ohlc.orHigh;
    if (ohlc.orLow) levels.orLow = ohlc.orLow;
    if (ohlc.weekHigh) levels.weekHigh = ohlc.weekHigh;
    if (ohlc.weekLow) levels.weekLow = ohlc.weekLow;
  }

  const entries = Object.entries(levels).filter(
    ([, v]) => typeof v === "number"
  ) as [string, number][];
  entries.sort((a, b) => a[1] - b[1]);

  const zones: ConfluenceZone[] = [];
  let cur: [string, number][] = entries.length ? [entries[0]] : [];
  for (let i = 1; i < entries.length; i++) {
    const [k, v] = entries[i];
    const [, prevV] = cur[cur.length - 1];
    if ((v - prevV) / S <= 0.0015) {
      cur.push([k, v]);
    } else {
      if (cur.length >= 3) {
        zones.push({
          priceRange: [cur[0][1], cur[cur.length - 1][1]],
          levels: cur.map((c) => c[0]),
          strength: cur.length,
        });
      }
      cur = [[k, v]];
    }
  }
  if (cur.length >= 3) {
    zones.push({
      priceRange: [cur[0][1], cur[cur.length - 1][1]],
      levels: cur.map((c) => c[0]),
      strength: cur.length,
    });
  }

  const top5 = [...rows]
    .sort(
      (a, b) =>
        (b.CE?.openInterest ?? 0) + (b.PE?.openInterest ?? 0) -
        ((a.CE?.openInterest ?? 0) + (a.PE?.openInterest ?? 0))
    )
    .slice(0, 5)
    .map((r) => r.strikePrice);

  const spreadPct = (leg?: { bidPrice?: number; askPrice?: number }): number | null => {
    if (!leg?.askPrice) return null;
    const b = leg.bidPrice ?? 0;
    return round((leg.askPrice - b) / leg.askPrice * 100, 2);
  };
  const spreadNearAtm: LevelsResult["spreadPctNearAtm"] = {};
  for (const r of rows) {
    if (Math.abs(r.strikePrice - S) / S < 0.01) {
      spreadNearAtm[r.strikePrice] = { CE: spreadPct(r.CE), PE: spreadPct(r.PE) };
    }
  }

  const levelsNearSpot = entries.filter(([, v]) => Math.abs(v - S) / S <= 0.002).map(([k]) => k);

  return {
    spot: S,
    levels,
    confluenceZones: zones,
    levelsNearSpot,
    liquidStrikesTop5Oi: top5,
    spreadPctNearAtm: spreadNearAtm,
  };
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
