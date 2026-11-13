// option-iv-enrich.ts — fill missing exchange IV from the NSE chain, by strike.
//
// Why: the provider race never merges legs (prices/OI stay single-provider),
// but IV is a property of the CONTRACT, not of the price feed. Breeze/MO ship
// no IV; NSE publishes impliedVolatility. When the winner has no IV we copy
// NSE's own IV onto matching strikes — never an estimate — so the route's
// existing applyGreeks (Black-Scholes on exchange IV) can produce delta/gamma.
// A leg that still has no IV after this stays null (no greeks) — honest.

export interface IvLeg {
  iv?: number | null;
  [k: string]: any;
}
export interface IvStrike {
  strike: number;
  ce?: IvLeg | null;
  pe?: IvLeg | null;
  [k: string]: any;
}

/** True when a leg's IV is missing/unusable (null, undefined, 0, NaN). */
export function ivMissing(iv: any): boolean {
  const n = Number(iv);
  return !Number.isFinite(n) || n <= 0;
}

/** Does this chain need an IV enrich pass? (any ATM±10% leg missing IV) */
export function needsIvEnrichment(strikes: IvStrike[], spot: number): boolean {
  if (!Array.isArray(strikes) || !strikes.length || !(spot > 0)) return false;
  const band = spot * 0.1;
  let checked = 0;
  let missing = 0;
  for (const s of strikes) {
    if (Math.abs(Number(s.strike) - spot) > band) continue;
    for (const leg of [s.ce, s.pe]) {
      if (!leg) continue;
      checked++;
      if (ivMissing(leg.iv)) missing++;
    }
  }
  // Need enrich when the near-the-money legs mostly lack IV.
  return checked > 0 && missing >= Math.ceil(checked / 2);
}

/**
 * Copy NSE published IV onto strikes that lack it, matching by strike number.
 * Only fills `iv` — never prices, OI, or volume. Returns how many legs were filled.
 */
export function mergeNseIv(
  strikes: IvStrike[],
  nseRows: any[],
): { strikes: IvStrike[]; filled: number; nseIvCount: number } {
  if (!Array.isArray(strikes) || !strikes.length || !Array.isArray(nseRows) || !nseRows.length) {
    return { strikes, filled: 0, nseIvCount: 0 };
  }
  const byStrike = new Map<number, { ce?: any; pe?: any }>();
  let nseIvCount = 0;
  for (const row of nseRows) {
    const k = Number(row?.strikePrice ?? row?.strike);
    if (!Number.isFinite(k)) continue;
    const ceIv = Number(row?.CE?.impliedVolatility ?? row?.ce?.iv);
    const peIv = Number(row?.PE?.impliedVolatility ?? row?.pe?.iv);
    if (Number.isFinite(ceIv) && ceIv > 0) nseIvCount++;
    if (Number.isFinite(peIv) && peIv > 0) nseIvCount++;
    byStrike.set(k, {
      ce: Number.isFinite(ceIv) && ceIv > 0 ? ceIv : null,
      pe: Number.isFinite(peIv) && peIv > 0 ? peIv : null,
    });
  }
  if (!byStrike.size || !nseIvCount) return { strikes, filled: 0, nseIvCount: 0 };

  let filled = 0;
  const out = strikes.map((s) => {
    const src = byStrike.get(Number(s.strike));
    if (!src) return s;
    const next: IvStrike = { ...s };
    if (s.ce && ivMissing(s.ce.iv) && src.ce != null) {
      next.ce = { ...s.ce, iv: src.ce };
      filled++;
    }
    if (s.pe && ivMissing(s.pe.iv) && src.pe != null) {
      next.pe = { ...s.pe, iv: src.pe };
      filled++;
    }
    return next;
  });
  return { strikes: out, filled, nseIvCount };
}
