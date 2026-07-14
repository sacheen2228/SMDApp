import { HistoricalRecord, GapDirection } from "./types";
import { predictGap, DEFAULT_WEIGHTS } from "./gap-engine";
import { GapWeights } from "./types";

// ─── Yahoo Finance Historical Data ──────────────────────────────

interface YahooChartResult {
  timestamp: number[];
  indicators: {
    quote: { close: number[]; open: number[]; high: number[]; low: number[]; volume: number[] }[];
    adjclose: { adjclose: number[] }[];
  };
}

async function fetchYahooHistory(symbol: string, range: string = "1y", interval: string = "1d"): Promise<YahooChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.chart?.result?.[0] || null;
  } catch {
    return null;
  }
}

// ─── Historical Gap Data Collection ────────────────────────────

export interface DailyCandle {
  date: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function collectHistoricalCandles(
  symbol: string = "^NSEI",
  range: string = "2y"
): Promise<DailyCandle[]> {
  const result = await fetchYahooHistory(symbol, range);
  if (!result || !result.timestamp?.length) return [];

  const closes = result.indicators.quote[0].close;
  const opens = result.indicators.quote[0].open;
  const highs = result.indicators.quote[0].high;
  const lows = result.indicators.quote[0].low;
  const volumes = result.indicators.quote[0].volume;

  const candles: DailyCandle[] = [];
  for (let i = 1; i < result.timestamp.length; i++) {
    const prevClose = closes[i - 1];
    const open = opens[i];
    if (!prevClose || !open || !isFinite(prevClose) || !isFinite(open)) continue;

    candles.push({
      date: new Date(result.timestamp[i] * 1000).toISOString().split("T")[0],
      prevClose,
      open,
      high: highs[i] || 0,
      low: lows[i] || 0,
      close: closes[i] || 0,
      volume: volumes[i] || 0,
    });
  }
  return candles;
}

export function computeHistoricalRecords(candles: DailyCandle[]): HistoricalRecord[] {
  const records: HistoricalRecord[] = [];

  for (const candle of candles) {
    const gap = candle.open - candle.prevClose;
    const gapPct = candle.prevClose > 0 ? (gap / candle.prevClose) * 100 : 0;
    let actualDirection: GapDirection;
    if (gapPct > 0.15) actualDirection = "UP";
    else if (gapPct < -0.15) actualDirection = "DOWN";
    else actualDirection = "FLAT";

    records.push({
      date: candle.date,
      prevClose: candle.prevClose,
      openPrice: candle.open,
      actualGap: gap,
      actualGapPct: gapPct,
      actualDirection,
      predictedDirection: null,
      predictedProbability: null,
      correct: null,
      factors: null,
    });
  }

  return records;
}

// ─── Run predictions on historical records ──────────────────────

export async function runHistoricalPrediction(
  records: HistoricalRecord[],
  weights: GapWeights = DEFAULT_WEIGHTS
): Promise<HistoricalRecord[]> {
  const results: HistoricalRecord[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const prevRecords = records.slice(0, i);

    // Compute historical stats from previous records
    const histStats = computeHistoricalStats(prevRecords);

    const input = {
      prevClose: rec.prevClose,
      currentSpot: rec.openPrice,
      currentFutures: null,
      giftNiftyPrice: rec.openPrice,
      giftNiftyPrevClose: rec.prevClose,
      indiaVIX: null,
      pcrOI: null,
      pcrVolume: null,
      maxPain: null,
      ceOIChange: null,
      peOIChange: null,
      optionIV: null,
      futuresPremium: null,
      breadth: null,
      atr: null,
      vwapDistance: null,
      fiiNet: null,
      diiNet: null,
      usMarketChange: null,
      asianMarketChange: null,
      usdinr: null,
      crudeChange: null,
      newsRiskScore: null,
      economicCalendarRisk: null,
      historicalGapUpPct: histStats?.gapUpProb ?? null,
      historicalGapDownPct: histStats?.gapDownProb ?? null,
      historicalGapStats: histStats,
      timestamp: new Date(rec.date).toISOString(),
      symbol: "NIFTY",
    };

    const prediction = predictGap(input, weights);

    results.push({
      ...rec,
      predictedDirection: prediction.insufficientData ? null : prediction.prediction,
      predictedProbability: prediction.insufficientData ? null : prediction.probability,
      correct: prediction.insufficientData ? null : prediction.prediction === rec.actualDirection,
      factors: prediction.factors,
    });
  }

  return results;
}

// ─── Historical Stats Computation ───────────────────────────────

function computeHistoricalStats(records: HistoricalRecord[]): {
  meanGap: number;
  stdGap: number;
  gapUpProb: number;
  gapDownProb: number;
  medianGapUp: number;
  medianGapDown: number;
  last20Accuracy: number;
  totalSamples: number;
} | null {
  if (records.length < 5) return null;

  const gaps = records.map(r => r.actualGapPct);
  const validGaps = gaps.filter(g => isFinite(g));
  if (validGaps.length < 5) return null;

  const meanGap = validGaps.reduce((s, g) => s + g, 0) / validGaps.length;
  const stdGap = Math.sqrt(validGaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / validGaps.length);

  const gapUps = validGaps.filter(g => g > 0.15);
  const gapDowns = validGaps.filter(g => g < -0.15);
  const upMed = gapUps.sort((a, b) => a - b)[Math.floor(gapUps.length / 2)] || 0;
  const downMed = gapDowns.sort((a, b) => a - b)[Math.floor(gapDowns.length / 2)] || 0;

  // Last 20 accuracy (among those with predictions)
  const last20 = records.slice(-20).filter(r => r.correct !== null);
  const last20Acc = last20.length > 0 ? last20.filter(r => r.correct).length / last20.length * 100 : 0;

  return {
    meanGap,
    stdGap,
    gapUpProb: validGaps.length > 0 ? gapUps.length / validGaps.length : 0,
    gapDownProb: validGaps.length > 0 ? gapDowns.length / validGaps.length : 0,
    medianGapUp: upMed,
    medianGapDown: downMed,
    last20Accuracy: last20Acc,
    totalSamples: validGaps.length,
  };
}

// ─── Simple Test without external API ───────────────────────────

export function generateMockHistoricalRecords(count: number): HistoricalRecord[] {
  const records: HistoricalRecord[] = [];
  let prevClose = 24000;
  for (let i = 0; i < count; i++) {
    const dir = Math.random();
    let open: number;
    if (dir < 0.4) {
      // Gap up: +0.2 to +1.0%
      open = prevClose * (1 + 0.002 + Math.random() * 0.008);
    } else if (dir < 0.7) {
      // Gap down: -0.2 to -0.8%
      open = prevClose * (1 - 0.002 - Math.random() * 0.006);
    } else {
      // Flat: within ±0.15%
      open = prevClose * (1 + (Math.random() - 0.5) * 0.003);
    }
    const gapPct = (open - prevClose) / prevClose * 100;
    const actualDirection: GapDirection = gapPct > 0.15 ? "UP" : gapPct < -0.15 ? "DOWN" : "FLAT";
    records.push({
      date: `2026-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 30) + 1).padStart(2, "0")}`,
      prevClose,
      openPrice: open,
      actualGap: open - prevClose,
      actualGapPct: gapPct,
      actualDirection,
      predictedDirection: null,
      predictedProbability: null,
      correct: null,
      factors: null,
    });
    prevClose = open * (1 + (Math.random() - 0.5) * 0.02); // intraday move
  }
  return records;
}
