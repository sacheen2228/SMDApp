import type { Candle } from '@/types/engine';
import type { AuctionResult } from './types';
import { computeVWAP } from '@/indicators/vwap';

export function analyzeAuction(candles: Candle[], price: number): AuctionResult {
  const len = candles.length;
  if (len < 10) {
    return {
      acceptance: false, rejection: true,
      poc: price, vah: price * 1.02, val: price * 0.98,
      hvn: [], lvn: [],
      developingPOC: price, valueMigrating: 'SIDEWAYS',
      initialBalance: { high: price * 1.01, low: price * 0.99 },
      rangeExtension: { up: 0, down: 0 },
      singlePrints: [], poorHigh: false, poorLow: false,
      excess: false, developingValue: { high: price * 1.01, low: price * 0.99 },
      confidence: 0.2, reason: 'Insufficient data',
    };
  }

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);

  // ================================================================
  // INITIAL BALANCE — first 4 candles (approx 30-60m)
  // ================================================================
  const ibCandles = len < 4 ? len : 4;
  const ibHigh = Math.max(...highs.slice(0, ibCandles));
  const ibLow = Math.min(...lows.slice(0, ibCandles));

  // ================================================================
  // VOLUME PROFILE — 20-bin POC, VAH, VAL, HVN, LVN
  // ================================================================
  const totalRange = Math.max(...highs) - Math.min(...lows);
  const bucketCount = 20;
  const bucketSize = totalRange / bucketCount || 1;
  const minPrice = Math.min(...lows);

  const buckets = new Array(bucketCount).fill(0);
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((tp - minPrice) / bucketSize)));
    buckets[idx] += c.volume;
  }

  const maxVol = Math.max(...buckets);
  const pocIdx = maxVol > 0 ? buckets.indexOf(maxVol) : Math.floor(bucketCount / 2);
  const poc = minPrice + (pocIdx + 0.5) * bucketSize;

  // VAH/VAL — 70% value area
  const totalVol = buckets.reduce((s, v) => s + v, 0);
  let cum = 0;
  let vahIdx = pocIdx;
  let valIdx = pocIdx;
  for (let i = pocIdx; i < bucketCount && cum / totalVol < 0.7; i++) { cum += buckets[i]; vahIdx = i; }
  cum = 0;
  for (let i = pocIdx; i >= 0 && cum / totalVol < 0.7; i--) { cum += buckets[i]; valIdx = i; }

  const vah = minPrice + (vahIdx + 0.5) * bucketSize;
  const val = minPrice + (valIdx + 0.5) * bucketSize;

  // HVN (High Volume Nodes) — buckets > 70% of maxVol
  const hvnThreshold = maxVol * 0.7;
  const hvn: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    if (buckets[i] >= hvnThreshold) {
      hvn.push(minPrice + (i + 0.5) * bucketSize);
    }
  }

  // LVN (Low Volume Nodes / Liquidity Voids) — buckets between VAH and VAL with < 20% of maxVol
  const lvnThreshold = maxVol * 0.2;
  const lvn: number[] = [];
  for (let i = valIdx; i <= vahIdx; i++) {
    if (buckets[i] <= lvnThreshold) {
      lvn.push(minPrice + (i + 0.5) * bucketSize);
    }
  }

  // ================================================================
  // DEVELOPING POC — POC of last 40% of candles
  // ================================================================
  const recentStart = Math.floor(len * 0.6);
  const recentBuckets = new Array(bucketCount).fill(0);
  for (let i = recentStart; i < len; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((tp - minPrice) / bucketSize)));
    recentBuckets[idx] += c.volume;
  }
  const recentMaxVol = Math.max(...recentBuckets);
  const recentPocIdx = recentMaxVol > 0 ? recentBuckets.indexOf(recentMaxVol) : pocIdx;
  const developingPOC = minPrice + (recentPocIdx + 0.5) * bucketSize;

  // POC migration
  const pocMigrating = developingPOC > poc ? 'UP' : developingPOC < poc ? 'DOWN' : 'SIDEWAYS';

  // ================================================================
  // DEVELOPING VALUE — last 40% of candles
  // ================================================================
  const devHigh = Math.max(...highs.slice(recentStart));
  const devLow = Math.min(...lows.slice(recentStart));
  const developingValue = { high: devHigh, low: devLow };

  // ================================================================
  // RANGE EXTENSION — price beyond IB
  // ================================================================
  const rangeExtension = {
    up: Math.max(0, devHigh - ibHigh),
    down: Math.max(0, ibLow - devLow),
  };

  // ================================================================
  // SINGLE PRINTS — candle that trades beyond prior range
  // ================================================================
  const singlePrints: number[] = [];
  for (let i = 1; i < len; i++) {
    if (candles[i].low > candles[i - 1].close) {
      singlePrints.push(candles[i].low);
    }
    if (candles[i].high < candles[i - 1].close) {
      singlePrints.push(candles[i].high);
    }
  }

  // ================================================================
  // POOR HIGH / POOR LOW — extension rejected
  // ================================================================
  const last5 = candles.slice(-5);
  const poorHigh = last5.some(c => c.high > vah) && last5.every(c => c.close < vah);
  const poorLow = last5.some(c => c.low < val) && last5.every(c => c.close > val);

  // ================================================================
  // EXCESS — price beyond value area with weak volume
  // ================================================================
  const excessHigh = last5.some(c => c.high > vah) && last5.slice(-2).every(c => c.volume < maxVol * 0.4);
  const excessLow = last5.some(c => c.low < val) && last5.slice(-2).every(c => c.volume < maxVol * 0.4);
  const excess = excessHigh || excessLow;

  // ================================================================
  // ACCEPTANCE / REJECTION
  // ================================================================
  const vwap = computeVWAP(candles);
  const nearVWAP = Math.abs(price - vwap) / vwap < 0.003;
  const insideValue = price >= val && price <= vah;
  const outsideValue = price > vah || price < val;

  // Acceptance: price inside value, near VWAP, multiple closes inside
  const closesInsideValue = closes.filter(c => c >= val && c <= vah).length;
  const closesOutsideValue = closes.filter(c => c < val || c > vah).length;
  const acceptance = closesInsideValue > closesOutsideValue && insideValue && nearVWAP;
  const rejection = poorHigh || poorLow || excess || (outsideValue && !excess);

  // ================================================================
  // CONFIDENCE & REASON
  // ================================================================
  let reason = '';
  let confidence = 0.5;

  if (acceptance) {
    reason = `Price accepted near VWAP (${vwap.toFixed(2)}) inside value area (${val.toFixed(2)}–${vah.toFixed(2)})`;
    confidence = 0.75;
  } else if (rejection && excessHigh) {
    reason = `Excess above VAH (${vah.toFixed(2)}) with weak volume — price rejected`;
    confidence = 0.7;
  } else if (rejection && excessLow) {
    reason = `Excess below VAL (${val.toFixed(2)}) with weak volume — price rejected`;
    confidence = 0.7;
  } else if (poorHigh) {
    reason = `Poor high — price failed to hold above value area`;
    confidence = 0.65;
  } else if (poorLow) {
    reason = `Poor low — price failed to hold below value area`;
    confidence = 0.65;
  } else if (insideValue && !nearVWAP) {
    reason = `Inside value area but away from VWAP — testing`;
    confidence = 0.5;
  } else if (outsideValue && excess) {
    reason = excessHigh ? 'Price above value with excess, not rejected yet' : 'Price below value with excess, not rejected yet';
    confidence = 0.5;
  } else {
    reason = 'No clear acceptance or rejection';
    confidence = 0.4;
  }

  return {
    acceptance,
    rejection,
    poc,
    vah,
    val,
    hvn,
    lvn,
    developingPOC,
    valueMigrating: pocMigrating,
    initialBalance: { high: ibHigh, low: ibLow },
    rangeExtension,
    singlePrints,
    poorHigh,
    poorLow,
    excess,
    developingValue,
    confidence: parseFloat(confidence.toFixed(2)),
    reason,
  };
}
