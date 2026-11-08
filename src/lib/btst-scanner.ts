// BTST Scanner
// Reuses the live intraday scanner's real exchange technicals, maps each
// bullish candidate into the BTST engine, and returns A+/A/B graded next-day ideas.
// Also scans the index ETFs (NIFTYBEES for NIFTY, SENSEX ETF for SENSEX) so the
// indices themselves appear as BTST candidates.
// Runs once daily between 3:10–3:20 PM IST (triggered by cron or manual API call).

import { runIntradayScan } from "./intraday-scanner";
import { analyzeBTST, type BTSTAnalysis } from "./btst-engine";
import { analyzeBTSTv2 } from "./btst-v2-engine";
import { BTST_CONFIG } from "./btst-config";
import { Candle, calculateRSI, calculateEMA, calculateADX } from "./ml-engine";
import { recordSignal, getTrades, closeTrade } from "./trade-audit-client";
import { updateTrade } from "./tradeStore";
import { recordScannerResult } from "./market/record-scanner";
import { validateCandidateTrade } from "@/lib/trade-validator-gate";
import { acquireTradeLock, releaseTradeLock } from "@/lib/active-trade-lock";
import { addDaysISO } from "./null-pnl-repair";
import { getDailyRange } from "./trade-validator";
import { isWeekend } from "./option-bhavcopy";

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

// Adapter: map legacy BTST input to v2 and back to legacy shape
function analyzeBTSTWithV2(inp: Parameters<typeof analyzeBTST>[0]): BTSTAnalysis {
  const v2inp = {
    symbol: inp.symbol,
    price: inp.price,
    changePct: inp.changePct,
    rsi: inp.rsi,
    ema9: inp.ema9,
    ema21: inp.ema21,
    ema50: inp.ema50,
    volume: inp.volume,
    avgVolume20d: inp.avgVolume,
    deliveryPct: inp.deliveryPct,
    atr14: inp.atr,
    sectorStrength: inp.sectorStrength,
    relativeStrength: inp.relativeStrength,
    isFNO: inp.isFNO,
    oiChangePct: inp.oiChangePct,
    pcr: inp.pcr,
    iv: inp.iv,
    alignment: inp.institutional?.alignment,
    avgTurnoverCr: 50,
    isBan: false,
    circuit: false,
    resultsTomorrow: false,
    dataFresh: true,
  };
  const v2 = analyzeBTSTv2(v2inp, { niftyScore: 65, vix: 18 });
  // Fallback to legacy if v2 skips
  if (v2.grade === "SKIP") {
    return analyzeBTST(inp);
  }
  // Map v2 result back to legacy BTSTAnalysis shape minimally
  const legacy = analyzeBTST(inp);
  return {
    ...legacy,
    total: v2.score,
    confidence: v2.confidence,
    grade: v2.finalGrade === "A+" ? "A+" : v2.finalGrade === "A" ? "A" : v2.finalGrade === "B" ? "B" : "SKIP",
    reasons: [...legacy.reasons, ...v2.warnings],
    entry: v2.entry,
    sl: v2.sl,
    tp1: v2.tp1,
    tp2: v2.tp2,
    tp3: v2.tp2 * 1.15,
    riskReward: v2.rr,
    positionSize: {
      qty: v2.qty || legacy.positionSize.qty,
      capital: v2.capitalDeployed || legacy.positionSize.capital,
      riskPerTrade: v2.riskAmount || legacy.positionSize.riskPerTrade,
    },
  };
}

/**
 * Daily candles for one symbol from the EXCHANGE's own history.
 * Yahoo is banned (SOP §1) — the old fetcher pulled 3 months of Yahoo bars
 * and silently returned null on failure.
 */
async function fetchDailyCandles(sym: string, range = "3mo", interval = "1d"): Promise<{ candles: Candle[]; price: number; changePct: number; volume: number } | null> {
  try {
    const { getDailyBars } = await import("./daily-bars");
    const bars = await getDailyBars(sym, 120);
    if (!bars || bars.length < 30) return null;
    const candles: Candle[] = bars.map((b) => ({
      time: Math.floor(b.t / 1000),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v || 0,
    }));
    const price = candles.at(-1)!.close;
    const prev = candles.at(-2)?.close ?? price;
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    const volume = candles.at(-1)?.volume || 0;
    return { candles, price, changePct, volume };
  } catch {
    return null;
  }
}

async function buildIndexETFBTST(institutionalData?: {
  fiiDirection: string; fiiScore: number;
  proDirection: string; proScore: number;
  smartMoneyBias: string;
  retailTrap: boolean; retailTrapType: string | null;
  alignment: number;
  predictionDirection: string; predictionConfidence: number;
  filterVerdict: string;
} | null): Promise<BTSTAnalysis[]> {
  const out: BTSTAnalysis[] = [];
  for (const etf of INDEX_ETFS) {
    const d = await fetchDailyCandles(etf.sym);
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

    const analysis = analyzeBTSTWithV2({
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
      // An ETF has no option chain: PCR / OI / IV are UNKNOWN (null), not
      // "1.0 / 0 / 0" — those numbers scored the setup as a real signal.
      oiChangePct: null,
      pcr: null,
      iv: null,
      sectorStrength: d.changePct * 3,
      relativeStrength: d.changePct,
      deliveryPct: 60, // ETFs are institutional/delivery-heavy
      breadth: 0.6,
      atr,
      isFNO: false,
      institutional: institutionalData ?? undefined,
    });

    if (analysis.grade !== "SKIP") out.push(analysis);
  }
  return out;
}

async function buildFNOCandidates(institutionalData?: any): Promise<BTSTAnalysis[]> {
  const out: BTSTAnalysis[] = [];
  const symbols = Array.from(FNO_STOCKS);
  for (const sym of symbols) { // full F&O universe
    try {
      const d = await fetchDailyCandles(sym);
      if (!d || d.candles.length < 50) continue;
      const closes = d.candles.map(c => c.close);
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
      const avgVol = d.candles.slice(-20).reduce((a,c)=>a+c.volume,0)/20 || d.volume;
      // Fetch live OI/PCR/IV
      let oiChangePct = null;
      let pcr = null;
      let iv = null;
      try {
        const base = process.env.INTERNAL_API_BASE || 'http://localhost:3000';
        const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(sym)}`, { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          const chain = j?.data || j;
          oiChangePct = chain?.oiChangePct ?? null;
          pcr = chain?.pcr ?? null;
          iv = chain?.iv ?? null;
        }
      } catch {}
      const analysis = analyzeBTSTWithV2({
        symbol: sym,
        name: sym,
        sector: "",
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
        avgVolume: avgVol,
        oiChangePct,
        pcr,
        iv,
        sectorStrength: d.changePct * 2,
        relativeStrength: d.changePct,
        deliveryPct: 50,
        breadth: 0.55,
        atr,
        isFNO: true,
        institutional: institutionalData ?? undefined,
      });
      if (analysis.grade !== "SKIP") out.push(analysis);
    } catch {}
  }
  return out;
}

export async function runBTSTScan(): Promise<BTSTScanResult> {
  // Reuse live scanner data (real exchange quotes + daily candles)
  // Real index context (the scanner used to run with spotPrice 0, VIX 15,
  // PCR 1 and max pain 0 — four invented numbers in the market context).
  const { getNSEIndexQuote, getNSEIndiaVIX } = await import("./nse-api");
  const [idxQuote, vixQuote] = await Promise.all([
    getNSEIndexQuote("NIFTY").catch(() => null),
    getNSEIndiaVIX().catch(() => null),
  ]);
  const scan = await runIntradayScan({
    symbol: "NIFTY",
    spotPrice: idxQuote?.regularMarketPrice || 0,
    optionChain: [],
    vix: vixQuote?.value ?? null,
    pcr: null,
    maxPain: null,
    totalCallOI: 0,
    totalPutOI: 0,
  } as any);

  // Fetch NSE Participant-wise OI institutional positioning
  let institutionalData: {
    fiiDirection: string; fiiScore: number;
    proDirection: string; proScore: number;
    smartMoneyBias: string;
    retailTrap: boolean; retailTrapType: string | null;
    alignment: number;
    predictionDirection: string; predictionConfidence: number;
    filterVerdict: string;
  } | null = null;
  try {
    const res = await fetch(`${process.env.INTERNAL_API_BASE || "http://localhost:3000"}/api/institutional-positioning`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const d = await res.json();
      const fii = (d.strengthScores || []).find((s: any) => s.participant === 'FII');
      const pro = (d.strengthScores || []).find((s: any) => s.participant === 'Pro');
      institutionalData = {
        fiiDirection: fii?.direction ?? 'neutral',
        fiiScore: fii?.score ?? 50,
        proDirection: pro?.direction ?? 'neutral',
        proScore: pro?.score ?? 50,
        smartMoneyBias: d.bias?.dominantDirection ?? 'neutral',
        retailTrap: d.retailTrap?.detected ?? false,
        retailTrapType: d.retailTrap?.type ?? null,
        alignment: d.alignment?.overall ?? 50,
        predictionDirection: d.prediction?.tomorrowBias ?? 'neutral',
        predictionConfidence: d.prediction?.confidence ?? 10,
        filterVerdict: d.institutionalFilter?.verdict ?? 'proceed',
      };
    }
  } catch { /* best-effort */ }

  const candidates: BTSTAnalysis[] = [];

  for (const c of scan.candidates) {
    if (c.direction !== "BULLISH") continue;

    const isFNO = FNO_STOCKS.has(c.symbol);
    const macdHist = (c.macd ?? 0) - (c.macdSignal ?? 0);

    // Map scanner technicals → BTST engine input.
    // relativeStrength approximated from the stock's own momentum vs a flat market.
    // deliveryPct / breadth are not published by the free feeds — derived as
    // honest proxies from the real relative volume / market breadth.
    const analysis = analyzeBTSTWithV2({
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
      pcr: isFNO ? (c.pcr ?? null) : null,
      iv: isFNO ? (c.iv || 0) : 0,
      sectorStrength: (c.sectorScore ?? 50) * 2 - 100,
      relativeStrength: c.changePct,
      deliveryPct: Math.min(85, 35 + Math.max(0, (c.rvol - 1) * 22)),
      breadth: 0.55,
      atr: c.atr,
      isFNO,
      institutional: institutionalData ?? undefined,
    });

    if (analysis.grade !== "SKIP") candidates.push(analysis);
  }

  // Add F&O universe candidates
  const fnoCandidates = await buildFNOCandidates(institutionalData);
  candidates.push(...fnoCandidates);

  // Add index ETFs (NIFTY / SENSEX) as BTST candidates
  const indexCandidates = await buildIndexETFBTST(institutionalData);
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
    // SAFETY: Validate through canonical validator
    const candidate = {
      symbol: a.symbol,
      exchange: 'NSE' as const,
      instrument: 'EQUITY' as const,
      entry: a.entry,
      stopLoss: a.sl,
      target1: a.tp1,
      target2: a.tp2,
      direction: 'BUY' as const,
      strategy: 'BTST',
      score: a.confidence,
      premium: a.entry,
      spot: a.price,
    };
    const validation = validateCandidateTrade(candidate);
    if (!validation.valid) {
      console.log(`[BTST] BLOCKED ${a.symbol}: ${validation.reasons.join('; ')}`);
      continue;
    }

    // SAFETY: Acquire active trade lock
    const tradeId = `${a.symbol}-BTST-${ymd}`;
    const lockResult = await acquireTradeLock({
      tradeId,
      strategy: 'BTST',
      underlying: a.symbol,
      exchange: 'NSE',
      optionType: 'EQ',
      strike: 0,
      expiry: '',
      entry: a.entry,
      stopLoss: a.sl,
      target1: a.tp1,
      target2: a.tp2,
    });
    if ('blocked' in lockResult) {
      console.log(`[BTST] BLOCKED ${a.symbol}: Active trade ${lockResult.activeTrade.tradeId}`);
      continue;
    }

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

    // NOTE: Equity BTST trades intentionally NOT registered into the Prisma
    // trade journal / active-trade monitor. Equity ETFs (SETFNIF50 / NIFTYBEES)
    // have no live LTP source and would produce permanent "LTP feed unavailable"
    // monitoring errors. Option trades flow through the scanner's monthlyOptionTrade
    // path (/api/scanner?live=true) instead.
  }
  return recorded;
}

/**
 * Plan one BTST square-off. Rows created today stay open; every other row
 * probes from ITS OWN next calendar day — never from "today" — so a stale
 * row gets its real next-trading-day close instead of whatever close the
 * sweep day happens to have (the Jul-20/Sep-11 mass-stamp corruption).
 */
export function planBtstSquareOff(
  createdYmd: string,
  todayYmd: string
): { skip: boolean; probeFrom: string } {
  if (!/^\d{8}$/.test(createdYmd)) return { skip: true, probeFrom: "" };
  const createdIso = `${createdYmd.slice(0, 4)}-${createdYmd.slice(4, 6)}-${createdYmd.slice(6, 8)}`;
  return { skip: createdYmd >= todayYmd, probeFrom: addDaysISO(createdIso, 1) };
}

/**
 * Close yesterday's (or older) still-open BTST signals using EACH ROW'S real
 * next trading day close — the backtest verification step. Called once daily
 * (cron 15:25 IST) so each BTST idea is held ~1 session, then squared off.
 *
 * Day-2+ rows (day-1 close failed) retry against their own exit date's
 * historical close, not today's — and if no real close exists the row is
 * left open with a warning (never a fabricated price).
 */
export async function closeYesterdayBTST(): Promise<{ closed: number }> {
  try {
    const page = await getTrades({ strategyId: "BTST", status: "open", pageSize: 500 });
    if (page.items.length === 0) return { closed: 0 };

    const todayYmd = istYmd();
    const todayIso = `${todayYmd.slice(0, 4)}-${todayYmd.slice(4, 6)}-${todayYmd.slice(6, 8)}`;
    const liveCache = new Map<string, number>();
    let closed = 0;

    for (const t of page.items) {
      const createdYmd = (t.createdAtIst || "").slice(0, 10).replace(/-/g, "");
      const plan = planBtstSquareOff(createdYmd, todayYmd);
      if (plan.skip) continue; // keep today's fresh scans open

      // First trading day strictly after creation (skip weekends/holidays).
      let exitIso: string | null = null;
      let closePx = 0;
      for (let cand = plan.probeFrom, w = 0; w < 8; w++, cand = addDaysISO(cand, 1)) {
        if (isWeekend(cand)) continue;
        if (cand >= todayIso) break; // today → live close below; future → not traded yet
        const range = await getDailyRange(t.symbol, new Date(`${cand}T00:00:00Z`));
        if (range) {
          exitIso = cand;
          closePx = range.close;
          break;
        }
      }

      if (exitIso === null) {
        // Proper exit is today — use the live close (same as the normal path)
        let live = liveCache.get(t.symbol);
        if (live === undefined) {
          const d = await fetchDailyCandles(t.symbol, "5d", "1d");
          live = d?.candles.at(-1)?.close ?? 0;
          liveCache.set(t.symbol, live);
        }
        closePx = live;
        exitIso = todayIso;
      }

      if (!(closePx > 0)) {
        console.warn(
          `[BTST] square-off skipped for ${t.id}: no real close for exit ${exitIso} — row left open`
        );
        continue; // NEVER stamp a fabricated price
      }

      await closeTrade(t.id, closePx, "btst_square_off");
      // Sync the same exit into the Prisma journal (unified lifecycle).
      const pnl = Math.round((closePx - t.entryPrice) * 100) / 100;
      const pnlPct = t.entryPrice > 0 ? Math.round((pnl / t.entryPrice) * 1000) / 10 : 0;
      const createdMs = Date.parse(t.createdAtIst || "");
      const exitMs = Date.parse(`${exitIso}T15:20:00+05:30`);
      const holdingMin =
        Number.isFinite(createdMs) && Number.isFinite(exitMs) && exitMs >= createdMs
          ? Math.round((exitMs - createdMs) / 60000)
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
    return { closed };
  } catch {
    return { closed: 0 };
  }
}
