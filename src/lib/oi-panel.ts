// OI panel helpers — pure functions for the Simple-tab Sensibull-style OI view.
// No network, no randomness: every number here comes from real chain payloads
// or the market-history recorder.

export interface OiLeg {
  oi: number;
  oiChg: number;
}

export interface OiStrikeRow {
  strike: number;
  ce: OiLeg | null;
  pe: OiLeg | null;
}

/** One recorded chain snapshot from the market-history sidecar. */
export interface ChainSnapshot {
  timestamp: string;
  rows: { strike: number; ceOi: number; peOi: number }[];
}

/** Sensibull's expiries sidebar allows aggregating at most this many contracts. */
export const MAX_AGGREGATE_EXPIRIES = 3;

/**
 * Default strike window for the chart: ATM ± `span` rounded INWARD to the
 * `step` grid so the bounds are always listed strikes.
 */
export function deriveStrikeRange(
  spot: number,
  atm: number,
  step: number,
  span = 500,
): { min: number; max: number } {
  const base = Number.isFinite(atm) && atm > 0 ? atm : spot;
  const s = step > 0 ? step : 50;
  const min = Math.max(0, Math.ceil((base - span) / s) * s);
  const max = Math.floor((base + span) / s) * s;
  return min <= max ? { min, max } : { min: base, max: base };
}

/**
 * Sensibull's "Strikes above and below ATM" filter.
 * `"all"` keeps everything; `n` keeps n strikes either side of ATM + ATM itself.
 * When ATM is not an exact listed strike the nearest listed strike is used.
 */
export function sliceStrikesAroundATM(
  strikes: number[],
  atm: number,
  n: number | "all",
): number[] {
  const sorted = [...strikes].sort((a, b) => a - b);
  if (n === "all" || sorted.length === 0) return sorted;
  let idx = 0;
  let best = Infinity;
  sorted.forEach((s, i) => {
    const d = Math.abs(s - atm);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const from = Math.max(0, idx - n);
  const to = Math.min(sorted.length - 1, idx + n);
  return sorted.slice(from, to + 1);
}

/**
 * Sum per-strike OI / OI-change across several expiry payloads
 * (Sensibull's "Expiries Included" checkboxes). Strikes missing from a
 * payload simply contribute nothing; legs missing on a row count as zero.
 */
export function aggregateStrikes(payloads: OiStrikeRow[][]): OiStrikeRow[] {
  const byStrike = new Map<number, OiStrikeRow>();
  for (const payload of payloads) {
    for (const r of payload) {
      const cur = byStrike.get(r.strike) ?? { strike: r.strike, ce: null, pe: null };
      cur.ce = {
        oi: (cur.ce?.oi ?? 0) + (r.ce?.oi ?? 0),
        oiChg: (cur.ce?.oiChg ?? 0) + (r.ce?.oiChg ?? 0),
      };
      cur.pe = {
        oi: (cur.pe?.oi ?? 0) + (r.pe?.oi ?? 0),
        oiChg: (cur.pe?.oiChg ?? 0) + (r.pe?.oiChg ?? 0),
      };
      byStrike.set(r.strike, cur);
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * Per-strike OI change over the last `windowMs`, computed from recorded
 * chain snapshots (the exchange only publishes full-day changeinOpenInterest).
 * Baseline = snapshot nearest to (now - window); anything not in the
 * baseline counts as a change of +its current OI.
 */
export function windowOiChange(
  history: ChainSnapshot[],
  windowMs: number,
  nowMs: number,
): { strike: number; ceChg: number; peChg: number }[] {
  if (history.length === 0) return [];
  const sorted = [...history].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const target = nowMs - windowMs;
  let baseline = sorted[0];
  for (const snap of sorted) {
    if (Date.parse(snap.timestamp) <= target) baseline = snap;
    else break;
  }
  const latest = sorted[sorted.length - 1];
  const baseByStrike = new Map(baseline.rows.map((r) => [r.strike, r]));
  return latest.rows.map((r) => {
    const b = baseByStrike.get(r.strike);
    return {
      strike: r.strike,
      ceChg: r.ceOi - (b?.ceOi ?? 0),
      peChg: r.peOi - (b?.peOi ?? 0),
    };
  });
}

/** Indian L/Cr notation used by Sensibull (22.36 L, 3.46 Cr, -75.08 L). */
export function formatLakhCrore(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Checkbox toggle for the expiries sidebar, capped at
 * MAX_AGGREGATE_EXPIRIES — a 4th selection is refused (state unchanged).
 */
export function toggleExpiry(
  selected: string[],
  expiry: string,
  checked: boolean,
): string[] {
  if (checked) {
    if (selected.includes(expiry)) return selected;
    if (selected.length >= MAX_AGGREGATE_EXPIRIES) return selected;
    return [...selected, expiry];
  }
  return selected.filter((e) => e !== expiry);
}
