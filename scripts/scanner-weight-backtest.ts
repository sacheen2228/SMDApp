/**
 * Scanner weight backtest — last 2 trading days.
 *
 * Replays the intraday scoring logic on REAL Breeze 5m candles for NIFTY50:
 *   OLD weights + old RVOL tiers + no ADX damp
 *   NEW weights + new RVOL tiers (≥2.0→95) + ADX<20 dampener
 *   (engine/market/sector/options/news held at neutral 50 to isolate the change)
 *
 * Decision times: 10:00, 11:00, 12:00, 13:00 IST each day.
 * Forward return: entry at decision bar close → session close (15:25 bar).
 *
 * Usage: bun run scripts/scanner-weight-backtest.ts
 */
import { NIFTY50_STOCKS } from "../src/lib/intraday-scanner";
import { calculateRSI, calculateEMA, calculateADX, type Candle } from "../src/lib/ml-engine";
import { getIntradayCandles } from "../src/lib/breeze-historical";
import { getHistoricalCandles } from "../src/lib/historical-data";

const DAYS = ["2026-11-12", "2026-11-13"];
const DECISION_TIMES = ["10:00", "11:00", "12:00", "13:00"];
const SESSION_START_MIN = 9 * 60 + 15; // 9:15
const SESSION_END_MIN = 15 * 60 + 25; // last 5m bar 15:25
const SESSION_LEN = SESSION_END_MIN - SESSION_START_MIN;

const OLD_W = {
  market: 0.05, sector: 0.1, tech: 0.25, engine: 0.35, options: 0.05, volume: 0.1, fundamental: 0.05, news: 0.05,
};
const NEW_W = {
  market: 0.05, sector: 0.1, tech: 0.28, engine: 0.35, options: 0.05, volume: 0.12, news: 0.05,
};

type IntraBar = { time: string; open: number; high: number; low: number; close: number; volume: number };

function parseIntraTime(t: string): number {
  // "2026-11-13 09:15:00" → minutes from midnight
  const m = t.match(/(\d{2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function toMlCandles(bars: IntraBar[]): Candle[] {
  return bars.map((b) => ({
    time: parseIntraTime(b.time) * 60_000,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));
}

/** Technical score — mirrors intraday-scanner.ts logic (no ADX damp). */
function techScore(candles: Candle[], basePrice: number): {
  technicalScore: number; adx: number; rsi: number; bull: number; bear: number; direction: "BULLISH" | "BEARISH" | "NEUTRAL";
} {
  let ema9 = basePrice * 1.001, ema21 = basePrice * 0.999, ema50 = basePrice * 0.997;
  let rsi = 50, macd = 0, macdSignal = 0, adx = 20;

  if (candles.length >= 35) {
    const closes = candles.map((c) => c.close);
    ema9 = calculateEMA(closes, 9).at(-1)!;
    ema21 = calculateEMA(closes, 21).at(-1)!;
    if (candles.length >= 50) ema50 = calculateEMA(closes, 50).at(-1)!;
    rsi = calculateRSI(candles, 14);
    adx = calculateADX(candles, 14);
    const e12 = calculateEMA(closes, 12);
    const e26 = calculateEMA(closes, 26);
    const macdSeries = closes.map((_, i) => (e12[i] ?? 0) - (e26[i] ?? 0));
    macd = e12.at(-1)! - e26.at(-1)!;
    macdSignal = calculateEMA(macdSeries, 9).at(-1) ?? 0;
  }

  let technicalScore = 0;
  const bullFlags = [ema9 > ema21, ema21 > ema50, rsi > 50 && rsi < 70, macd > macdSignal, adx > 25];
  const bearFlags = [ema9 < ema21, ema21 < ema50, rsi < 50 && rsi > 30, macd < macdSignal, adx > 25];
  const techBull = bullFlags.filter(Boolean).length;
  const techBear = bearFlags.filter(Boolean).length;

  if (techBull > techBear) {
    if (ema9 > ema21) technicalScore += 15;
    if (ema21 > ema50) technicalScore += 10;
    if (rsi > 50 && rsi < 70) technicalScore += 10;
    if (macd > macdSignal) technicalScore += 10;
    if (adx > 25) technicalScore += 5;
  } else if (techBear > techBull) {
    if (ema9 < ema21) technicalScore += 15;
    if (ema21 < ema50) technicalScore += 10;
    if (rsi < 50 && rsi > 30) technicalScore += 10;
    if (macd < macdSignal) technicalScore += 10;
    if (adx > 25) technicalScore += 5;
  } else {
    technicalScore = 25;
  }

  const direction = techBull > techBear ? "BULLISH" : techBear > techBull ? "BEARISH" : "NEUTRAL";
  return { technicalScore, adx, rsi, bull: techBull, bear: techBear, direction };
}

function volumeScoreOld(rvol: number): number {
  if (rvol > 1.5) return 80;
  if (rvol > 1.2) return 60;
  return 30;
}
function volumeScoreNew(rvol: number): number {
  if (rvol >= 2.0) return 95;
  if (rvol >= 1.5) return 80;
  if (rvol >= 1.2) return 60;
  return 30;
}

function totalOld(tech: number, vol: number): number {
  // neutral 50 for engine/market/sector/options/news/fundamental
  return Math.round(
    50 * OLD_W.market + 50 * OLD_W.sector + tech * OLD_W.tech + 50 * OLD_W.engine +
    50 * OLD_W.options + vol * OLD_W.volume + 50 * OLD_W.fundamental + 50 * OLD_W.news
  );
}
function totalNew(tech: number, vol: number): number {
  return Math.round(
    50 * NEW_W.market + 50 * NEW_W.sector + tech * NEW_W.tech + 50 * NEW_W.engine +
    50 * NEW_W.options + vol * NEW_W.volume + 50 * NEW_W.news
  );
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchDay(symbol: string, day: string): Promise<IntraBar[]> {
  try {
    const r = await getIntradayCandles(symbol, day, "5minute");
    return r.candles ?? [];
  } catch {
    return [];
  }
}

async function fetchDaily(symbol: string): Promise<Candle[]> {
  try {
    const c = await getHistoricalCandles(symbol, "1d", 80);
    // normalize time to epoch ms if string
    return c.map((x: any) => ({
      time: typeof x.time === "number" ? x.time : Date.parse(String(x.time).replace(" ", "T")),
      open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0,
    })).filter((x) => Number.isFinite(x.time));
  } catch {
    return [];
  }
}

interface Row {
  day: string; time: string; symbol: string;
  price: number; closePrice: number;
  fwdPct: number;
  tech: number; adx: number; rsi: number; rvol: number;
  volOld: number; volNew: number;
  techOld: number; techNew: number;
  totalOld: number; totalNew: number;
  direction: string;
  oldRank?: number; newRank?: number;
}

async function main() {
  const rows: Row[] = [];
  const symbols = NIFTY50_STOCKS.map((s) => s.symbol);
  console.log(`Backtest: ${DAYS.join(", ")} | ${symbols.length} stocks | times ${DECISION_TIMES.join(", ")}`);

  // Pre-fetch daily once per symbol (technicals)
  const dailyBySym = new Map<string, Candle[]>();
  let di = 0;
  for (const sym of symbols) {
    dailyBySym.set(sym, await fetchDaily(sym));
    if (++di % 10 === 0) console.log(`  daily ${di}/${symbols.length}`);
    await sleep(50);
  }

  for (const day of DAYS) {
    console.log(`\n=== ${day} ===`);
    let fi = 0;
    for (const sym of symbols) {
      const bars = await fetchDay(sym, day);
      fi++;
      if (fi % 10 === 0) console.log(`  5m ${fi}/${symbols.length} (${sym}: ${bars.length} bars)`);
      if (bars.length < 30) continue;

      // Prior-day volume for RVOL baseline: use daily volume of previous bar(s)
      const daily = dailyBySym.get(sym) ?? [];
      // daily last entry may be current day — take volumes of bars strictly before this day
      const dayEpoch = Date.parse(day + "T00:00:00+05:30");
      const priorDaily = daily.filter((d) => d.time < dayEpoch - 86_400_000 + 12 * 3600_000);
      // simpler: all daily except the one on/after day
      const priorVols = daily.filter((d) => {
        const dt = new Date(d.time);
        const ds = dt.toISOString().slice(0, 10); // may be off by TZ; also try IST
        return d.time < dayEpoch;
      }).map((d) => d.volume).filter((v) => v > 0);
      // Use last 20 prior daily volumes
      const avgDailyVol = priorVols.length
        ? priorVols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(priorVols.length, 20)
        : 0;

      const mlCandles = toMlCandles(bars);
      const sessionCloseBar = bars[bars.length - 1];
      const sessionClose = sessionCloseBar.close;

      for (const dtStr of DECISION_TIMES) {
        const [hh, mm] = dtStr.split(":").map(Number);
        const targetMin = hh * 60 + mm;
        // find bar at or after target
        const idx = bars.findIndex((b) => parseIntraTime(b.time) >= targetMin);
        if (idx < 0 || idx >= bars.length - 1) continue;

        const bar = bars[idx];
        const price = bar.close;
        const decisionMin = parseIntraTime(bar.time);
        const elapsed = Math.max(1, decisionMin - SESSION_START_MIN);

        // cumulative volume to decision
        let cumVol = 0;
        for (let i = 0; i <= idx; i++) cumVol += bars[i].volume;

        // time-adjusted RVOL: today's rate vs prior full-day rate
        let rvol = 1;
        if (avgDailyVol > 0) {
          const rateToday = cumVol / elapsed;
          const ratePrior = avgDailyVol / SESSION_LEN;
          rvol = ratePrior > 0 ? rateToday / ratePrior : 1;
        }

        // technicals from 5m bars up to decision (enough bars) + daily for context
        // Use daily candles ending before this day for stable EMA/RSI/ADX (as scanner uses daily)
        const dailyUpTo = daily.filter((d) => d.time < dayEpoch);
        const techSrc = dailyUpTo.length >= 50 ? dailyUpTo : mlCandles.slice(0, idx + 1);
        const { technicalScore: techRaw, adx, rsi, direction } = techScore(techSrc, price);

        // NEW: ADX chop dampener
        const techNew = adx < 20 ? Math.round(techRaw * 0.75) : techRaw;
        const techOld = techRaw;

        const volOld = volumeScoreOld(rvol);
        const volNew = volumeScoreNew(rvol);

        const fwdPct = ((sessionClose - price) / price) * 100;

        rows.push({
          day, time: dtStr, symbol: sym,
          price, closePrice: sessionClose,
          fwdPct: Math.round(fwdPct * 100) / 100,
          tech: techRaw, adx: Math.round(adx * 10) / 10, rsi: Math.round(rsi * 10) / 10,
          rvol: Math.round(rvol * 100) / 100,
          volOld, volNew, techOld, techNew,
          totalOld: totalOld(techOld, volOld),
          totalNew: totalNew(techNew, volNew),
          direction,
        });
      }
      await sleep(30);
    }
  }

  // Rank within each day+time bucket
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.day}|${r.time}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }

  for (const [, list] of buckets) {
    const byOld = [...list].sort((a, b) => b.totalOld - a.totalOld);
    const byNew = [...list].sort((a, b) => b.totalNew - a.totalNew);
    byOld.forEach((r, i) => (r.oldRank = i + 1));
    byNew.forEach((r, i) => (r.newRank = i + 1));
  }

  // ── Report ──
  console.log("\n" + "=".repeat(80));
  console.log("SCANNER WEIGHT BACKTEST — last 2 trading days (real Breeze 5m candles)");
  console.log("Engine/market/sector/options/news held at neutral 50 (isolates weight + RVOL + ADX changes)");
  console.log("=".repeat(80));

  // 1. Top-5 portfolio return per bucket: OLD vs NEW ranking (long top5 by score)
  let oldSum = 0, newSum = 0, nB = 0;
  let oldWin = 0, newWin = 0, nPick = 0;
  const detail: string[] = [];

  for (const [k, list] of [...buckets.entries()].sort()) {
    if (list.length < 10) continue;
    const byOld = [...list].sort((a, b) => b.totalOld - a.totalOld).slice(0, 5);
    const byNew = [...list].sort((a, b) => b.totalNew - a.totalNew).slice(0, 5);
    // Directional: if BULLISH take positive fwd; score doesn't encode long/short here —
    // use direction: long if BULLISH, short if BEARISH (fwd inverted for short)
    const portReturn = ( picks: Row[] ) => {
      let s = 0;
      for (const p of picks) {
        const dirMult = p.direction === "BEARISH" ? -1 : p.direction === "BULLISH" ? 1 : 0;
        // neutral: use raw fwd as long-ish (score high usually bullish tilt) — skip neutral
        if (dirMult === 0) { s += p.fwdPct; } // treat as long for comparability
        else s += p.fwdPct * dirMult;
      }
      return s / picks.length;
    };
    const o = portReturn(byOld);
    const n = portReturn(byNew);
    oldSum += o; newSum += n; nB++;
    for (const p of byOld) { nPick++; if ((p.direction === "BEARISH" ? -p.fwdPct : p.fwdPct) > 0) oldWin++; }
    for (const p of byNew) { nPick++; if ((p.direction === "BEARISH" ? -p.fwdPct : p.fwdPct) > 0) newWin++; }

    detail.push(
      `${k}  OLD top5 avg ${o.toFixed(2)}%  |  NEW top5 avg ${n.toFixed(2)}%  |  ` +
      `OLD: ${byOld.map((p) => `${p.symbol}(${p.totalOld},${p.direction[0]},${p.fwdPct}%)`).join(" ")}  |  ` +
      `NEW: ${byNew.map((p) => `${p.symbol}(${p.totalNew},${p.direction[0]},${p.fwdPct}%)`).join(" ")}`
    );
  }

  console.log("\n── Per bucket (top-5 mean directional return to close) ──");
  for (const d of detail) console.log(d);

  console.log("\n── Aggregate ──");
  console.log(`Buckets: ${nB}`);
  console.log(`OLD top-5 avg return: ${(oldSum / Math.max(1, nB)).toFixed(3)}%   hit-rate: ${(100 * oldWin / Math.max(1, nPick / 2)).toFixed(1)}%`);
  console.log(`NEW top-5 avg return: ${(newSum / Math.max(1, nB)).toFixed(3)}%   hit-rate: ${(100 * newWin / Math.max(1, nPick / 2)).toFixed(1)}%`);

  // 2. Score distribution shift
  const avgOld = rows.reduce((s, r) => s + r.totalOld, 0) / Math.max(1, rows.length);
  const avgNew = rows.reduce((s, r) => s + r.totalNew, 0) / Math.max(1, rows.length);
  console.log(`\nMean totalScore: OLD ${avgOld.toFixed(1)} → NEW ${avgNew.toFixed(1)}`);

  // 3. RVOL tier impact
  const tier = { old80: 0, new95: 0, promoted: 0, adxDamp: 0 };
  for (const r of rows) {
    if (r.rvol >= 2.0) { tier.new95++; if (r.volOld === 80) tier.promoted++; }
    if (r.adx < 20) tier.adxDamp++;
  }
  console.log(`RVOL≥2.0 observations: ${tier.new95} (promoted from 80→95: ${tier.promoted})`);
  console.log(`ADX<20 (tech dampened ×0.75): ${tier.adxDamp} / ${rows.length} (${(100 * tier.adxDamp / Math.max(1, rows.length)).toFixed(1)}%)`);

  // 4. How often top-5 membership changed
  let changed = 0, totalB = 0;
  for (const [, list] of buckets) {
    if (list.length < 10) continue;
    totalB++;
    const o = new Set([...list].sort((a, b) => b.totalOld - a.totalOld).slice(0, 5).map((r) => r.symbol));
    const n = new Set([...list].sort((a, b) => b.totalNew - a.totalNew).slice(0, 5).map((r) => r.symbol));
    const inter = [...o].filter((s) => n.has(s)).length;
    if (inter < 5) changed++;
  }
  console.log(`Top-5 membership changed in ${changed}/${totalB} buckets`);

  // 5. High-score NEW picks detail (score ≥ threshold)
  console.log("\n── NEW score ≥ 60 picks (all buckets) ──");
  const hi = rows.filter((r) => r.totalNew >= 60).sort((a, b) => b.totalNew - a.totalNew).slice(0, 25);
  for (const r of hi) {
    console.log(
      `${r.day} ${r.time} ${r.symbol.padEnd(12)} NEW=${r.totalNew} OLD=${r.totalOld} ` +
      `dir=${r.direction.padEnd(8)} rvol=${r.rvol} adx=${r.adx} techO/N=${r.techOld}/${r.techNew} ` +
      `fwd=${r.fwdPct}%`
    );
  }

  // 6. Component comparison: avg technical and volume scores
  const avg = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0) / Math.max(1, rows.length);
  console.log("\n── Component means ──");
  console.log(`tech (old, no damp): ${avg((r) => r.techOld).toFixed(1)}  |  tech (new, damp): ${avg((r) => r.techNew).toFixed(1)}`);
  console.log(`vol (old tiers): ${avg((r) => r.volOld).toFixed(1)}  |  vol (new tiers): ${avg((r) => r.volNew).toFixed(1)}`);

  // Save CSV
  const fs = await import("fs");
  const header = "day,time,symbol,price,close,fwdPct,rvol,adx,rsi,techOld,techNew,volOld,volNew,totalOld,totalNew,direction,oldRank,newRank\n";
  const csv = header + rows.map((r) =>
    [r.day, r.time, r.symbol, r.price, r.closePrice, r.fwdPct, r.rvol, r.adx, r.rsi,
     r.techOld, r.techNew, r.volOld, r.volNew, r.totalOld, r.totalNew, r.direction,
     r.oldRank ?? "", r.newRank ?? ""].join(",")
  ).join("\n");
  fs.writeFileSync("data/scanner-weight-backtest-2d.csv", csv);
  console.log("\nCSV → data/scanner-weight-backtest-2d.csv");
  console.log(`Rows: ${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
