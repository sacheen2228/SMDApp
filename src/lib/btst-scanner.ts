// BTST Scanner
// Reuses the live intraday scanner's real Yahoo Finance technicals, maps each
// bullish candidate into the BTST engine, and returns A+/A/B graded next-day ideas.
// Also scans the index ETFs (NIFTYBEES for NIFTY, SENSEX ETF for SENSEX) so the
// indices themselves appear as BTST candidates.
// Runs once daily between 3:10–3:20 PM IST (triggered by cron or manual API call).

import { runIntradayScan } from "./intraday-scanner";
import { analyzeBTST, type BTSTAnalysis } from "./btst-engine";
import { Candle, calculateRSI, calculateEMA, calculateADX } from "./ml-engine";
import { recordSignal, getTrades, closeTrade } from "./trade-audit-client";
import { createTrade, updateTrade } from "./tradeStore";
import { recordScannerResult } from "./market/record-scanner";

export interface BTSTScanResult {
  timestamp: string;
  candidates: BTSTAnalysis[];
  count: number;
  aPlus: number;
  a: number;
  b: number;
  scanWindow: string;
}

// Major F&O-eligible names in the NIFTY 50 universe (have options → OI/PCR usable)
const FNO_STOCKS = new Set([
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN", "BHARTIARTL",
  "KOTAKBANK", "LT", "AXISBANK", "BAJFINANCE", "MARUTI", "SUNPHARMA", "TITAN",
  "ULTRACEMCO", "NESTLEIND", "TATAMOTORS", "WIPRO", "M&M", "HCLTECH", "POWERGRID",
  "NTPC", "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIENT", "ADANIPORTS", "TECHM",
  "HDFCLIFE", "SBILIFE", "BAJAJFINSV", "COALINDIA", "BPCL", "TRENT", "APOLLOHOSP",
  "LTIM", "HINDALCO", "INDUSINDBK", "ITC", "HINDUNILVR",
]);

// Index ETFs — tradeable proxies for NIFTY / SENSEX (perfect for BTST)
const INDEX_ETFS: { sym: string; label: string }[] = [
  { sym: "NIFTYBEES", label: "NIFTY (NIFTYBEES ETF)" },
  { sym: "SETFNIF50", label: "SENSEX (SBI SENSEX ETF)" },
];

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

async function fetchYahooCandles(sym: string, range = "3mo", interval = "1d"): Promise<{ candles: Candle[]; price: number; changePct: number; volume: number } | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=${range}&interval=${interval}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const ts = result.timestamp;
    const q = result.indicators?.quote?.[0];
    if (!ts || !q?.close) return null;
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close[i];
      if (close == null) continue;
      candles.push({ time: ts[i], open: q.open?.[i] ?? close, high: q.high?.[i] ?? close, low: q.low?.[i] ?? close, close });
    }
    const prevClose = meta.chartPreviousClose || meta.regularMarketPrice || candles[0]?.close || 0;
    const price = meta.regularMarketPrice || candles.at(-1)?.close || 0;
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const volume = meta.regularMarketVolume || 0;
    return { candles, price, changePct, volume };
  } catch {
    return null;
  }
}

async function buildIndexETFBTST(): Promise<BTSTAnalysis[]> {
  const out: BTSTAnalysis[] = [];
  for (const etf of INDEX_ETFS) {
    const d = await fetchYahooCandles(etf.sym);
    if (!d || d.candles.length < 50) continue;
    const closes = d.candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9).at(-1) ?? d.price;
    const ema21 = calculateEMA(closes, 21).at(-1) ?? d.price;
    const ema50 = calculateEMA(closes, 50).at(-1) ?? d.price;
    const rsi = calculateRSI(d.candles, 14);
    const adx = calculateADX(d.candles, 14);
    const atr = calcATR(d.candles, 14);
    const e12 = calculateEMA(closes, 12);
    const e26 = calculateEMA(closes, 26);
    const macdLine = (e12.at(-1) ?? 0) - (e26.at(-1) ?? 0);
    const macdSeries = closes.map((_, i) => (e12[i] ?? 0) - (e26[i] ?? 0));
    const macdSignal = calculateEMA(macdSeries, 9).at(-1) ?? 0;
    const avgVolume = d.volume * 0.8;

    const analysis = analyzeBTST({
      symbol: etf.sym,
      name: etf.label,
      sector: "Index",
      price: d.price,
      changePct: d.changePct,
      rsi,
      macd: macdLine,
      macdSignal,
      macdHist: macdLine - macdSignal,
      adx,
      ema9,
      ema21,
      ema50,
      volume: d.volume,
      avgVolume,
      oiChangePct: 0,
      pcr: 1,
      iv: 0,
      sectorStrength: d.changePct * 3,
      relativeStrength: d.changePct,
      deliveryPct: 60, // ETFs are institutional/delivery-heavy
      breadth: 0.6,
      atr,
      isFNO: false,
    });

    if (analysis.grade !== "SKIP") out.push(analysis);
  }
  return out;
}

export async function runBTSTScan(): Promise<BTSTScanResult> {
  // Reuse live scanner data (real Yahoo Finance quotes + 3mo candles)
  const scan = await runIntradayScan({
    symbol: "NIFTY",
    spotPrice: 0,
    optionChain: [],
    vix: 15,
    pcr: 1,
    maxPain: 0,
    totalCallOI: 0,
    totalPutOI: 0,
  });

  const candidates: BTSTAnalysis[] = [];

  for (const c of scan.candidates) {
    if (c.direction !== "BULLISH") continue;

    const isFNO = FNO_STOCKS.has(c.symbol);
    const macdHist = (c.macd ?? 0) - (c.macdSignal ?? 0);

    // Map scanner technicals → BTST engine input.
    // relativeStrength approximated from the stock's own momentum vs a flat market.
    // deliveryPct / breadth are not available from Yahoo — derived as honest proxies.
    const analysis = analyzeBTST({
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      price: c.currentPrice,
      changePct: c.changePct,
      rsi: c.rsi,
      macd: c.macd,
      macdSignal: c.macdSignal,
      macdHist,
      adx: c.adx,
      ema9: c.ema9,
      ema21: c.ema21,
      ema50: c.ema50,
      volume: c.volume,
      avgVolume: c.avgVolume,
      oiChangePct: isFNO ? (c.oiChange || 0) : 0,
      pcr: isFNO ? (c.pcr || 1) : 1,
      iv: isFNO ? (c.iv || 0) : 0,
      sectorStrength: (c.sectorScore ?? 50) * 2 - 100,
      relativeStrength: c.changePct,
      deliveryPct: Math.min(85, 35 + Math.max(0, (c.rvol - 1) * 22)),
      breadth: 0.55,
      atr: c.atr,
      isFNO,
    });

    if (analysis.grade !== "SKIP") candidates.push(analysis);
  }

  // Add index ETFs (NIFTY / SENSEX) as BTST candidates
  const indexCandidates = await buildIndexETFBTST();
  candidates.push(...indexCandidates);

  candidates.sort((a, b) => b.total - a.total);

  const aPlus = candidates.filter((c) => c.grade === "A+").length;
  const a = candidates.filter((c) => c.grade === "A").length;
  const b = candidates.filter((c) => c.grade === "B").length;

  // Record candidates into the Trade Audit engine (non-fatal).
  recordBTSTSignals(candidates).catch(() => {});
  // M5: record the BTST scanner cycle as an AI-training row (every scan).
  recordBTSTScannerResults(candidates).catch(() => {});

  return {
    timestamp: new Date().toISOString(),
    candidates: candidates.slice(0, 25),
    count: candidates.length,
    aPlus,
    a,
    b,
    scanWindow: "15:10–15:20 IST",
  };
}

const istYmd = (when = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(when)
    .replace(/-/g, ""); // YYYYMMDD in IST

/**
 * Record the BTST scanner cycle as a permanent AI-training row (M5).
 * Every daily scan is recorded with strategy "BTST" (BUY for graded
 * bullish next-day ideas, NO_TRADE when none). Reuses recordScannerResult
 * (the same build+send helper Zero Hero / SMC use) so the payload shape
 * is identical. Fire-and-forget: failures never break the scan itself.
 */
export async function recordBTSTScannerResults(candidates: BTSTAnalysis[]): Promise<void> {
  const ymd = istYmd();
  const inputs = candidates.length
    ? candidates.map((a) => ({
        symbol: a.symbol,
        strategy: "BTST",
        decision: "BUY" as const,
        confidence: a.confidence,
        riskScore: Math.max(0, Math.min(100, 100 - a.confidence)),
        perEngineConfidence: { BTST: a.confidence },
        triggeredEngines: ["BTST"],
        rejectedConditions: [],
        reasons: [`${a.grade} | ${a.reasons.join("; ")}`],
        selectedStrike: 0,
        entry: a.entry,
        sl: a.sl,
        tp1: a.tp1,
        tp2: a.tp2,
        expectedRR: a.riskReward,
        snapshotId: null,
        sessionId: `BTST-${ymd}`,
      }))
    : [{
        symbol: "BTST",
        strategy: "BTST",
        decision: "NO_TRADE" as const,
        confidence: 0,
        riskScore: 100,
        perEngineConfidence: {},
        triggeredEngines: [],
        rejectedConditions: ["no_candidates"],
        reasons: ["no eligible BTST candidates"],
        sessionId: `BTST-${ymd}`,
      }];
  await Promise.all(inputs.map((i) => recordScannerResult(i).catch(() => {})));
}

/**
 * Record each BTST candidate into the Trade Audit (backtest verification)
 * engine as a signal. Uses a deterministic tradeId (SYMBOL-BTST-YYYYMMDD) so
 * re-runs of the same day's scan are idempotent. Fire-and-forget: failures are
 * swallowed so the scan itself never breaks.
 */
export async function recordBTSTSignals(candidates: BTSTAnalysis[]): Promise<number> {
  const ymd = istYmd();
  let recorded = 0;
  for (const a of candidates) {
    const ok = await recordSignal({
      tradeId: `${a.symbol}-BTST-${ymd}`,
      strategyId: "BTST",
      strategyVersion: "1.0",
      symbol: a.symbol,
      exchange: "NSE",
      instrumentType: "EQUITY",
      spotPrice: a.price,
      entryPrice: a.entry,
      stopLoss: a.sl,
      tp1: a.tp1,
      tp2: a.tp2,
      tp3: a.tp3,
      signalConfidence: a.confidence,
      trendDirection: "BULLISH",
      signalReason: `${a.grade} | ${a.reasons.join("; ")}`,
      marketSession: "POST_CLOSE",
      marketContext: {
        score: a.total,
        grade: a.grade,
        riskReward: a.riskReward,
        expectedMovePct: a.expectedMovePct,
        gapRisk: a.gapRisk,
      },
    });
      if (ok) recorded++;

    // Mirror into the Prisma trade journal (the dashboard/Telegram/Agent source
    // of truth) so BTST exits also show up in the unified lifecycle. Upsert is
    // idempotent on tradeId.
    await createTrade({
      tradeId: `${a.symbol}-BTST-${ymd}`,
      symbol: a.symbol,
      strike: 0,
      type: "EQUITY",
      side: "BUY",
      entryPrice: a.entry,
      stopLoss: a.sl,
      target1: a.tp1,
      target2: a.tp2,
      confidence: a.confidence,
      strategy: "BTST",
    }).catch(() => {});
  }
  return recorded;
}

/**
 * Close yesterday's (or older) still-open BTST signals using the next trading
 * day's realized close — the backtest verification step. Called once daily
 * (cron 15:25 IST) so each BTST idea is held ~1 session, then squared off.
 */
export async function closeYesterdayBTST(): Promise<{ closed: number }> {
  try {
    const page = await getTrades({ strategyId: "BTST", status: "open", pageSize: 500 });
    if (page.items.length === 0) return { closed: 0 };

    const todayYmd = istYmd();
    const priceCache = new Map<string, number>();
    let closed = 0;

    for (const t of page.items) {
      const createdYmd = (t.createdAtIst || "").slice(0, 10).replace(/-/g, "");
      if (createdYmd >= todayYmd) continue; // keep today's fresh scans open

      let closePx = priceCache.get(t.symbol);
      if (closePx === undefined) {
        const d = await fetchYahooCandles(t.symbol, "5d", "1d");
        closePx = d?.candles.at(-1)?.close ?? 0;
        priceCache.set(t.symbol, closePx);
      }
      if (closePx > 0) {
        await closeTrade(t.id, closePx, "btst_square_off");
        // Sync the same exit into the Prisma journal (unified lifecycle).
        const pnl = Math.round((closePx - t.entryPrice) * 100) / 100;
        const pnlPct = t.entryPrice > 0 ? Math.round((pnl / t.entryPrice) * 1000) / 10 : 0;
        const createdMs = Date.parse(t.createdAtIst || "");
        const holdingMin = Number.isFinite(createdMs)
          ? Math.round((Date.now() - createdMs) / 60000)
          : 0;
        await updateTrade(t.id, {
          status: "CLOSED",
          exitPrice: closePx,
          exitReason: "btst_square_off",
          pnl,
          pnlPercent: pnlPct,
          holdingTimeMin: holdingMin,
          tpHitLevel: "btst_square_off",
        }).catch(() => {});
        closed++;
      }
    }
    return { closed };
  } catch {
    return { closed: 0 };
  }
}
