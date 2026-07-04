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
// 75 five-minute candles (9:15-15:25) with realistic market behavior
// Natural reversals, pullbacks, both green/red candles, proper wicks
export function generateDayCandles(symbol: string, dateStr: string): HistoricalCandle[] {
  const basePrice = SYMBOL_BASE[symbol] || 24800;
  const seed = hashString(`${symbol}-${dateStr}`);
  const rng = mulberry32(seed);

  const totalCandles = 75;
  const [year, month, day] = dateStr.split("-").map(Number);

  // Daily volatility: 0.5-1.5%
  const dailyVol = 0.005 + rng() * 0.01;
  const dayOpen = basePrice * (1 + (rng() - 0.5) * dailyVol * 0.3);

  // Generate a realistic random walk with mean reversion
  const closes: number[] = [];
  let price = dayOpen;
  const dayHigh = dayOpen * (1 + dailyVol * (0.3 + rng() * 0.7));
  const dayLow = dayOpen * (1 - dailyVol * (0.3 + rng() * 0.7));
  const range = dayHigh - dayLow;
  const targetClose = dayLow + range * rng(); // random ending price

  for (let i = 0; i < totalCandles; i++) {
    const progress = i / (totalCandles - 1);
    // Mean reversion toward target with noise
    const reversion = (targetClose - price) * 0.03;
    // Random walk component
    const walk = (rng() - 0.5) * dailyVol * basePrice * 0.004;
    // Intraday volatility pattern: high at open/close, low at lunch
    const timeMult = progress < 0.15 ? 1.5 : progress < 0.45 ? 0.6 : progress < 0.75 ? 0.5 : 1.2;
    // Occasional larger moves (every ~15 candles)
    const shock = rng() < 0.07 ? (rng() - 0.5) * dailyVol * basePrice * 0.008 : 0;
    price += reversion + (walk + shock) * timeMult;
    // Respect range boundaries
    price = Math.max(dayLow, Math.min(dayHigh, price));
    closes.push(price);
  }

  // Build OHLCV candles with realistic wicks
  const candles: HistoricalCandle[] = [];
  for (let i = 0; i < totalCandles; i++) {
    const minutesFromOpen = i * 5;
    const totalMinutes = 9 * 60 + 15 + minutesFromOpen;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const open = i === 0 ? dayOpen : closes[i - 1];
    const close = closes[i];
    // Wick size: 20-80% of body in each direction (larger for visual clarity)
    const bodySize = Math.abs(close - open);
    const minWick = bodySize * 0.2;
    const maxWick = bodySize * 0.8 + range * 0.001; // minimum wick even for doji
    const wickUp = minWick + rng() * (maxWick - minWick);
    const wickDown = minWick + rng() * (maxWick - minWick);
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    // Volume: U-shaped pattern (high at open/close, low midday)
    const timeOfDay = minutesFromOpen / (totalCandles * 5);
    const baseVol = 3000000 + rng() * 4000000;
    const volMult = timeOfDay < 0.15 ? 1.8 : timeOfDay < 0.45 ? 0.6 : timeOfDay < 0.75 ? 0.5 : 1.5;
    const volume = Math.round(baseVol * volMult * (0.7 + rng() * 0.6));
    const pad = (n: number) => String(n).padStart(2, "0");
    candles.push({
      time: `${pad(hour)}:${pad(minute)}`,
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
