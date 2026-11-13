/**
 * Full-engine scanner gate backtest — 7 trading days.
 *
 * Uses the PRODUCTION equity engine (auction + volume profile + liquidity
 * sweeps + VWAP + regime) on real Breeze 5m bars at each decision time,
 * then applies gates in research-priority order:
 *
 *   P0 (independent dimensions — research-backed lift):
 *     G0  raw engine direction (score ≥ 70)
 *     G1  + daily EMA200 trend align (LONG>ema, SHORT<ema)
 *     G2  + relative strength vs NIFTY (same session window)
 *     G3  + chop-day regime (NIFTY 5m ADX≥20, else require eng≥80)
 *
 *   P1 (existing filters):
 *     G4  + VWAP bias
 *     G5  + session time gate (09:30–15:00)
 *     G6  + RVOL ≥ 1.5
 *     G7  + stock ADX ≥ 20
 *     G8  + top-5 shortlist
 *     G9  + strong-setup whitelist
 *
 * Accuracy = share of gated directional picks that finished the session
 * in the signal direction (close vs entry). Target: ≥70%.
 *
 * Usage: bun run scripts/scanner-gate-backtest.ts
 */
import { NIFTY50_STOCKS } from "../src/lib/intraday-scanner";
import { analyzeEquityCash } from "../src/lib/equity-cash-engine";
import { calculateSessionVWAP } from "../src/lib/vwap-engine";
import { calculateADX, type Candle as MlCandle } from "../src/lib/ml-engine";
import { getIntradayCandles } from "../src/lib/breeze-historical";
import { getHistoricalCandles } from "../src/lib/historical-data";

const DAYS = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-11", "2026-11-12", "2026-11-13"];
const DECISION_TIMES = ["10:00", "11:00", "12:00", "13:00"];
const SESSION_START_MIN = 9 * 60 + 15;
const SESSION_END_MIN = 15 * 60 + 25;
const INDEX_SYM = "NIFTY";
const EMA_PERIOD = 200;
const DAILY_LOOKBACK = 210;

/** Setups with plausible structural edge — tested as a whitelist (G9). */
const STRONG_SETUPS = new Set([
  "HVN_REJECTION_BULLISH", "VWAP_RECLAIM", "VAL_RECLAIM",
  "POC_RECLAIM", "OPENING_RANGE_BREAKOUT",
]);

type IntraBar = { time: string; open: number; high: number; low: number; close: number; volume: number };

function parseMin(t: string): number {
  const m = t.match(/(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

/** Epoch-ms candles for the equity engine (auction-types.Candle). */
function toEngineCandles(bars: IntraBar[], day: string, upToIdx: number) {
  return bars.slice(0, upToIdx + 1).map((b) => {
    const [hh, mm] = b.time.slice(11, 16).split(":").map(Number);
    const [Y, M, D] = day.split("-").map(Number);
    const time = Date.UTC(Y, M - 1, D, hh - 5, mm - 30); // IST → UTC
    return { time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  });
}

function toMl(bars: IntraBar[]): MlCandle[] {
  return bars.map((b) => {
    const [hh, mm] = b.time.slice(11, 16).split(":").map(Number);
    return { time: hh * 60 + mm, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  });
}

/** EMA over closes[0..endIdx) — endIdx is exclusive (no look-ahead past day). */
function emaAt(closes: number[], endIdx: number, period: number): number | null {
  if (endIdx < period) return null;
  const slice = closes.slice(0, endIdx);
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += slice[i];
  ema /= period;
  for (let i = period; i < slice.length; i++) ema = slice[i] * k + ema * (1 - k);
  return ema;
}

interface Pick {
  day: string; time: string; symbol: string;
  dir: "LONG" | "SHORT";
  entry: number; close: number; fwdSignedPct: number; // positive = won
  engineScore: number; setup: string;
  rvol: number; adx: number; vwap: number; aboveVwap: boolean;
  ema200: number | null; aboveEma200: boolean | null;
  rs: number; niftyAdx: number;
  passed: Record<string, boolean>;
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Breeze rate-limits aggressively — retry with backoff, never fabricate bars. */
async function fetchDay(symbol: string, day: string): Promise<IntraBar[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await getIntradayCandles(symbol, day, "5minute");
      if (r.candles && r.candles.length) return r.candles;
      if (attempt === 3) return r.candles ?? [];
    } catch { /* retry */ }
    await sleep(400 * attempt);
  }
  return [];
}

async function main() {
  const symbols = NIFTY50_STOCKS.map((s) => s.symbol);
  const allPicks: Pick[] = [];
  const stats: Record<string, { n: number; win: number }> = {};
  for (const g of ["G0","G1","G2","G3","G4","G5","G6","G7","G8","G9"]) stats[g] = { n: 0, win: 0 };
  const p0Solo: Record<string, { n: number; win: number }> = {
    ema: { n: 0, win: 0 }, rs: { n: 0, win: 0 }, regime: { n: 0, win: 0 },
  };
  let daysWithData = 0;
  let symbolsWithData = 0;

  // Daily history for EMA200 + prev-day levels (lookback ≥ EMA_PERIOD + buffer)
  const dailyBySym = new Map<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>();
  let di = 0;
  for (const sym of symbols) {
    try {
      const c = await getHistoricalCandles(sym, "1d", DAILY_LOOKBACK);
      dailyBySym.set(sym, c.map((x: any) => ({
        time: typeof x.time === "number" ? x.time : Date.parse(String(x.time).replace(" ", "T")),
        open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0,
      })).filter((x) => Number.isFinite(x.time)));
    } catch { dailyBySym.set(sym, []); }
    if (++di % 10 === 0) console.log(`daily ${di}/${symbols.length}`);
    await sleep(40);
  }

  // NIFTY 5m per day → RS + chop-day regime (fetched once per day)
  const niftyByDay = new Map<string, IntraBar[]>();

  for (const day of DAYS) {
    console.log(`\n=== ${day} ===`);
    const dayEpoch = Date.parse(day + "T00:00:00+05:30");

    // NIFTY session bars for RS + regime
    let niftyBars: IntraBar[] = [];
    try {
      niftyBars = await fetchDay(INDEX_SYM, day);
      niftyByDay.set(day, niftyBars);
      console.log(`  NIFTY 5m: ${niftyBars.length} bars`);
    } catch { niftyByDay.set(day, []); }
    await sleep(150);

    let fi = 0;
    for (const sym of symbols) {
      let bars: IntraBar[] = [];
      bars = await fetchDay(sym, day);
      fi++;
      if (fi % 10 === 0) console.log(`  5m ${fi}/${symbols.length} (ok=${bars.length > 0 ? 1 : 0})`);
      if (bars.length < 40) continue;
      symbolsWithData++;
      await sleep(120);

      const daily = dailyBySym.get(sym) ?? [];
      const prior = daily.filter((d) => d.time < dayEpoch);
      const prev = prior[prior.length - 1];
      const week = prior.slice(-6, -1);
      const prevDayHigh = prev?.high ?? bars[0].open;
      const prevDayLow = prev?.low ?? bars[0].open;
      const prevWeekHigh = week.length ? Math.max(...week.map((c) => c.high)) : prevDayHigh;
      const prevWeekLow = week.length ? Math.min(...week.map((c) => c.low)) : prevDayLow;

      // Daily EMA200 on closes strictly before this session (no look-ahead)
      const priorCloses = prior.map((d) => d.close);
      const ema200 = emaAt(priorCloses, priorCloses.length, EMA_PERIOD);

      // RVOL baseline: avg prior daily volume
      const priorVols = prior.map((d) => d.volume).filter((v) => v > 0).slice(-20);
      const avgDailyVol = priorVols.length ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : 0;
      const sessionLen = SESSION_END_MIN - SESSION_START_MIN;

      const sessionClose = bars[bars.length - 1].close;
      const mlAll = toMl(bars);

      // NIFTY context for this day
      const nifty = niftyByDay.get(day) ?? [];
      const niftyMl = nifty.length ? toMl(nifty) : [];
      const niftyOpen = nifty.length ? nifty[0].open : 0;
      const stockOpen = bars[0].open;

      for (const dtStr of DECISION_TIMES) {
        const targetMin = parseMin(dtStr);
        const idx = bars.findIndex((b) => parseMin(b.time) >= targetMin);
        if (idx < 5 || idx >= bars.length - 1) continue;

        const bar = bars[idx];
        const price = bar.close;
        const decisionMin = parseMin(bar.time);

        // ── Engine ──
        const engBars = toEngineCandles(bars, day, idx);
        let engineScore = 0;
        let engineDir: "LONG" | "SHORT" | "NO_TRADE" = "NO_TRADE";
        let setup = "";
        try {
          const a = analyzeEquityCash(sym, engBars, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);
          engineDir = a.finalDecision;
          const plan = engineDir === "LONG" ? a.bestLong : engineDir === "SHORT" ? a.bestShort : null;
          engineScore = plan?.signalScore.total ?? 0;
          setup = plan?.setup || a.data.auctionState || "";
        } catch { /* engine failed on this slice */ }

        // ── VWAP ──
        const { vwap } = calculateSessionVWAP(engBars);
        const aboveVwap = price >= vwap;

        // ── RVOL (time-adjusted) ──
        let cumVol = 0;
        for (let i = 0; i <= idx; i++) cumVol += bars[i].volume;
        const elapsed = Math.max(1, decisionMin - SESSION_START_MIN);
        let rvol = 1;
        if (avgDailyVol > 0) {
          const ratePrior = avgDailyVol / sessionLen;
          rvol = ratePrior > 0 ? cumVol / elapsed / ratePrior : 1;
        }

        // ── Stock ADX on 5m to decision ──
        const slice = mlAll.slice(0, idx + 1);
        let adx = 20;
        try { if (slice.length >= 30) adx = calculateADX(slice, 14); } catch { /* */ }

        // ── P0: RS vs NIFTY (session-to-decision, same window) ──
        let rs = 0;
        if (nifty.length > 0 && niftyOpen > 0 && stockOpen > 0) {
          const nIdx = nifty.findIndex((b) => parseMin(b.time) >= targetMin);
          const nPrice = nIdx >= 0 ? nifty[nIdx].close : nifty[nifty.length - 1].close;
          const stockRet = ((price - stockOpen) / stockOpen) * 100;
          const niftyRet = ((nPrice - niftyOpen) / niftyOpen) * 100;
          rs = stockRet - niftyRet;
        }

        // ── P0: chop-day regime (NIFTY 5m ADX to decision) ──
        let niftyAdx = 20;
        try {
          const nIdx = niftyMl.findIndex((b) => b.time >= targetMin);
          const nEnd = nIdx >= 0 ? nIdx + 1 : niftyMl.length;
          const nSlice = niftyMl.slice(0, nEnd);
          if (nSlice.length >= 30) niftyAdx = calculateADX(nSlice, 14);
        } catch { /* */ }

        if (engineDir === "NO_TRADE" || engineScore < 70) continue;

        const dir = engineDir;
        const won = dir === "LONG" ? sessionClose >= price : sessionClose <= price;
        const fwdSignedPct = dir === "LONG"
          ? ((sessionClose - price) / price) * 100
          : ((price - sessionClose) / price) * 100;

        // Gates
        const aboveEma200 = ema200 != null ? price >= ema200 : null;
        const gEma = ema200 == null ? true : (dir === "LONG" ? aboveEma200! : !aboveEma200!);
        // Direction-aware RS: LONG needs stock outperforming NIFTY, SHORT underperforming.
        // rs === 0 (or NIFTY missing) → neutral pass.
        const gRs = rs === 0 ? true : dir === "LONG" ? rs > 0 : rs < 0;
        // Chop: NIFTY ADX < 20 → only allow engine ≥80 (research: chop-day WR ~39%)
        const gRegime = niftyAdx >= 20 || engineScore >= 80;
        const gVwap = dir === "LONG" ? aboveVwap : !aboveVwap;
        const gTime = decisionMin >= 9 * 60 + 30 && decisionMin <= 15 * 60;
        const gRvol = rvol >= 1.5;
        const gAdx = adx >= 20;

        const pick: Pick = {
          day, time: dtStr, symbol: sym, dir,
          entry: price, close: sessionClose,
          fwdSignedPct: Math.round(fwdSignedPct * 100) / 100,
          engineScore, setup: String(setup).slice(0, 40),
          rvol: Math.round(rvol * 100) / 100,
          adx: Math.round(adx * 10) / 10,
          vwap: Math.round(vwap * 100) / 100,
          aboveVwap,
          ema200: ema200 != null ? Math.round(ema200 * 100) / 100 : null,
          aboveEma200,
          rs: Math.round(rs * 100) / 100,
          niftyAdx: Math.round(niftyAdx * 10) / 10,
          passed: {
            base: true, ema: gEma, rs: gRs, regime: gRegime,
            vwap: gVwap, time: gTime, rvol: gRvol, adx: gAdx, rank: false,
          },
        };
        allPicks.push(pick);
      }
      await sleep(25);
    }
    await sleep(500);
    if (symbolsWithData > 0) daysWithData++;
    console.log(`  coverage: ${symbolsWithData} symbols with ≥40 bars`);
    symbolsWithData = 0;
  }

  // Rank within bucket among G7-passing picks → top 5
  const buckets = new Map<string, Pick[]>();
  for (const p of allPicks) {
    const k = `${p.day}|${p.time}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  for (const [, list] of buckets) {
    const eligible = list.filter((p) =>
      p.passed.ema && p.passed.rs && p.passed.regime &&
      p.passed.vwap && p.passed.time && p.passed.rvol && p.passed.adx
    );
    eligible.sort((a, b) => b.engineScore - a.engineScore || b.rvol - a.rvol);
    const top = new Set(eligible.slice(0, 5).map((p) => p.symbol + p.dir));
    for (const p of eligible) {
      p.passed.rank = top.has(p.symbol + p.dir);
    }
  }

  // ── Gate ladder accuracy (P0 first, then P1) ──
  const all = (p: Pick) => p.passed.base;
  const chain: Array<[string, (p: Pick) => boolean, string]> = [
    ["G0", (p) => all(p), "engine ≥70 direction"],
    ["G1", (p) => all(p) && p.passed.ema, "+ daily EMA200 align"],
    ["G2", (p) => all(p) && p.passed.ema && p.passed.rs, "+ RS vs NIFTY (session)"],
    ["G3", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime, "+ chop regime (NIFTY ADX/eng≥80)"],
    ["G4", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap, "+ VWAP bias"],
    ["G5", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap && p.passed.time, "+ time (09:30–15:00)"],
    ["G6", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap && p.passed.time && p.passed.rvol, "+ RVOL ≥1.5"],
    ["G7", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap && p.passed.time && p.passed.rvol && p.passed.adx, "+ stock ADX ≥20"],
    ["G8", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap && p.passed.time && p.passed.rvol && p.passed.adx && p.passed.rank, "+ top-5 shortlist"],
    ["G9", (p) => all(p) && p.passed.ema && p.passed.rs && p.passed.regime && p.passed.vwap && p.passed.time && p.passed.rvol && p.passed.adx && p.passed.rank && STRONG_SETUPS.has(p.setup), "+ strong-setup whitelist"],
  ];

  // Solo P0 effects on G0
  for (const p of allPicks) {
    if (p.passed.ema) { p0Solo.ema.n++; if (p.fwdSignedPct > 0) p0Solo.ema.win++; }
    if (p.passed.rs) { p0Solo.rs.n++; if (p.fwdSignedPct > 0) p0Solo.rs.win++; }
    if (p.passed.regime) { p0Solo.regime.n++; if (p.fwdSignedPct > 0) p0Solo.regime.win++; }
  }

  console.log("\n" + "=".repeat(78));
  console.log("FULL-ENGINE GATE BACKTEST (P0: EMA200 + RS + regime → P1 filters)");
  console.log(`Days: ${DAYS.join(", ")} | times: ${DECISION_TIMES.join(", ")} | universe: NIFTY50`);
  console.log("Accuracy = finished session in signal direction (close vs entry)");
  console.log("=".repeat(78));

  console.log("\nSolo P0 pass rates on G0 base:");
  const baseN = allPicks.length;
  const baseWin = allPicks.filter((p) => p.fwdSignedPct > 0).length;
  console.log(`  G0 base:              n=${String(baseN).padStart(4)}  acc=${baseN ? ((100*baseWin)/baseN).toFixed(1) : "0.0"}%`);
  for (const [k, label] of [["ema","EMA200 align"],["rs","RS>0 same-sign"],["regime","regime pass"]] as const) {
    const s = p0Solo[k];
    const acc = s.n ? (100 * s.win) / s.n : 0;
    console.log(`  ${label.padEnd(22)} n=${String(s.n).padStart(4)}  acc=${acc.toFixed(1)}%  (kept ${baseN ? ((100*s.n)/baseN).toFixed(0) : 0}% of base)`);
  }

  console.log("\nGate ladder (cumulative, P0 first):");
  console.log("Gate  Description                              n     win%    vs 70% target");
  console.log("-".repeat(78));

  for (const [g, fn, label] of chain) {
    const subset = allPicks.filter(fn);
    const n = subset.length;
    const win = subset.filter((p) => p.fwdSignedPct > 0).length;
    const acc = n ? (100 * win) / n : 0;
    const delta = acc - 70;
    stats[g].n = n;
    stats[g].win = win;
    console.log(
      `${g}     ${label.padEnd(40)} ${String(n).padStart(4)}  ${acc.toFixed(1).padStart(5)}%   ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp`
    );
  }

  // Detail for best non-empty P0 stage (G3) and full ladder tail
  for (const key of ["G3", "G8", "G9"]) {
    const picks = allPicks.filter(chain.find(([g]) => g === key)![1]);
    if (!picks.length) continue;
    const avgR = picks.reduce((s, p) => s + p.fwdSignedPct, 0) / picks.length;
    console.log(`\n${key}: n=${picks.length} avg signed return=${avgR.toFixed(3)}%`);
    if (key !== "G3") {
      for (const p of picks.sort((a, b) => b.engineScore - a.engineScore).slice(0, 25)) {
        console.log(
          `  ${p.day} ${p.time} ${p.symbol.padEnd(12)} ${p.dir.padEnd(5)} eng=${p.engineScore} ` +
          `rs=${p.rs} nAdx=${p.niftyAdx} ema=${p.ema200 ?? "-"} ` +
          `fwd=${p.fwdSignedPct > 0 ? "+" : ""}${p.fwdSignedPct}% ${p.fwdSignedPct > 0 ? "WIN" : "LOSS"} ${p.setup}`
        );
      }
    } else {
      // G3 by setup + direction
      const by = new Map<string, { n: number; win: number }>();
      for (const p of picks) {
        const k = `${p.setup}|${p.dir}`;
        if (!by.has(k)) by.set(k, { n: 0, win: 0 });
        const s = by.get(k)!; s.n++; if (p.fwdSignedPct > 0) s.win++;
      }
      console.log("  G3 by setup|dir:");
      for (const [k, s] of [...by.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`    ${k.padEnd(44)} n=${String(s.n).padStart(3)}  acc=${((100*s.win)/s.n).toFixed(1)}%`);
      }
    }
  }

  // Setup breakdown of G0
  console.log("\nG0 by setup (accuracy):");
  const bySetup = new Map<string, { n: number; win: number }>();
  for (const p of allPicks) {
    const k = p.setup || "?";
    if (!bySetup.has(k)) bySetup.set(k, { n: 0, win: 0 });
    const s = bySetup.get(k)!;
    s.n++;
    if (p.fwdSignedPct > 0) s.win++;
  }
  for (const [k, s] of [...bySetup.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(36)} n=${String(s.n).padStart(3)}  acc=${((100 * s.win) / s.n).toFixed(1)}%`);
  }

  // CSV
  const fs = await import("fs");
  const header = "day,time,symbol,dir,entry,close,fwdSignedPct,engineScore,setup,rvol,adx,vwap,aboveVwap,ema200,aboveEma200,rs,niftyAdx,gEma,gRs,gRegime,gVwap,gTime,gRvol,gAdx,gRank\n";
  const csv = header + allPicks.map((p) =>
    [p.day, p.time, p.symbol, p.dir, p.entry, p.close, p.fwdSignedPct, p.engineScore,
     `"${p.setup}"`, p.rvol, p.adx, p.vwap, p.aboveVwap,
     p.ema200 ?? "", p.aboveEma200 ?? "", p.rs, p.niftyAdx,
     p.passed.ema, p.passed.rs, p.passed.regime, p.passed.vwap, p.passed.time,
     p.passed.rvol, p.passed.adx, p.passed.rank].join(",")
  ).join("\n");
  fs.writeFileSync("data/scanner-gate-backtest-p0.csv", csv);
  console.log(`\nCSV → data/scanner-gate-backtest-p0.csv  (${allPicks.length} engine signals)`);

  const g3Acc = stats.G3.n ? (100 * stats.G3.win) / stats.G3.n : 0;
  const g8Acc = stats.G8.n ? (100 * stats.G8.win) / stats.G8.n : 0;
  const g9Acc = stats.G9.n ? (100 * stats.G9.win) / stats.G9.n : 0;
  console.log(`\nP0 core  G3 accuracy: ${g3Acc.toFixed(1)}%  n=${stats.G3.n}  (target 70%)  ${g3Acc >= 70 ? "✅ MET" : "❌ BELOW"}`);
  console.log(`Full     G8 accuracy: ${g8Acc.toFixed(1)}%  n=${stats.G8.n}  (target 70%)  ${g8Acc >= 70 ? "✅ MET" : "❌ BELOW"}`);
  console.log(`Full+setup G9 accuracy: ${g9Acc.toFixed(1)}%  n=${stats.G9.n}  (target 70%)  ${g9Acc >= 70 ? "✅ MET" : "❌ BELOW"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
