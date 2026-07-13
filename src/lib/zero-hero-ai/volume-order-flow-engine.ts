// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Volume & Order Flow Engine
// VWAP / Volume Profile / Delta Volume / CVD

export interface VolumeInput {
  candles: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: number;
  }[];
  spot: number;
}

export interface VolumeOutput {
  vwap: number;
  vwap_deviation: number;     // % deviation from VWAP
  volume_profile: {
    poc: number;              // Point of Control
    value_area_high: number;
    value_area_low: number;
  };
  delta_volume: number;       // Cumulative buy - sell volume estimate
  cvd: number;                // Cumulative Volume Delta
  volume_trend: 'ACCELERATING' | 'DECELERATING' | 'NEUTRAL';
  confidence: number;
}

function calculateVWAP(candles: VolumeInput['candles']): number {
  let sumPV = 0;
  let sumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    sumPV += typical * c.volume;
    sumV += c.volume;
  }
  return sumV > 0 ? sumPV / sumV : 0;
}

function calculateVolumeProfile(candles: VolumeInput['candles']): VolumeOutput['volume_profile'] {
  const bucketSize = 10;
  const buckets: { [price: number]: number } = {};
  for (const c of candles) {
    const bucket = Math.round(c.close / bucketSize) * bucketSize;
    buckets[bucket] = (buckets[bucket] || 0) + c.volume;
  }
  let poc = 0;
  let maxVol = 0;
  for (const [price, vol] of Object.entries(buckets)) {
    if (vol > maxVol) {
      maxVol = vol;
      poc = Number(price);
    }
  }
  const prices = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const vah = prices[prices.length - 1] || poc;
  const val = prices[0] || poc;
  return { poc, value_area_high: vah, value_area_low: val };
}

function calculateDeltaVolume(candles: VolumeInput['candles']): { delta: number; cvd: number } {
  let delta = 0;
  let cvd = 0;
  for (const c of candles) {
    // Estimate delta: if close > open, more buying
    const d = c.volume * (c.close > c.open ? 1 : c.close < c.open ? -1 : 0);
    delta += d;
    cvd += d;
  }
  return { delta, cvd };
}

export function volumeOrderFlowEngine(input: VolumeInput): VolumeOutput {
  const { candles, spot } = input;

  if (candles.length === 0) {
    return {
      vwap: spot,
      vwap_deviation: 0,
      volume_profile: { poc: spot, value_area_high: spot, value_area_low: spot },
      delta_volume: 0,
      cvd: 0,
      volume_trend: 'NEUTRAL',
      confidence: 0,
    };
  }

  const vwap = calculateVWAP(candles);
  const vwapDeviation = vwap > 0 ? ((spot - vwap) / vwap) * 100 : 0;
  const volumeProfile = calculateVolumeProfile(candles);
  const { delta, cvd } = calculateDeltaVolume(candles);

  // Volume trend
  const firstHalf = candles.slice(0, Math.floor(candles.length / 2));
  const secondHalf = candles.slice(Math.floor(candles.length / 2));
  const firstVol = firstHalf.reduce((s, c) => s + c.volume, 0);
  const secondVol = secondHalf.reduce((s, c) => s + c.volume, 0);
  let volumeTrend: 'ACCELERATING' | 'DECELERATING' | 'NEUTRAL';
  if (secondVol > firstVol * 1.2) volumeTrend = 'ACCELERATING';
  else if (secondVol < firstVol * 0.8) volumeTrend = 'DECELERATING';
  else volumeTrend = 'NEUTRAL';

  return {
    vwap,
    vwap_deviation: vwapDeviation,
    volume_profile: volumeProfile,
    delta_volume: delta,
    cvd,
    volume_trend: volumeTrend,
    confidence: 80,
  };
}
