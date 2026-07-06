// MASTER TRADE BOT ENGINE v3.0
// Multi-timeframe Nifty/Sensex correlation trading bot
// Ported from Python — runs in browser/API

const NIFTY_TICKER = "^NSEI";
const SENSEX_TICKER = "^BSESN";

// ═══════ SETTINGS ═══════
export const BOT_CONFIG = {
  CAPITAL: 100000,
  RISK_PER_TRADE_PCT: 2.0,
  LOT_SIZE_NIFTY: 65,
  LOT_SIZE_SENSEX: 20,
  STRIKE_STEP_NIFTY: 50,
  STRIKE_STEP_SENSEX: 100,
  SL_PCT_OF_PREMIUM: 0.35,
  TP_MIN_RR: 2.0,
  GAP_THRESHOLD: 0.5,
  CORR_BREAKDOWN: 0.94,
  EMA_ZONE_PCT: 0.3,
};

// ATR multipliers by timeframe
const ATR_MULT: Record<string, { tp: number; sl: number }> = {
  "3min": { tp: 0.4, sl: 0.2 },
  "5min": { tp: 0.5, sl: 0.25 },
  "15min": { tp: 0.6, sl: 0.3 },
  "1hour": { tp: 0.8, sl: 0.4 },
  daily: { tp: 1.0, sl: 0.5 },
};

// ═══════ TYPES ═══════
export interface ExpiryStatus {
  isExpiry: boolean;
  daysToExp: number;
  strikeType: "ITM" | "ATM_or_ITM" | "ATM";
  maxHoldHours: number;
  riskMultiplier: number;
  exitTime: string;
  note: string;
  index: string;
}

export interface Signal {
  timeframe: string;
  setup: string;
  direction: string;
  strength: string;
  details: string;
}

export interface TradePlan {
  setup: string;
  index: string;
  direction: string;
  strike: number;
  spot: number;
  entryPremium: number;
  slPremium: number;
  tpPremium: number;
  lots: number;
  totalPremium: number;
  maxRisk: number;
  rr: number;
  confidence: string;
  timeframe: string;
  expiryNote: string;
  exitTime: string;
  reasons: string[];
}

export interface MarketSnapshot {
  nifty: number;
  sensex: number;
  niftyChange: number;
  sensexChange: number;
  corr5d: number;
  returnDiff: number;
  niftyVol: number;
  sensexVol: number;
  timeframeStatus: Record<string, { corr: number; diff: number; status: string }>;
}

// ═══════ HELPER FUNCTIONS ═══════
function roundToNearest(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function getAtmStrike(indexPrice: number, step: number): number {
  return roundToNearest(indexPrice, step);
}

function getItmStrike(
  indexPrice: number,
  step: number,
  direction: string,
  offset = 1
): number {
  const atm = getAtmStrike(indexPrice, step);
  return direction === "CALL" ? atm - offset * step : atm + offset * step;
}

function estimatePremium(
  strike: number,
  spot: number,
  direction: string,
  daysToExpiry: number,
  volatility: number,
  isExpiryDay = false
): number {
  const intrinsic =
    direction === "CALL"
      ? Math.max(0, spot - strike)
      : Math.max(0, strike - spot);

  if (isExpiryDay) return Math.max(intrinsic, 5);

  const timeValue =
    spot * (volatility / 100) * Math.sqrt(daysToExpiry / 365) * 0.5;
  const moneyness = Math.abs(strike - spot) / spot;
  const adjustedTimeValue =
    moneyness > 0.01 ? timeValue * Math.max(0.3, 1 - moneyness * 10) : timeValue;

  return Math.max(intrinsic + adjustedTimeValue, 10);
}

function calculatePositionSize(
  capital: number,
  riskPct: number,
  entryPremium: number,
  slPremium: number,
  lotSize: number
): number {
  const riskPerLot = (entryPremium - slPremium) * lotSize;
  if (riskPerLot <= 0) return 1;
  const maxRisk = capital * (riskPct / 100);
  return Math.max(Math.floor(maxRisk / riskPerLot), 1);
}

// ═══════ EXPIRY LOGIC ═══════
// Nifty expiry = TUESDAY (weekday 1)
// Sensex expiry = THURSDAY (weekday 3)

export function getExpiryStatus(indexName: string): ExpiryStatus {
  const now = new Date();
  const weekday = now.getDay();

  const isNifty = indexName.toUpperCase() === "NIFTY";
  const expiryDay = isNifty ? 1 : 3; // Tue or Thu
  const daysToExp = ((expiryDay - weekday + 7) % 7) || 7;
  const isExpiry = weekday === expiryDay;

  if (isExpiry) {
    return {
      isExpiry: true,
      daysToExp: 0,
      strikeType: "ITM",
      maxHoldHours: 4,
      riskMultiplier: 0.5,
      exitTime: "1:00 PM",
      note: `⚠️ ${indexName} EXPIRY DAY: ITM only. Exit by 1 PM. Risk halved.`,
      index: indexName,
    };
  }
  if (daysToExp === 1) {
    return {
      isExpiry: false,
      daysToExp: 1,
      strikeType: "ATM_or_ITM",
      maxHoldHours: 6,
      riskMultiplier: 0.8,
      exitTime: "3:15 PM",
      note: `⚠️ ${indexName} EXPIRY TOMORROW: ATM/ITM only. Time decay high.`,
      index: indexName,
    };
  }
  return {
    isExpiry: false,
    daysToExp,
    strikeType: "ATM",
    maxHoldHours: 24,
    riskMultiplier: 1.0,
    exitTime: "3:15 PM",
    note: daysToExp <= 3 ? `${indexName} expiry in ${daysToExp} days.` : "",
    index: indexName,
  };
}

// ═══════ MULTI-TIMEFRAME DATA FETCH ═══════
async function fetchYahooChart(
  ticker: string,
  range: string,
  interval: string
): Promise<any> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  return {
    timestamps,
    close: quote.close || [],
    high: quote.high || [],
    low: quote.low || [],
    open: quote.open || [],
  };
}

interface RawData {
  timestamps: number[];
  close: number[];
  high: number[];
  low: number[];
}

function buildCombined(niftyData: RawData | null, sensexData: RawData | null) {
  if (!niftyData || !sensexData) return null;

  const nMap = new Map<number, { c: number; h: number; l: number }>();
  const sMap = new Map<number, { c: number; h: number; l: number }>();

  for (let i = 0; i < niftyData.timestamps.length; i++) {
    if (niftyData.close[i] != null) {
      nMap.set(niftyData.timestamps[i], {
        c: niftyData.close[i],
        h: niftyData.high[i] || niftyData.close[i],
        l: niftyData.low[i] || niftyData.close[i],
      });
    }
  }
  for (let i = 0; i < sensexData.timestamps.length; i++) {
    if (sensexData.close[i] != null) {
      sMap.set(sensexData.timestamps[i], {
        c: sensexData.close[i],
        h: sensexData.high[i] || sensexData.close[i],
        l: sensexData.low[i] || sensexData.close[i],
      });
    }
  }

  const commonTs = [...nMap.keys()].filter((t) => sMap.has(t)).sort((a, b) => a - b);
  if (commonTs.length < 5) return null;

  const rows = commonTs.map((t) => {
    const n = nMap.get(t)!;
    const s = sMap.get(t)!;
    return { ts: t, nc: n.c, nh: n.h, nl: n.l, sc: s.c, sh: s.h, sl: s.l };
  });

  // Calculate returns
  for (let i = 1; i < rows.length; i++) {
    rows[i].nr = (rows[i].nc - rows[i - 1].nc) / rows[i - 1].nc;
    rows[i].sr = (rows[i].sc - rows[i - 1].sc) / rows[i - 1].sc;
  }

  // Rolling correlation (5-period)
  for (let i = 5; i < rows.length; i++) {
    const nrSlice = rows.slice(i - 5, i + 1).map((r) => r.nr || 0);
    const srSlice = rows.slice(i - 5, i + 1).map((r) => r.sr || 0);
    rows[i].corr5 = correlation(nrSlice, srSlice);
  }

  // Return diff and std
  for (let i = 0; i < rows.length; i++) {
    rows[i].diff = ((rows[i].nr || 0) - (rows[i].sr || 0)) * 100;
  }
  for (let i = 20; i < rows.length; i++) {
    const diffs = rows.slice(i - 20, i + 1).map((r) => r.diff || 0);
    rows[i].diffStd = std(diffs);
  }

  // ATR (14-period on Nifty)
  for (let i = 14; i < rows.length; i++) {
    const trs = rows.slice(i - 14, i + 1).map((r) => r.nh - r.nl);
    rows[i].atr = trs.reduce((a, b) => a + b, 0) / 14;
  }

  // EMA20
  let ema20 = rows[0].nc;
  for (let i = 1; i < rows.length; i++) {
    ema20 = ema20 * (19 / 21) + rows[i].nc * (2 / 21);
    rows[i].ema20 = ema20;
  }

  // Volatility (annualized)
  for (let i = 20; i < rows.length; i++) {
    const rets = rows.slice(i - 20, i + 1).map((r) => r.nr || 0);
    rows[i].vol = std(rets) * Math.sqrt(252) * 100;
  }

  return rows;
}

function correlation(a: number[], b: number[]): number {
  if (a.length < 3) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ═══════ FETCH ALL TIMEFRAMES ═══════
export interface TimeframeData {
  [key: string]: any[] | null;
}

export async function fetchAllTimeframes(): Promise<TimeframeData> {
  const timeframes = [
    { name: "daily", range: "60d", interval: "1d" },
    { name: "1hour", range: "15d", interval: "1h" },
    { name: "15min", range: "7d", interval: "15m" },
    { name: "5min", range: "5d", interval: "5m" },
    { name: "3min", range: "3d", interval: "3m" },
  ];

  const data: TimeframeData = {};

  for (const tf of timeframes) {
    try {
      const [niftyRaw, sensexRaw] = await Promise.all([
        fetchYahooChart(NIFTY_TICKER, tf.range, tf.interval),
        fetchYahooChart(SENSEX_TICKER, tf.range, tf.interval),
      ]);
      data[tf.name] = buildCombined(niftyRaw, sensexRaw);
    } catch {
      data[tf.name] = null;
    }
  }

  return data;
}

// ═══════ SCAN SIGNALS ═══════
function scanAllTimeframes(data: TimeframeData): Signal[] {
  const signals: Signal[] = [];

  for (const [tfName, rows] of Object.entries(data)) {
    if (!rows || rows.length < 10) continue;
    const latest = rows[rows.length - 1];
    const prev = rows[rows.length - 2];

    if (latest.corr5 == null || latest.diffStd == null) continue;

    const corr5 = latest.corr5;
    const diff = latest.diff || 0;

    // Setup 1: Correlation Breakdown
    if (corr5 < BOT_CONFIG.CORR_BREAKDOWN && Math.abs(diff) > 0.15) {
      signals.push({
        timeframe: tfName,
        setup: "Correlation Breakdown",
        direction: diff > 0.15 ? "BUY_SENSEX" : "BUY_NIFTY",
        strength: corr5 < 0.9 ? "STRONG" : "MEDIUM",
        details: diff > 0.15
          ? `Nifty ahead by ${diff.toFixed(2)}%`
          : `Sensex ahead by ${Math.abs(diff).toFixed(2)}%`,
      });
    }

    // Setup 2: Gap Fade (daily/1hour only)
    if (tfName === "daily" || tfName === "1hour") {
      if (prev && prev.nc > 0) {
        const gap = ((latest.nc - prev.nc) / prev.nc) * 100;
        if (Math.abs(gap) > BOT_CONFIG.GAP_THRESHOLD) {
          signals.push({
            timeframe: tfName,
            setup: "Gap Fade",
            direction: gap > 0 ? "BUY_NIFTY_PUT" : "BUY_NIFTY_CALL",
            strength: Math.abs(gap) > 1.0 ? "HIGH" : "MEDIUM",
            details: `Nifty gapped ${gap > 0 ? "+" : ""}${gap.toFixed(2)}%`,
          });
        }
      }
    }

    // Setup 3: EMA Bounce
    if (latest.ema20 && latest.ema20 > 0) {
      const emaDist = ((latest.nc - latest.ema20) / latest.ema20) * 100;
      if (Math.abs(emaDist) < BOT_CONFIG.EMA_ZONE_PCT) {
        signals.push({
          timeframe: tfName,
          setup: "EMA Bounce",
          direction: emaDist > 0 ? "BUY_NIFTY_PUT" : "BUY_NIFTY_CALL",
          strength: "MEDIUM",
          details: `Nifty ${emaDist > 0 ? "+" : ""}${emaDist.toFixed(2)}% from EMA20`,
        });
      }
    }
  }

  return signals;
}

function countAgreement(signals: Signal[]): {
  direction: string;
  count: number;
} {
  const counts: Record<string, number> = {};
  for (const s of signals) {
    counts[s.direction] = (counts[s.direction] || 0) + 1;
  }
  let best = "";
  let bestCount = 0;
  for (const [dir, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return { direction: best, count: bestCount };
}

// ═══════ GENERATE TRADE PLAN ═══════
export async function generateTradePlan(): Promise<{
  plan: TradePlan[];
  snapshot: MarketSnapshot;
  signals: Signal[];
  raw: TimeframeData;
}> {
  const data = await fetchAllTimeframes();
  const daily = data["daily"];

  // Get snapshot
  const latestDaily = daily?.[daily.length - 1];
  const prevDaily = daily?.[daily.length - 2];

  const nifty = latestDaily?.nc || 0;
  const sensex = latestDaily?.sc || 0;
  const niftyChange = prevDaily
    ? ((nifty - prevDaily.nc) / prevDaily.nc) * 100
    : 0;
  const sensexChange = prevDaily
    ? ((sensex - prevDaily.sc) / prevDaily.sc) * 100
    : 0;

  const tfStatus: Record<string, { corr: number; diff: number; status: string }> = {};
  for (const [tf, rows] of Object.entries(data)) {
    if (rows && rows.length > 0) {
      const r = rows[rows.length - 1];
      tfStatus[tf] = {
        corr: r.corr5 || 0,
        diff: r.diff || 0,
        status: r.corr5 > 0.97 ? "🟢" : r.corr5 > 0.94 ? "🟡" : "🔴",
      };
    }
  }

  const snapshot: MarketSnapshot = {
    nifty,
    sensex,
    niftyChange,
    sensexChange,
    corr5d: latestDaily?.corr5 || 0,
    returnDiff: latestDaily?.diff || 0,
    niftyVol: latestDaily?.vol || 0,
    sensexVol: 0,
    timeframeStatus: tfStatus,
  };

  // Scan signals
  const signals = scanAllTimeframes(data);
  const { direction: bestDir, count: agreement } = countAgreement(signals);

  const plans: TradePlan[] = [];

  if (bestDir && agreement >= 2) {
    const niftyExp = getExpiryStatus("NIFTY");
    const sensexExp = getExpiryStatus("SENSEX");

    const isSensex = bestDir.includes("SENSEX");
    const index = isSensex ? "SENSEX" : "NIFTY";
    const spot = isSensex ? sensex : nifty;
    const atr = latestDaily?.atr || 50;
    const vol = latestDaily?.vol || 15;
    const lotSize = isSensex
      ? BOT_CONFIG.LOT_SIZE_SENSEX
      : BOT_CONFIG.LOT_SIZE_NIFTY;
    const step = isSensex
      ? BOT_CONFIG.STRIKE_STEP_SENSEX
      : BOT_CONFIG.STRIKE_STEP_NIFTY;
    const expStatus = isSensex ? sensexExp : niftyExp;

    const direction = bestDir.includes("PUT") ? "PUT" : "CALL";

    const strike =
      expStatus.strikeType === "ITM"
        ? getItmStrike(spot, step, direction === "CALL" ? "CALL" : "PUT", 1)
        : getAtmStrike(spot, step);

    const tfForAtr = agreement >= 3 ? "daily" : "15min";
    const mult = ATR_MULT[tfForAtr] || ATR_MULT["daily"];
    let tpMult = mult.tp;
    let slMult = mult.sl;

    if (expStatus.isExpiry) {
      tpMult *= 0.5;
      slMult *= 0.7;
    }

    const premium = estimatePremium(
      strike,
      spot,
      direction === "CALL" ? "CALL" : "PUT",
      expStatus.daysToExp,
      vol,
      expStatus.isExpiry
    );

    const slPremium = premium * (1 - BOT_CONFIG.SL_PCT_OF_PREMIUM);
    const tpPremium =
      premium + (premium - slPremium) * BOT_CONFIG.TP_MIN_RR;

    const riskPct = BOT_CONFIG.RISK_PER_TRADE_PCT * expStatus.riskMultiplier;
    const lots = calculatePositionSize(
      BOT_CONFIG.CAPITAL,
      riskPct,
      premium,
      slPremium,
      lotSize
    );

    const totalPremium = premium * lots * lotSize;
    const maxRisk = (premium - slPremium) * lots * lotSize;
    const rr =
      premium - slPremium > 0
        ? (tpPremium - premium) / (premium - slPremium)
        : 0;

    const matchingSignals = signals.filter((s) => s.direction === bestDir);
    const reasons = matchingSignals.map(
      (s) => `${s.timeframe}: ${s.setup} (${s.strength})`
    );

    plans.push({
      setup: `Multi-TF (${agreement} agree)`,
      index,
      direction,
      strike,
      spot,
      entryPremium: premium,
      slPremium,
      tpPremium,
      lots,
      totalPremium,
      maxRisk,
      rr,
      confidence: agreement >= 3 ? "HIGH" : "MEDIUM",
      timeframe: tfForAtr,
      expiryNote: expStatus.note,
      exitTime: expStatus.exitTime,
      reasons,
    });
  }

  return { plan: plans, snapshot, signals, raw: data };
}
