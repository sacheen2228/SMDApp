// confidence-calibration.ts
// Turns STATED confidence into CALIBRATED confidence using resolved history, so the
// gate can floor on something that has actually been measured.
//
// The 65% floor is NOT lowered to let the old brain pass. Instead the stated number
// is mapped through the realised win-rate of its own band: if a 70% claim has only
// ever hit 40% of the time, the calibrated number is 40 and the floor applies.
import { calibrateConfidence } from "./agent-brain-gate";

export interface CalibrationSample {
  stated: number;      // confidence as the generator claimed it (0-100)
  won: boolean;        // did it win?
  r?: number | null;   // resolved R (nullable)
}

export interface ReliabilityBand {
  band: string;        // "0-20" | "21-40" | ...
  lo: number; hi: number;
  n: number;
  wins: number;
  realizedWR: number;      // 0-1
  expectancyR: number | null;
  avgR: number | null;
}

export const CONFIDENCE_BANDS: Array<{ band: string; lo: number; hi: number }> = [
  { band: "0-20", lo: 0, hi: 20 },
  { band: "21-40", lo: 21, hi: 40 },
  { band: "41-60", lo: 41, hi: 60 },
  { band: "61-80", lo: 61, hi: 80 },
  { band: "81-100", lo: 81, hi: 100 },
];

export function bandOf(stated: number): { band: string; lo: number; hi: number } {
  const s = Math.max(0, Math.min(100, Number(stated) || 0));
  for (const b of CONFIDENCE_BANDS) if (s <= b.hi) return b;
  return CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
}

/** Stated band → realised win-rate / n / expectancy R. */
export function reliabilityTable(samples: CalibrationSample[]): ReliabilityBand[] {
  return CONFIDENCE_BANDS.map((b) => {
    const rows = samples.filter((s) => {
      const v = Math.max(0, Math.min(100, Number(s.stated) || 0));
      return v >= b.lo && v <= b.hi;
    });
    const n = rows.length;
    const wins = rows.filter((r) => r.won).length;
    const rs = rows.map((r) => r.r).filter((x): x is number => x != null);
    return {
      ...b,
      n,
      wins,
      realizedWR: n ? wins / n : 0,
      expectancyR: rs.length ? rs.reduce((s2, x) => s2 + x, 0) / rs.length : null,
      avgR: rs.length ? rs.reduce((s2, x) => s2 + x, 0) / rs.length : null,
    };
  });
}

/** The band lookup calibrateConfidence() expects: realised hit-rate + sample size. */
export function bandCalibration(table: ReliabilityBand[], stated: number): { realizedHitPct?: number; n?: number } {
  const b = bandOf(stated);
  const row = table.find((t) => t.band === b.band);
  if (!row || row.n < 20) return {};           // not enough history → keep the haircut default
  return { realizedHitPct: Math.round(row.realizedWR * 100), n: row.n };
}

/** Calibrated confidence for a stated number, given a reliability table. */
export function calibratedConfidence(stated: number, table: ReliabilityBand[]): number {
  return calibrateConfidence(stated, bandCalibration(table, stated));
}

/**
 * Calibration drift: how far the realised win-rate of a band has moved since the
 * reference table was built. Positive = the band is performing better than assumed.
 */
export function calibrationDrift(current: ReliabilityBand[], reference: ReliabilityBand[]): Array<{ band: string; drift: number; n: number }> {
  return current.map((c) => {
    const ref = reference.find((r) => r.band === c.band);
    const refWR = ref && ref.n >= 20 ? ref.realizedWR : null;
    return { band: c.band, drift: refWR == null ? 0 : c.realizedWR - refWR, n: c.n };
  });
}
