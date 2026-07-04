// Historical Candle Data Generator
// Generates deterministic OHLCV candles for any past date/symbol using seeded PRNG
// Produces realistic intraday volatility with S/R level crossings for backtesting

// ─── Seeded PRNG (Mulberry32) ──────────────────────────────────
function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

// ─── Symbol Base Prices ────────────────────────────────────────
const SYMBOL_BASE: Record<string, number> = {
  NIFTY: 24800,
  BANKNIFTY: 52500,
  FINNIFTY: 23200,
  MIDCPNIFTY: 12800,
  SENSEX: 81500,
};

// ─── Types ──────────────────────────────────────────────────────
export interface HistoricalCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

export interface DayOHLC {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Generate Full Day Candles ──────────────────────────────────
// 75 five-minute candles (9:15-15:25) with realistic volatility
// Candles are designed to cross S/R levels to trigger breakout signals
export function generateDayCandles(symbol: string, dateStr: string): HistoricalCandle[] {
  const basePrice = SYMBOL_BASE[symbol] || 24800;
  const seed = hashString(`${symbol}-${dateStr}`);
  const rng = mulberry32(seed);

  // Daily parameters
  const dailyVol = 0.006 + rng() * 0.014; // 0.6-2% daily range
  const dailyBias = (rng() - 0.45) * dailyVol * 2; // slight upward bias
  const dayOpen = basePrice * (1 + (rng() - 0.5) * dailyVol * 0.5);

  // Generate intraday S/R levels (these will be "broken" during the day)
  const srOffset1 = dayOpen * dailyVol * (0.3 + rng() * 0.4); // 0.3-0.7% from open
  const srOffset2 = dayOpen * dailyVol * (0.5 + rng() * 0.5); // 0.5-1% from open
  const sr1 = dayOpen + srOffset1 * (rng() > 0.5 ? 1 : -1); // resistance or support
  const sr2 = dayOpen - srOffset1 * (rng() > 0.5 ? 1 : -1); // opposite side
  const sr3 = dayOpen + srOffset2 * (rng() > 0.5 ? 1 : -1); // farther level

  // Create a path that WILL cross at least one S/R level
  const totalCandles = 75;
  const [year, month, day] = dateStr.split("-").map(Number);

  // Phase 1: Opening range (9:15-9:45) - establishes initial direction
  // Phase 2: Trend phase - moves toward first S/R
  // Phase 3: Breakout phase - crosses S/R level
  // Phase 4: Continuation or reversal
  // Phase 5: Closing phase

  const path: number[] = [];
  let currentPrice = dayOpen;

  // Determine which S/R to break first
  const breakTarget = rng() > 0.5 ? sr1 : sr2;
  const breakDirection = breakTarget > dayOpen ? 1 : -1;

  for (let i = 0; i < totalCandles; i++) {
    const progress = i / totalCandles;
    let move = 0;

    if (progress < 0.15) {
      // Phase 1: Opening range - small moves
      move = (rng() - 0.5) * dailyVol * basePrice * 0.003;
    } else if (progress < 0.35) {
      // Phase 2: Trend toward S/R - directional move
      const distToTarget = (breakTarget - currentPrice) / currentPrice;
      move = distToTarget * basePrice * 0.08 + (rng() - 0.5) * dailyVol * basePrice * 0.002;
    } else if (progress < 0.50) {
      // Phase 3: Breakout - strong move through S/R
      const distToTarget = (breakTarget - currentPrice) / currentPrice;
      move = distToTarget * basePrice * 0.15 + (rng() - 0.5) * dailyVol * basePrice * 0.003;
    } else if (progress < 0.70) {
      // Phase 4: Continuation or pullback
      const momentum = breakDirection * dailyVol * basePrice * 0.001;
      move = momentum + (rng() - 0.5) * dailyVol * basePrice * 0.004;
    } else {
      // Phase 5: Closing - can reverse or continue
      const closeBias = dailyBias * basePrice * 0.0005;
      move = closeBias + (rng() - 0.5) * dailyVol * basePrice * 0.003;
    }

    currentPrice += move;

    // Add realistic noise (candle-to-candle volatility)
    const noise = (rng() - 0.5) * dailyVol * basePrice * 0.002;
    currentPrice += noise;

    // Clamp to reasonable range (within 2% of open)
    const maxMove = dayOpen * 0.02;
    currentPrice = Math.max(dayOpen - maxMove, Math.min(dayOpen + maxMove, currentPrice));

    path.push(currentPrice);
  }

  // Ensure path crosses at least one S/R level
  const crossesSR = path.some((p) => Math.abs(p - sr1) / sr1 < 0.002 || Math.abs(p - sr2) / sr2 < 0.002);
  if (!crossesSR) {
    // Force a crossing at candle 35-45
    const crossIdx = 35 + Math.floor(rng() * 10);
    path[crossIdx] = breakTarget;
    path[crossIdx + 1] = breakTarget + breakDirection * dayOpen * 0.001;
  }

  // Convert path to OHLCV candles
  const candles: HistoricalCandle[] = [];
  for (let i = 0; i < totalCandles; i++) {
    const minutesFromOpen = i * 5;
    const totalMinutes = 9 * 60 + 15 + minutesFromOpen;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;

    const open = i === 0 ? dayOpen : path[i - 1];
    const close = path[i];

    // Realistic wicks (10-40% of body in each direction)
    const bodySize = Math.abs(close - open);
    const wickUp = bodySize * (0.1 + rng() * 0.4);
    const wickDown = bodySize * (0.1 + rng() * 0.4);
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;

    // Volume pattern: higher at open/close, lower midday
    const timeOfDay = minutesFromOpen / (totalCandles * 5);
    let volMultiplier = 1;
    if (timeOfDay < 0.1) volMultiplier = 2.5;
    else if (timeOfDay > 0.9) volMultiplier = 2.0;
    else if (timeOfDay > 0.3 && timeOfDay < 0.5) volMultiplier = 0.6;

    // Breakout candles get extra volume
    const isNearSR = Math.abs(close - sr1) / sr1 < 0.003 || Math.abs(close - sr2) / sr2 < 0.003;
    if (isNearSR) volMultiplier *= 1.8;

    const volume = Math.round((800000 + rng() * 1200000) * volMultiplier);

    candles.push({
      time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
      timestamp: new Date(year, month - 1, day, hour, minute),
    });
  }

  return candles;
}

// ─── Generate Previous Day OHLC ─────────────────────────────────
export function generatePreviousDayOHLC(symbol: string, dateStr: string): DayOHLC {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  const prevDateStr = d.toISOString().split("T")[0];
  const candles = generateDayCandles(symbol, prevDateStr);

  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const totalVol = candles.reduce((s, c) => s + c.volume, 0);

  return {
    open: opens[0],
    high: Math.max(...highs),
    low: Math.min(...lows),
    close: closes[closes.length - 1],
    volume: totalVol,
  };
}

// ─── Generate GIFT Nifty Estimate ──────────────────────────────
export function generateGiftNiftyEstimate(symbol: string, dateStr: string): number {
  const basePrice = SYMBOL_BASE[symbol] || 24800;
  const seed = hashString(`gift-${symbol}-${dateStr}`);
  const rng = mulberry32(seed);
  return Math.round(basePrice * (1 + (rng() - 0.48) * 0.005) * 100) / 100;
}
