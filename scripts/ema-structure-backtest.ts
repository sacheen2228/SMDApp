// EMA 9/21/50 market-structure strategy — B0/B1/B2 comparison.
//
// B0: existing equity-cash engine direction (analyzeEquityCash) — unchanged.
// B1: new EMA structure engine direction (analyzeEmaStructure alignment).
// B2: B0 + EMA as shadow confirmation (recorded, not gating).
//
// Uses closed candles only (closedOnly — no look-ahead), timestamp-aligned
// historical data. Writes data/ema-structure-backtest-<run>.csv.
//
// Usage: bun run scripts/ema-structure-backtest.ts

import { analyzeEquityCash } from "../src/lib/equity-cash-engine";
import { analyzeEmaStructure, type EmaStructure } from "../src/lib/ema-structure";
import { closedOnly } from "../src/lib/tech-read";
import { getIntradayCandles } from "../src/lib/breeze-historical";

const DAYS = [
  "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
  "2026-11-11", "2026-11-12", "2026-11-13",
];
const DECISION_TIMES = ["10:00", "11:00", "12:00", "13:00"];
// Representative liquid names across sectors.
const SYMBOLS = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR",
  "SBIN", "BHARTIARTL", "LT", "AXISBANK", "TATASTEEL",
];
const INDEX_SYM = "NIFTY";
const SESSION_START_MIN = 9 * 60 + 15;
const SESSION_END_MIN = 15 * 30;
const BAR_MS = 5 * 60_000;

type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number };

function parseMin(t: string): number {
  const m = t.match(/(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDay(symbol: string, day: string): Promise<Bar[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await getIntradayCandles(symbol, day, "5minute");
      const bars = (res?.candles || [])
        .map((c: any) => ({
          time: String(c.time).replace(" ", "T"),
          open: Number(c.open), high: Number(c.high), low: Number(c.low),
          close: Number(c.close), volume: Number(c.volume || 0),
        }))
        .filter((b) => Number.isFinite(b.close))
        .sort((a, b) => a.time.localeCompare(b.time));
      if (bars.length) return bars;
      if (attempt === 3) return bars;
    } catch { /* retry */ }
    await sleep(400 * attempt);
  }
  return [];
}

function toEngineCandles(bars: Bar[], day: string, upToIdx: number) {
  return bars.slice(0, upToIdx + 1).map((b) => {
    const [hh, mm] = b.time.slice(11, 16).split(":").map(Number);
    const [Y, M, D] = day.split("-").map(Number);
    const time = Date.UTC(Y, M - 1, D, hh - 5, mm - 30); // IST → UTC
    return { time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  });
}

function toEmaCandles(bars: Bar[], day: string, upToIdx: number, nowMs: number) {
  const eng = toEngineCandles(bars, day, upToIdx);
  const closed = closedOnly(eng, nowMs);
  return closed.map((c) => ({
    time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v ?? 0,
  }));
}

function emaDirection(s: EmaStructure): "LONG" | "SHORT" | "NO_TRADE" {
  if (s.alignment === "BULLISH" && s.slope21 != null && s.slope21 > 0) return "LONG";
  if (s.alignment === "BEARISH" && s.slope21 != null && s.slope21 < 0) return "SHORT";
  return "NO_TRADE";
}

async function main() {
  const out: string[] = [
    "day,time,symbol,b0_dir,b0_score,b1_dir,b1_alignment,b1_ema9,b1_ema21,b1_ema50,entry,sessionClose,fwdSignedPct,b0_won,b1_won,agree,dataQuality",
  ];
  let total = 0, b0Trades = 0, b1Trades = 0, b0Won = 0, b1Won = 0;

  for (const day of DAYS) {
    const dayEpoch = Date.parse(day + "T00:00:00+05:30");
    for (const sym of SYMBOLS) {
      const bars = await fetchDay(sym, day);
      if (bars.length < 40) continue;
      const sessionClose = bars[bars.length - 1].close;

      for (const dtStr of DECISION_TIMES) {
        const targetMin = parseMin(dtStr);
        const idx = bars.findIndex((b) => parseMin(b.time) >= targetMin);
        if (idx < 5 || idx >= bars.length - 1) continue;
        total++;

        const price = bars[idx].close;
        const engBars = toEngineCandles(bars, day, idx);
        const nowMs = bars[idx].time ? Date.parse(bars[idx].time) + BAR_MS : Date.now();
        const emaCandles = toEmaCandles(bars, day, idx, nowMs);

        // ── B0: existing engine (unchanged) ──
        let b0Dir: "LONG" | "SHORT" | "NO_TRADE" = "NO_TRADE";
        let b0Score = 0;
        try {
          const prev = bars[idx - 1];
          const week = bars.slice(Math.max(0, idx - 30), idx);
          const a = analyzeEquityCash(
            sym, engBars,
            prev?.high ?? price, prev?.low ?? price,
            Math.max(...week.map((c) => c.high)), Math.min(...week.map((c) => c.low)),
          );
          b0Dir = a.finalDecision;
          const plan = b0Dir === "LONG" ? a.bestLong : b0Dir === "SHORT" ? a.bestShort : null;
          b0Score = plan?.signalScore.total ?? 0;
        } catch { /* engine failed on this slice */ }

        // ── B1: EMA structure engine ──
        let b1Dir: "LONG" | "SHORT" | "NO_TRADE" = "NO_TRADE";
        let b1: EmaStructure | null = null;
        try {
          b1 = analyzeEmaStructure(emaCandles, { nowMs });
          b1Dir = emaDirection(b1);
        } catch { /* EMA engine failed on this slice */ }

        const fwdSignedPct =
          b0Dir === "LONG" ? ((sessionClose - price) / price) * 100
          : b0Dir === "SHORT" ? ((price - sessionClose) / price) * 100 : 0;
        const b1FwdSignedPct =
          b1Dir === "LONG" ? ((sessionClose - price) / price) * 100
          : b1Dir === "SHORT" ? ((price - sessionClose) / price) * 100 : 0;

        const b0WonThis = b0Dir === "LONG" ? sessionClose >= price
          : b0Dir === "SHORT" ? sessionClose <= price : false;
        const b1WonThis = b1Dir === "LONG" ? sessionClose >= price
          : b1Dir === "SHORT" ? sessionClose <= price : false;
        const agree = b0Dir === b1Dir && b0Dir !== "NO_TRADE";

        out.push([
          day, dtStr, sym, b0Dir, b0Score, b1Dir,
          b1?.alignment ?? "MIXED",
          b1?.ema9 ?? "", b1?.ema21 ?? "", b1?.ema50 ?? "",
          price, sessionClose, fwdSignedPct.toFixed(4),
          b0WonThis, b1WonThis, agree, b1?.dataQuality ?? "INSUFFICIENT",
        ].join(","));

        if (b0Dir !== "NO_TRADE") { b0Trades++; if (b0WonThis) b0Won++; }
        if (b1Dir !== "NO_TRADE") { b1Trades++; if (b1WonThis) b1Won++; }
      }
      await sleep(120);
    }
    await sleep(200);
  }

  const run = new Date().toISOString().slice(0, 16).replace(/:/g, "-");
  const path = `data/ema-structure-backtest-${run}.csv`;
  require("fs").writeFileSync(path, out.join("\n"));
  console.log(`Wrote ${path} (${out.length - 1} rows)`);
  console.log(`B0: trades=${b0Trades} won=${b0Won} wr=${b0Trades ? (b0Won / b0Trades * 100).toFixed(1) : "n/a"}%`);
  console.log(`B1: trades=${b1Trades} won=${b1Won} wr=${b1Trades ? (b1Won / b1Trades * 100).toFixed(1) : "n/a"}%`);
  console.log(`total decision points evaluated=${total}`);
}

main().catch((e) => { console.error("BACKTEST FAILED:", e); process.exit(1); });
