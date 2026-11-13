/**
 * History-replay + Time-Machine gate — offline measurement (does NOT touch the app).
 *
 * Data: Breeze multi-day 5m (real, ≤1000 rows ≈ 15 sessions, disk-cached) +
 * Breeze/NSE daily for prev-day levels. MO is daily-only (not used for 5m).
 * No Yahoo. Same production engine (analyzeEquityCash) as the live scanner.
 *
 * Three history definitions (Time Machine's history_replay, loosened until n works):
 *   hist_dir     engine fires SAME direction (any setup, score≥70) at same clock time
 *   hist_family  same + setup family (HVN / VWAP / POC / ORB / SWEEP / …)
 *   hist_exact   same + exact setup string (too rare on 15 sessions — kept for reference)
 *
 * Monte Carlo (Time Machine simulate): bar-ratio pool from prior sessions,
 * stop checked before target (conservative), synthetic 1R/2R brackets from entry.
 *
 * Usage: bun run scripts/history-replay-gate.ts
 * Env:   HIST_MIN_N=5 HIST_WR=0.55 MC_REPLAYS=2000
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { analyzeEquityCash } from "../src/lib/equity-cash-engine";
import { initSession, getBreezeClient, getSessionState } from "../src/lib/icici-breeze/auth";
import { resolveBreezeStockCode } from "../src/lib/icici-scrip-master";
import { getHistoricalCandles } from "../src/lib/historical-data";

type Dir = "LONG" | "SHORT";

interface Signal {
  day: string; time: string; symbol: string; dir: Dir;
  entry: number; close: number; fwdSignedPct: number;
  engineScore: number; setup: string;
  rvol: number; adx: number;
  gEma: boolean; gRs: boolean; gRegime: boolean; gVwap: boolean;
}

interface Bar5 {
  date: string; time: string;
  open: number; high: number; low: number; close: number; volume: number;
}

interface HistStat { fires: number; wins: number; wr: number }

const MIN_HIST_N = Number(process.env.HIST_MIN_N || 5);
const WR_PASS = Number(process.env.HIST_WR || 0.55);
const LOOKBACK_DAYS = 50;
const MC_REPLAYS = Number(process.env.MC_REPLAYS || 2000);
const MC_SEED = 19;
const CACHE_5M = "data/cache/5m";
const CACHE_1D = "data/cache/1d";

mkdirSync(CACHE_5M, { recursive: true });
mkdirSync(CACHE_1D, { recursive: true });

function parseMin(t: string): number {
  const m = t.match(/(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}
function pad(n: number) { return String(n).padStart(2, "0"); }
function fmtBreeze(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function setupFamily(setup: string): string {
  const s = setup.toUpperCase();
  if (s.includes("HVN")) return "HVN";
  if (s.includes("VWAP")) return "VWAP";
  if (s.includes("POC")) return "POC";
  if (s.includes("VAL") || s.includes("VAH")) return "VA";
  if (s.includes("OPENING_RANGE")) return "ORB";
  if (s.includes("SWEEP")) return "SWEEP";
  return s.split("_")[0] || s;
}

function loadSignals(csv: string): Signal[] {
  const lines = csv.trim().split("\n").slice(1);
  const out: Signal[] = [];
  for (const l of lines) {
    const m = l.match(/^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),"([^"]*)",(.*)$/);
    if (!m) continue;
    const [, day, time, symbol, dir, entry, close, fwd, eng, setup] = m;
    const p = l.slice(m[0].length - m[10].length).split(",");
    out.push({
      day, time, symbol, dir: dir as Dir,
      entry: +entry, close: +close, fwdSignedPct: parseFloat(fwd),
      engineScore: +eng, setup,
      rvol: +p[0], adx: +p[1],
      gEma: p[8] === "true", gRs: p[9] === "true", gRegime: p[10] === "true",
      gVwap: p[11] === "true",
    });
  }
  return out;
}

async function fetch5mRange(symbol: string): Promise<Bar5[]> {
  const cachePath = `${CACHE_5M}/${symbol.toUpperCase()}.json`;
  if (existsSync(cachePath)) {
    try { return JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* refetch */ }
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const state = getSessionState();
      if (!state.authenticated) await initSession();
      const breeze = getBreezeClient();
      const stockCode = await resolveBreezeStockCode(symbol.toUpperCase());
      if (!stockCode) return [];
      const to = new Date();
      to.setHours(15, 30, 0, 0);
      const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
      from.setHours(9, 15, 0, 0);
      const r = await breeze.getHistoricalDatav2({
        interval: "5minute",
        fromDate: fmtBreeze(from),
        toDate: fmtBreeze(to),
        stockCode,
        exchangeCode: ["SENSEX", "BANKEX"].includes(symbol.toUpperCase()) ? "BSE" : "NSE",
        productType: "cash",
        expiryDate: "", right: "", strikePrice: "",
      });
      if (r?.Error || r?.Status === 401) {
        if (attempt === 3) return [];
        await sleep(500 * attempt);
        continue;
      }
      const rows: any[] = r?.Success || r?.data || r || [];
      if (!Array.isArray(rows) || !rows.length) return [];
      const bars: Bar5[] = [];
      for (const c of rows) {
        const timeStr = String(c.time || c.datetime || c.timestamp || "");
        if (!timeStr) continue;
        const open = Number(c.open ?? c.o), high = Number(c.high ?? c.h);
        const low = Number(c.low ?? c.l), close = Number(c.close ?? c.c);
        if (!open && !high && !low && !close) continue;
        bars.push({
          date: timeStr.slice(0, 10),
          time: timeStr.length === 16 ? timeStr + ":00" : timeStr,
          open, high, low, close, volume: Number(c.volume ?? c.v ?? 0),
        });
      }
      bars.sort((a, b) => a.time.localeCompare(b.time));
      writeFileSync(cachePath, JSON.stringify(bars));
      return bars;
    } catch (e: any) {
      console.warn(`  [5m] ${symbol} attempt ${attempt}: ${e?.message ?? e}`);
      await sleep(400 * attempt);
    }
  }
  return [];
}

async function fetchDaily(symbol: string): Promise<any[]> {
  const cachePath = `${CACHE_1D}/${symbol.toUpperCase()}.json`;
  if (existsSync(cachePath)) {
    try { return JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* refetch */ }
  }
  try {
    const d = await getHistoricalCandles(symbol, "1d", 210);
    const mapped = d.map((x: any) => ({
      time: typeof x.time === "number" ? x.time : Date.parse(String(x.time).replace(" ", "T")),
      open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0,
    })).filter((x) => Number.isFinite(x.time));
    writeFileSync(cachePath, JSON.stringify(mapped));
    return mapped;
  } catch { return []; }
}

function engBarsUpTo(bars: Bar5[], date: string, decisionMin: number) {
  const dayBars = bars.filter((b) => b.date === date);
  const out: any[] = [];
  for (const b of dayBars) {
    const [hh, mm] = b.time.slice(11, 16).split(":").map(Number);
    const mins = hh * 60 + mm;
    if (mins > decisionMin) break;
    const [Y, M, D] = date.split("-").map(Number);
    out.push({
      time: Date.UTC(Y, M - 1, D, hh - 5, mm - 30),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    });
  }
  return out;
}

function sessionClose(bars: Bar5[], date: string): number | null {
  const day = bars.filter((b) => b.date === date);
  return day.length ? day[day.length - 1].close : null;
}

function decisionClose(bars: Bar5[], date: string, decisionMin: number): number | null {
  const day = bars.filter((b) => b.date === date);
  for (const b of day) {
    const [hh, mm] = b.time.slice(11, 16).split(":").map(Number);
    if (hh * 60 + mm >= decisionMin) return b.close;
  }
  return null;
}

function prevDayLevels(daily: any[], date: string) {
  const epoch = Date.parse(date + "T00:00:00+05:30");
  const prior = daily.filter((d) => d.time < epoch);
  if (!prior.length) return null;
  const prev = prior[prior.length - 1];
  const week = prior.slice(-6, -1);
  return {
    ph: prev.high, pl: prev.low,
    pwh: week.length ? Math.max(...week.map((c: any) => c.high)) : prev.high,
    pwl: week.length ? Math.min(...week.map((c: any) => c.low)) : prev.low,
  };
}

/** Prior-session engine fires under a match mode. */
function replayHistory(
  bars: Bar5[],
  daily: any[],
  sig: Signal,
  priorDates: string[],
  mode: "dir" | "family" | "exact",
): HistStat {
  const decisionMin = parseMin(sig.time);
  const fam = setupFamily(sig.setup);
  let fires = 0, wins = 0;
  for (const d of priorDates) {
    try {
      const eng = engBarsUpTo(bars, d, decisionMin);
      if (eng.length < 40) continue;
      const lv = prevDayLevels(daily, d);
      if (!lv) continue;
      const a = analyzeEquityCash(sig.symbol, eng, lv.ph, lv.pl, lv.pwh, lv.pwl);
      if (a.finalDecision !== sig.dir) continue;
      const plan = sig.dir === "LONG" ? a.bestLong : a.bestShort;
      const setup = plan?.setup || "";
      const score = plan?.signalScore.total ?? 0;
      if (score < 70) continue;
      if (mode === "exact" && setup !== sig.setup) continue;
      if (mode === "family" && setupFamily(setup) !== fam) continue;
      fires++;
      const entryPx = decisionClose(bars, d, decisionMin);
      const exitPx = sessionClose(bars, d);
      if (entryPx == null || exitPx == null) continue;
      const won = sig.dir === "LONG" ? exitPx >= entryPx : exitPx <= entryPx;
      if (won) wins++;
    } catch { /* skip slice */ }
  }
  return { fires, wins, wr: fires ? wins / fires : 0 };
}

/** Deterministic mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Time-Machine Monte Carlo: bar-ratio pool from prior sessions (same time-of-day ±2),
 * stop before target. Brackets: risk = 1% of entry, target = 2R (2%).
 * Returns { pTarget, pStop, pNeither, avgR }.
 */
function monteCarlo(
  bars: Bar5[],
  priorDates: string[],
  entry: number,
  dir: Dir,
  decisionMin: number,
): { pTarget: number; pStop: number; pNeither: number; avgR: number; n: number } | null {
  // Build pool: for each slot (minutes from 9:15), ratios vs prev bar close
  // Slot = floor((min - 555) / 5) for 5m bars after 09:15
  const slotOf = (time: string) => {
    const [hh, mm] = time.slice(11, 16).split(":").map(Number);
    return Math.floor((hh * 60 + mm - (9 * 60 + 15)) / 5);
  };
  const SESSION_SLOTS = Math.ceil((15 * 60 + 30 - (9 * 60 + 15)) / 5); // ~75
  const pool: Array<Array<[number, number, number, number]>> = Array.from({ length: SESSION_SLOTS }, () => []);

  for (const d of priorDates) {
    const day = bars.filter((b) => b.date === d);
    for (let i = 1; i < day.length; i++) {
      const prev = day[i - 1];
      const cur = day[i];
      if (!prev.close) continue;
      const s = slotOf(cur.time);
      if (s < 0 || s >= SESSION_SLOTS) continue;
      pool[s].push([cur.open / prev.close, cur.high / prev.close, cur.low / prev.close, cur.close / prev.close]);
    }
  }
  const nonEmpty = pool.filter((p) => p.length > 0).length;
  if (nonEmpty < 20) return null;

  const risk = entry * 0.01; // 1% risk
  const stop = dir === "LONG" ? entry - risk : entry + risk;
  const target = dir === "LONG" ? entry + 2 * risk : entry - 2 * risk;
  const entrySlot = Math.floor((decisionMin - (9 * 60 + 15)) / 5);
  const lastSlot = SESSION_SLOTS - 1;

  const rand = rng(MC_SEED);
  let hitT = 0, hitS = 0, neither = 0, rSum = 0;
  const window = 2;

  for (let n = 0; n < MC_REPLAYS; n++) {
    let p = entry;
    let outcome: "T" | "S" | null = null;
    for (let s = entrySlot + 1; s <= lastSlot; s++) {
      // pick slot j = s + U(-window, window)
      let j = s + Math.floor(rand() * (2 * window + 1)) - window;
      j = Math.max(0, Math.min(SESSION_SLOTS - 1, j));
      const bucket = pool[j];
      if (!bucket.length) continue;
      const bar = bucket[Math.floor(rand() * bucket.length)];
      const hi = p * bar[1], lo = p * bar[2], cl = p * bar[3];
      if (outcome === null) {
        if (dir === "LONG") {
          if (lo <= stop) outcome = "S";
          else if (hi >= target) outcome = "T";
        } else {
          if (hi >= stop) outcome = "S";
          else if (lo <= target) outcome = "T";
        }
      }
      p = cl;
    }
    if (outcome === "T") { hitT++; rSum += 2; }
    else if (outcome === "S") { hitS++; rSum += -1; }
    else {
      neither++;
      rSum += dir === "LONG" ? (p - entry) / risk : (entry - p) / risk;
    }
  }
  return {
    pTarget: hitT / MC_REPLAYS,
    pStop: hitS / MC_REPLAYS,
    pNeither: neither / MC_REPLAYS,
    avgR: rSum / MC_REPLAYS,
    n: MC_REPLAYS,
  };
}

function acc(rows: Array<{ fwdSignedPct: number }>) {
  const n = rows.length;
  const w = rows.filter((r) => r.fwdSignedPct > 0).length;
  const avg = n ? rows.reduce((s, r) => s + r.fwdSignedPct, 0) / n : 0;
  return { n, w, acc: n ? (100 * w) / n : 0, avg };
}

function show(label: string, rows: Array<{ fwdSignedPct: number }>) {
  const s = acc(rows);
  console.log(
    `${label.padEnd(58)} n=${String(s.n).padStart(4)}  acc=${s.acc.toFixed(1).padStart(5)}%  avg=${s.avg.toFixed(3)}%`
  );
}

async function main() {
  const csv = readFileSync("data/scanner-gate-backtest-p0.csv", "utf8");
  const signals = loadSignals(csv);
  console.log(`signals: ${signals.length}`);

  const symbols = [...new Set(signals.map((s) => s.symbol))];
  console.log(`symbols: ${symbols.length} — loading/fetching Breeze 5m + daily (cached)…`);

  const barsBySym = new Map<string, Bar5[]>();
  const dailyBySym = new Map<string, any[]>();
  let i = 0;
  for (const sym of symbols) {
    const bars = await fetch5mRange(sym);
    barsBySym.set(sym, bars);
    const daily = await fetchDaily(sym);
    dailyBySym.set(sym, daily);
    i++;
    if (i % 8 === 0 || i === symbols.length) console.log(`  ${i}/${symbols.length} done (last ${sym}: ${bars.length}×5m)`);
    await sleep(80);
  }

  const datesBySym = new Map<string, string[]>();
  for (const [sym, bars] of barsBySym) {
    datesBySym.set(sym, [...new Set(bars.map((b) => b.date))].sort());
  }

  type Row = Signal & {
    histDirN: number; histDirWR: number;
    histFamN: number; histFamWR: number;
    histExN: number; histExWR: number;
    mcPct: number; mcPs: number; mcPn: number; mcAvgR: number;
  };

  console.log("Replaying engine + Monte Carlo…");
  const enriched: Row[] = [];
  let ri = 0;
  for (const sig of signals) {
    const bars = barsBySym.get(sig.symbol) ?? [];
    const daily = dailyBySym.get(sig.symbol) ?? [];
    const allDates = datesBySym.get(sig.symbol) ?? [];
    const prior = allDates.filter((d) => d < sig.day).slice(-20);

    const hd = bars.length && daily.length ? replayHistory(bars, daily, sig, prior, "dir") : { fires: 0, wins: 0, wr: 0 };
    const hf = bars.length && daily.length ? replayHistory(bars, daily, sig, prior, "family") : { fires: 0, wins: 0, wr: 0 };
    const he = bars.length && daily.length ? replayHistory(bars, daily, sig, prior, "exact") : { fires: 0, wins: 0, wr: 0 };
    const mc = bars.length && prior.length
      ? monteCarlo(bars, prior, sig.entry, sig.dir, parseMin(sig.time))
      : null;

    enriched.push({
      ...sig,
      histDirN: hd.fires, histDirWR: Math.round(hd.wr * 1000) / 1000,
      histFamN: hf.fires, histFamWR: Math.round(hf.wr * 1000) / 1000,
      histExN: he.fires, histExWR: Math.round(he.wr * 1000) / 1000,
      mcPct: mc ? Math.round(mc.pTarget * 1000) / 1000 : -1,
      mcPs: mc ? Math.round(mc.pStop * 1000) / 1000 : -1,
      mcPn: mc ? Math.round(mc.pNeither * 1000) / 1000 : -1,
      mcAvgR: mc ? Math.round(mc.avgR * 1000) / 1000 : 0,
    });
    ri++;
    if (ri % 100 === 0) console.log(`  ${ri}/${signals.length}`);
  }

  const base = enriched;
  console.log("\n" + "=".repeat(78));
  console.log("HISTORY-REPLAY + TIME-MACHINE GATE (Breeze 5m, production engine)");
  console.log(`hist pass: N≥${MIN_HIST_N} AND WR≥${WR_PASS} | MC: ${MC_REPLAYS} replays, 1% stop / 2R target`);
  console.log("=".repeat(78));

  show("G0 base", base);
  show("hist_dir pass", base.filter((r) => r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS));
  show("hist_family pass", base.filter((r) => r.histFamN >= MIN_HIST_N && r.histFamWR >= WR_PASS));
  show("hist_exact pass", base.filter((r) => r.histExN >= MIN_HIST_N && r.histExWR >= WR_PASS));
  show("MC lean target (pT>pS)", base.filter((r) => r.mcPct > r.mcPs && r.mcPct >= 0));
  show("MC strong (pT-pS ≥ 0.10)", base.filter((r) => r.mcPct - r.mcPs >= 0.1 && r.mcPct >= 0));
  show("MC avgR > 0", base.filter((r) => r.mcAvgR > 0));

  console.log("\nLadders:");
  const ladders: Array<[string, string, (r: Row) => boolean]> = [
    ["H0", "base", () => true],
    ["H1", "+ hist_dir (N≥5,WR≥55)", (r) => r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS],
    ["H2", "+ hist_family", (r) => r.histFamN >= MIN_HIST_N && r.histFamWR >= WR_PASS],
    ["H3", "+ LONG + hist_family", (r) => r.dir === "LONG" && r.histFamN >= MIN_HIST_N && r.histFamWR >= WR_PASS],
    ["H4", "+ MC lean target", (r) => r.mcPct > r.mcPs && r.mcPct >= 0],
    ["H5", "+ MC strong ≥10pp", (r) => r.mcPct - r.mcPs >= 0.1 && r.mcPct >= 0],
    ["H6", "+ LONG + MC strong", (r) => r.dir === "LONG" && r.mcPct - r.mcPs >= 0.1 && r.mcPct >= 0],
    ["H7", "+ hist_family + MC lean", (r) => r.histFamN >= MIN_HIST_N && r.histFamWR >= WR_PASS && r.mcPct > r.mcPs],
    ["H8", "+ LONG + hist_family + MC lean", (r) => r.dir === "LONG" && r.histFamN >= MIN_HIST_N && r.histFamWR >= WR_PASS && r.mcPct > r.mcPs],
    ["H9", "+ LONG + hist_dir + MC lean", (r) => r.dir === "LONG" && r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS && r.mcPct > r.mcPs],
    ["H10", "+ LONG + hist_dir + MC strong", (r) => r.dir === "LONG" && r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS && r.mcPct - r.mcPs >= 0.1],
    ["H11", "+ hist_dir + MC strong + VWAP", (r) => r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS && r.mcPct - r.mcPs >= 0.1 && r.gVwap],
    ["H12", "+ LONG + hist_dir + MC strong + VWAP", (r) => r.dir === "LONG" && r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS && r.mcPct - r.mcPs >= 0.1 && r.gVwap],
  ];

  console.log("Gate  Description                              n     win%    vs 70%");
  console.log("-".repeat(78));
  for (const [g, label, fn] of ladders) {
    const sub = base.filter(fn);
    const s = acc(sub);
    const delta = s.acc - 70;
    console.log(
      `${g}     ${label.padEnd(40)} ${String(s.n).padStart(4)}  ${s.acc.toFixed(1).padStart(5)}%   ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp`
    );
  }

  console.log("\nhist_dir quality buckets:");
  show("hist_dir N=0", base.filter((r) => r.histDirN === 0));
  show("hist_dir N 1–4", base.filter((r) => r.histDirN >= 1 && r.histDirN < 4));
  show("hist_dir N≥5 WR<50", base.filter((r) => r.histDirN >= 5 && r.histDirWR < 0.5));
  show("hist_dir N≥5 WR 50–59", base.filter((r) => r.histDirN >= 5 && r.histDirWR >= 0.5 && r.histDirWR < 0.6));
  show("hist_dir N≥5 WR≥60", base.filter((r) => r.histDirN >= 5 && r.histDirWR >= 0.6));

  console.log("\nMC pTarget−pStop buckets:");
  show("MC missing", base.filter((r) => r.mcPct < 0));
  show("MC lean stop (pT<pS)", base.filter((r) => r.mcPct >= 0 && r.mcPct < r.mcPs));
  show("MC flat (±5pp)", base.filter((r) => r.mcPct >= 0 && Math.abs(r.mcPct - r.mcPs) < 0.05));
  show("MC lean target 5–10pp", base.filter((r) => r.mcPct - r.mcPs >= 0.05 && r.mcPct - r.mcPs < 0.1));
  show("MC strong ≥10pp", base.filter((r) => r.mcPct - r.mcPs >= 0.1));

  // Detail for the best non-empty ladder with n≥10
  const detailKeys: Array<[string, (r: Row) => boolean]> = [
    ["H1 hist_dir", (r) => r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS],
    ["H5 MC strong", (r) => r.mcPct - r.mcPs >= 0.1 && r.mcPct >= 0],
    ["H9 LONG+hist_dir+MC lean", (r) => r.dir === "LONG" && r.histDirN >= MIN_HIST_N && r.histDirWR >= WR_PASS && r.mcPct > r.mcPs],
  ];
  for (const [name, fn] of detailKeys) {
    const picks = base.filter(fn);
    if (picks.length < 3) continue;
    console.log(`\n${name} picks (n=${picks.length}):`);
    for (const p of picks.sort((a, b) => b.fwdSignedPct - a.fwdSignedPct).slice(0, 20)) {
      console.log(
        `  ${p.day} ${p.time} ${p.symbol.padEnd(12)} ${p.dir} eng=${p.engineScore} ` +
        `histDir=${p.histDirWR}(n=${p.histDirN}) mc=${(p.mcPct * 100).toFixed(0)}/${(p.mcPs * 100).toFixed(0)}% ` +
        `fwd=${p.fwdSignedPct > 0 ? "+" : ""}${p.fwdSignedPct}% ${p.fwdSignedPct > 0 ? "WIN" : "LOSS"} ${p.setup}`
      );
    }
  }

  const header = "day,time,symbol,dir,entry,close,fwdSignedPct,engineScore,setup,rvol,adx,histDirN,histDirWR,histFamN,histFamWR,histExN,histExWR,mcPct,mcPs,mcPn,mcAvgR,gEma,gRs,gRegime,gVwap\n";
  const out = header + enriched.map((r) =>
    [r.day, r.time, r.symbol, r.dir, r.entry, r.close, r.fwdSignedPct, r.engineScore,
     `"${r.setup}"`, r.rvol, r.adx,
     r.histDirN, r.histDirWR, r.histFamN, r.histFamWR, r.histExN, r.histExWR,
     r.mcPct, r.mcPs, r.mcPn, r.mcAvgR,
     r.gEma, r.gRs, r.gRegime, r.gVwap].join(",")
  ).join("\n");
  writeFileSync("data/history-replay-gate.csv", out);
  console.log(`\nCSV → data/history-replay-gate.csv  (${enriched.length} rows)`);

  const noDir = base.filter((r) => r.histDirN === 0).length;
  const noMc = base.filter((r) => r.mcPct < 0).length;
  console.log(`Coverage: hist_dir fires on ${base.length - noDir}/${base.length}; MC available for ${base.length - noMc}/${base.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
