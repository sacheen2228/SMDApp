// gate-replay-backtest.ts
// GRADE 1 validation: replay the NEW deterministic brain (evaluate_trade_gate + its
// indicator/chain layers) over REAL closed trades recorded in the trade-audit ledger.
// Every input is either a recorded field or recomputed from real historical data
// (Breeze daily candles, NSE/BSE bhavcopy OI, Black-Scholes from the recorded premium).
// Nothing is invented: trades whose inputs cannot be reconstructed are excluded as
// NO_DATA and reported under coverage, never counted as blocked.

import * as G from "./agent-brain-gate";
import { analyzeTf, structureLayer, triggerLayer, suggestLevels, DEFAULT_PARAMS, type Candle } from "./indicators";
import { analyze, layerForDirection, type NormChain, type Row } from "./option-chain-reader";
import { impliedVolFromPremium, calculateGreeks, parseExpiryToYears } from "./greeks";

const INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

export interface ReplayTrade {
  id: string;
  symbol: string;
  createdAtIst: string;
  optionType?: string;     // "CE" | "PE"
  strikePrice?: number;
  spotPrice?: number;
  entryPrice: number;
  stopLoss: number;
  tp1?: number;
  signalConfidence?: number;
  trendDirection?: string;
  expiry?: string;         // recorded expiry (YYYY-MM-DD)
  netPnl?: number;
  status: string;
  exitTime?: string;
  quantity?: number;
  strategyId?: string;
}

export interface BhavcopyRow {
  strike: number;
  optionType: string;
  expiry: string;
  close: number;
  underlying: number | null;
  lotSize: number;
  volume: number;
  oi: number;
}

export interface ReplayDeps {
  /** Daily candles for the symbol closed before `toMs` (production: Breeze native 1day). */
  daily: (symbol: string, fromMs: number, toMs: number) => Promise<Candle[]>;
  /** Bhavcopy OI rows for the trade date + previous trading day (same expiry window). */
  chainPair: (dateStr: string, symbol: string) => Promise<{ today: BhavcopyRow[]; prev: BhavcopyRow[] } | null>;
  /** Contract lot size on that date (bhavcopy NewBrdLotQty). */
  lotSize: (symbol: string, dateStr: string) => Promise<number | null>;
}

/**
 * Production-parity sizing for the replay.
 *
 * The replay MUST size trades exactly the way production does, otherwise its
 * verdicts are measured against a lot count that never happened. Production
 * calls positionSize() (src/lib/agent-brain-gate.ts) with the account capital
 * and the model's default risk %, which resolves to the PER-TRADE model:
 *
 *   deployed budget = min(₹20,000 per-trade cap, account capital ₹25,000)
 *   risk budget     = 20% of that deployed budget  (₹4,000)
 *   lots            = min( floor(riskBudget / riskPerLot),
 *                         floor(deployedBudget / (premium × lotSize)) )
 *
 * The second term is the AFFORDABILITY cap: a ₹350-premium NIFTY option at
 * 75 qty costs ₹26,250 per lot — more than the ₹20,000 per-trade budget — so
 * production correctly books 0 lots there.
 */
export function productionLots(entry: number, sl: number, lotSize: number): number {
  return G.positionSize({
    entry,
    sl,
    lotSize,
    capital: G.GATE_CONFIG.capital,
    riskPct: G.GATE_CONFIG.defaultRiskPct,
  }).lots;
}

/** The formula, in one sentence — used by the report and asserted in tests. */
export function sizingFormula(): string {
  const c = G.GATE_CONFIG;
  const budget = Math.min(c.tradeBudget, c.capital);
  const risk = (budget * c.riskPctOfTrade) / 100;
  return `lots = min(floor(₹${Math.round(risk).toLocaleString("en-IN")} risk ÷ risk-per-lot), floor(₹${budget.toLocaleString("en-IN")} deployed ÷ (premium × lot size))) — risk = ${c.riskPctOfTrade}% of the amount DEPLOYED, max ₹${c.tradeBudget.toLocaleString("en-IN")} deployed per trade`;
}

export interface DeriveResult {
  input?: G.GateInput;
  exclude?: string;
}

/** Nearest Thursday on/after dateStr (weekly index expiry). YYYY-MM-DD in UTC. */
export function deriveWeeklyExpiry(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i <= 7; i++) {
    const x = new Date(d.getTime() + i * 86_400_000);
    if (x.getUTCDay() === 4) return x.toISOString().slice(0, 10);
  }
  return dateStr;
}

function dirOf(optionType?: string): "call" | "put" | undefined {
  const t = String(optionType || "").toUpperCase();
  if (t === "CE" || t === "CALL") return "call";
  if (t === "PE" || t === "PUT") return "put";
  return undefined;
}

/** Group bhavcopy rows for one expiry into a NormChain, with real day-over-day changes. */
function rowsToChain(rows: BhavcopyRow[], prev: BhavcopyRow[] | undefined, spot: number, symbol: string, expiry?: string): NormChain | null {
  const pick = (rs: BhavcopyRow[]) => rs.filter((r) => !expiry || String(r.expiry).slice(0, 10) === expiry);
  const byStrike = (rs: BhavcopyRow[]) => {
    const m = new Map<number, { ce?: BhavcopyRow; pe?: BhavcopyRow }>();
    for (const r of rs) {
      const e = m.get(Number(r.strike)) || {};
      if (String(r.optionType).toUpperCase() === "CE") e.ce = r;
      else e.pe = r;
      m.set(Number(r.strike), e);
    }
    return m;
  };
  const tm = byStrike(pick(rows));
  const pm = prev ? byStrike(pick(prev)) : new Map<number, { ce?: BhavcopyRow; pe?: BhavcopyRow }>();
  const leg = (r: BhavcopyRow | undefined, p: BhavcopyRow | undefined) => ({
    oi: r?.oi ?? 0,
    oiChange: p && r ? r.oi - p.oi : undefined,
    ltp: r?.close,
    ltpChange: p && r ? r.close - p.close : undefined,
    volume: r?.volume,
  });
  const chainRows: Row[] = [...tm.entries()]
    .map(([strike, v]) => ({
      strike,
      ce: leg(v.ce, pm.get(strike)?.ce),
      pe: leg(v.pe, pm.get(strike)?.pe),
    }))
    .filter((r) => Number.isFinite(r.strike))
    .sort((a, b) => a.strike - b.strike);
  if (!chainRows.length) return null;
  const cOI = chainRows.reduce((s, r) => s + r.ce.oi, 0);
  const pOI = chainRows.reduce((s, r) => s + r.pe.oi, 0);
  const und = pick(rows).find((r) => r.underlying)?.underlying;
  return {
    symbol, spot: spot || und || 0, rows: chainRows,
    pcr: cOI > 0 ? pOI / cOI : undefined, derivedChange: false,
    asOf: null,
  };
}

/**
 * Rebuild one historical trade as gate inputs. Returns exclude (no verdict) when a
 * mandatory input cannot be reconstructed from real data.
 */
export async function deriveGateInput(trade: ReplayTrade, deps: ReplayDeps): Promise<DeriveResult> {
  const dir = dirOf(trade.optionType);
  if (!dir) return { exclude: "not an option trade (no strike/optionType) — gate is options-only" };
  const strike = Number(trade.strikePrice);
  if (!Number.isFinite(strike) || strike <= 0) {
    return { exclude: "missing strike" };
  }
  const asOfMs = Date.parse(trade.createdAtIst);
  if (!Number.isFinite(asOfMs)) return { exclude: "unparseable createdAtIst" };
  const istDateStr = new Date(asOfMs + 5.5 * 3600_000).toISOString().slice(0, 10);

  // Expiry: recorded, else nearest Thursday for index weeklies, else no delta → exclude
  let expiry = trade.expiry ? String(trade.expiry).slice(0, 10) : undefined;
  if (!expiry && INDEX_SYMBOLS.has(trade.symbol)) expiry = deriveWeeklyExpiry(istDateStr);
  if (!expiry) return { exclude: "no expiry (recorded or derivable) — cannot compute delta" };

  const isExpiryDay = expiry === istDateStr;

  // Daily candles → structure/trigger/suggestLevels (the new brain's own reads, on 1d)
  const daily = await deps.daily(trade.symbol, asOfMs - 120 * 86_400_000, asOfMs);
  const read = analyzeTf("1d", daily, trade.symbol, DEFAULT_PARAMS, asOfMs);
  if (!read) return { exclude: "no/warmup-insufficient daily candles for that date" };

  // Real underlying spot: bhavcopy UndrlygPric, else last closed daily candle.
  // (The audit ledger's spotPrice column stores the OPTION premium, not the
  // underlying — never use it as spot.)
  const pair = await deps.chainPair(istDateStr, trade.symbol);
  if (!pair || !pair.today.length) return { exclude: "no bhavcopy rows for that date/symbol" };
  const und = pair.today.find((r) => r.underlying && r.underlying > 0)?.underlying;
  const lastClosed = [...daily].reverse().find((c) => c.t < asOfMs);
  const spot = Number(und) || Number(lastClosed?.c) || 0;
  if (!(spot > 0)) return { exclude: "no underlying spot (bhavcopy underlying + daily close both missing)" };

  // Delta: Black-Scholes solved from the RECORDED premium at entry (real math)
  const tYears = parseExpiryToYears(expiry, new Date(asOfMs));
  let delta: number | undefined;
  if (tYears != null && tYears > 0 && trade.entryPrice > 0) {
    const iv = impliedVolFromPremium(trade.entryPrice, spot, strike, tYears, dir === "call");
    if (iv != null) delta = calculateGreeks(spot, strike, tYears, iv, dir === "call").delta;
  }
  if (delta == null) return { exclude: "delta uncomputable (premium outside no-arb bounds or bad T)" };

  // Levels: real bhavcopy OI, day-over-day changes → production chain analysis
  const chain = rowsToChain(pair.today, pair.prev, spot, trade.symbol, expiry);
  if (!chain) return { exclude: "chain rows for this expiry missing in bhavcopy" };
  const analysis = analyze(chain, undefined, tYears != null ? Math.round(tYears * 365) : undefined);
  const levels = layerForDirection(analysis, dir);
  const structure = structureLayer(read, dir);
  const trigger = triggerLayer(read, dir);
  const lv = suggestLevels(read, read, dir);

  // Lots under production config — the SAME positionSize() call the agent
  // makes (per-trade deployment budget + 20% of the deployed amount at risk).
  const lot = (await deps.lotSize(trade.symbol, istDateStr)) || 75;
  const ps = G.positionSize({
    entry: Number(trade.entryPrice),
    sl: Number(trade.stopLoss),
    lotSize: lot,
    capital: G.GATE_CONFIG.capital,
    riskPct: G.GATE_CONFIG.defaultRiskPct,
  });

  const optionRR = trade.tp1 && trade.entryPrice > (trade.stopLoss as number)
    ? (Number(trade.tp1) - Number(trade.entryPrice)) / (Number(trade.entryPrice) - Number(trade.stopLoss))
    : undefined;

  const input: G.GateInput = {
    direction: dir,
    confidence: Number(trade.signalConfidence) || 0,
    asOfMs,
    stamps: [new Date(asOfMs - 2 * 60_000).toISOString()], // freshness assumed live at signal time (see assumptions)
    allLive: true,
    delta,
    strikeDistanceSteps: G.otmSteps(dir, strike, spot, trade.symbol),
    optionRR,
    underlyingRR: lv?.underlyingRR,        // the NEW brain's structural plan on 1d candles
    targetPts: lv?.targetPts,
    lots: ps.lots,
    isExpiryDay,
    eventNear: false,
    layers: { flow: { state: "unknown", evidence: "historical FII/DII flow not recorded per signal" }, structure, levels, greeksVix: { state: "unknown", evidence: "no historical VIX snapshot per signal" }, trigger },
    capital: G.GATE_CONFIG.capital,
    ledger: [],
  };
  return { input };
}

export interface ReplayOutcome {
  id: string;
  symbol: string;
  verdict: "TRADE" | "WAIT" | "SKIP" | "NO_DATA";
  failedChecks: string[];
  netPnl: number;
  result?: G.GateResult;
  exclude?: string;
}

export async function replayGate(trades: ReplayTrade[], deps: ReplayDeps): Promise<ReplayOutcome[]> {
  const ordered = [...trades].sort((a, b) => String(a.createdAtIst).localeCompare(String(b.createdAtIst)));
  const closedSoFar = ordered
    .filter((t) => t.status === "closed")
    .map((t) => ({ status: "closed", pnl: Number(t.netPnl) || 0, closedAt: t.exitTime, direction: t.optionType, confidence: t.signalConfidence }));
  const out: ReplayOutcome[] = [];
  for (const t of ordered) {
    const asOfMs = Date.parse(t.createdAtIst);
    const risk = G.journalRiskState(closedSoFar, Number.isFinite(asOfMs) ? asOfMs : undefined);
    const derived = await deriveGateInput(t, deps);
    if (!derived.input) {
      out.push({ id: t.id, symbol: t.symbol, verdict: "NO_DATA", failedChecks: [], netPnl: Number(t.netPnl) || 0, exclude: derived.exclude });
      continue;
    }
    const input: G.GateInput = {
      ...derived.input,
      ...risk,
      ledger: closedSoFar.map((c) => ({ ...c, regime: undefined, window: undefined, strikeDistance: undefined, confidence: c.confidence })),
    };
    const result = G.evaluateTradeGate(input);
    out.push({
      id: t.id, symbol: t.symbol, verdict: result.verdict,
      failedChecks: result.checks.filter((c) => c.status === "fail").map((c) => c.id),
      netPnl: Number(t.netPnl) || 0, result,
    });
  }
  return out;
}

export interface VerdictStats { n: number; wins: number; wr: number; netPnl: number; grossProfit: number; grossLoss: number; pf: number; expectancy: number }

export interface ReplaySummary {
  coverage: { total: number; replayed: number; excluded: number; excludeReasons: Record<string, number> };
  byVerdict: Record<string, VerdictStats>;
  failHistogram: Record<string, number>;
  assumptions: string[];
}

function statsFor(list: ReplayOutcome[]): VerdictStats {
  const n = list.length;
  const wins = list.filter((o) => o.netPnl > 0).length;
  const gp = list.filter((o) => o.netPnl > 0).reduce((s, o) => s + o.netPnl, 0);
  const gl = Math.abs(list.filter((o) => o.netPnl < 0).reduce((s, o) => s + o.netPnl, 0));
  const net = list.reduce((s, o) => s + o.netPnl, 0);
  return { n, wins, wr: n ? wins / n : 0, netPnl: net, grossProfit: gp, grossLoss: gl, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, expectancy: n ? net / n : 0 };
}

export function summarize(out: ReplayOutcome[]): ReplaySummary {
  const excluded = out.filter((o) => o.verdict === "NO_DATA");
  const replayed = out.filter((o) => o.verdict !== "NO_DATA");
  const byVerdict: Record<string, VerdictStats> = {};
  for (const v of ["TRADE", "WAIT", "SKIP"] as const) {
    const list = replayed.filter((o) => o.verdict === v);
    if (list.length) byVerdict[v] = statsFor(list);
  }
  const failHistogram: Record<string, number> = {};
  for (const o of replayed) for (const c of o.failedChecks) failHistogram[c] = (failHistogram[c] || 0) + 1;
  const excludeReasons: Record<string, number> = {};
  for (const o of excluded) {
    const key = (o.exclude || "unknown").replace(/\d+/g, "N").slice(0, 60);
    excludeReasons[key] = (excludeReasons[key] || 0) + 1;
  }
  return {
    coverage: { total: out.length, replayed: replayed.length, excluded: excluded.length, excludeReasons },
    byVerdict, failHistogram,
    assumptions: [
      "Feed freshness ASSUMED live at signal time (stamps = entry − 2 min) — historical feed state is unrecorded and untestable",
      "structure/trigger/suggestLevels layers recomputed from DAILY (1d) candles — intraday depth does not reach back that far",
      "levels layer = day-over-day OI change from NSE/BSE bhavcopy archives (same production analyze() as live)",
      "flow + greeksVix layers left UNKNOWN (no historical snapshot recorded per signal) — gate needs 3 of 5 from the other three",
      "delta = Black-Scholes IV solved from the recorded entry premium/spot/expiry (real math, r=7%)",
      "underlying R:R/targetPts = the NEW brain's own 1d structural levels (suggestLevels), not the original trade's plan",
      `lots computed with the SAME positionSize() call production makes — ${sizingFormula()}`,
      "equity/no-strike trades (BTST etc.) are OUT OF SCOPE — the gate is an options-premium gate",
    ],
  };
}

// ─── Production data loaders (real network) ─────────────────────────

const fmtBreezeDate = (ms: number) => {
  const d = new Date(ms + 5.5 * 3600_000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const BREEZE_1D_CODE: Record<string, { stock: string; exch: string }> = {
  NIFTY: { stock: "NIFTY", exch: "NSE" },
  BANKNIFTY: { stock: "CNXBAN", exch: "NSE" },
  FINNIFTY: { stock: "NIFFIN", exch: "NSE" },
  MIDCPNIFTY: { stock: "NIFMID", exch: "NSE" },
  SENSEX: { stock: "BSESEN", exch: "BSE" },
  BANKEX: { stock: "BSESEN", exch: "BSE" },
};

export function makeBreezeDailyLoader(): ReplayDeps["daily"] {
  return async (symbol, fromMs, toMs) => {
    try {
      const { initSession, getBreezeClient } = await import("./icici-breeze/auth");
      await initSession();
      const breeze = getBreezeClient();
      const code = BREEZE_1D_CODE[symbol];
      const res: any = await breeze.getHistoricalDatav2({
        interval: "1day",
        fromDate: fmtBreezeDate(fromMs),
        toDate: fmtBreezeDate(toMs),
        stockCode: code?.stock || symbol,
        exchangeCode: code?.exch || "NSE",
        productType: "cash",
      });
      const rows: any[] = res?.Success || res?.data || res || [];
      if (!Array.isArray(rows) || !rows.length) return [];
      return rows
        .map((r) => {
          const t = Date.parse(String(r.datetime).replace(" ", "T") + "+05:30");
          const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
          return Number.isFinite(t) && [o, h, l, c].every(Number.isFinite) ? { t, o, h, l, c, v: Number(r.volume) || 0 } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.t - b.t) as Candle[];
    } catch {
      return [];
    }
  };
}

export function makeBhavcopyPairLoader(): ReplayDeps["chainPair"] {
  return async (dateStr, symbol) => {
    try {
      const { loadBhavcopyForTrade } = await import("./option-bhavcopy");
      const today = await loadBhavcopyForTrade(dateStr, symbol);
      if (!today.length) return null;
      // walk back to the previous trading day with rows (max 5 calendar days)
      let prev: any[] = [];
      for (let i = 1; i <= 5 && !prev.length; i++) {
        const d = new Date(`${dateStr}T00:00:00Z`);
        const p = new Date(d.getTime() - i * 86_400_000).toISOString().slice(0, 10);
        try { prev = await loadBhavcopyForTrade(p, symbol); } catch { prev = []; }
      }
      const map = (rows: any[]) => rows.map((r) => ({
        strike: Number(r.strike), optionType: String(r.optionType), expiry: String(r.expiry).slice(0, 10),
        close: Number(r.close), underlying: r.underlying ?? null, lotSize: Number(r.lotSize) || 0,
        volume: Number(r.volume) || 0, oi: Number(r.oi) || 0,
      }));
      return { today: map(today), prev: map(prev) };
    } catch {
      return null;
    }
  };
}

export function makeLotSizeLoader(): ReplayDeps["lotSize"] {
  return async (symbol, dateStr) => {
    try {
      const { loadBhavcopyForTrade } = await import("./option-bhavcopy");
      const rows = await loadBhavcopyForTrade(dateStr, symbol);
      const lot = rows.find((r: any) => Number(r.lotSize) > 0)?.lotSize;
      return lot ? Number(lot) : null;
    } catch {
      return null;
    }
  };
}

export async function fetchClosedTrades(baseUrl = "http://localhost:4001"): Promise<ReplayTrade[]> {
  const all: ReplayTrade[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${baseUrl}/api/trades?status=closed&page=${page}&pageSize=100`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) break;
    const d: any = await res.json();
    const items: any[] = d.items || [];
    for (const t of items) {
      all.push({
        id: String(t.id), symbol: String(t.symbol || "").toUpperCase(), createdAtIst: String(t.createdAtIst || ""),
        optionType: t.optionType, strikePrice: t.strikePrice, spotPrice: t.spotPrice,
        entryPrice: Number(t.entryPrice), stopLoss: Number(t.stopLoss), tp1: t.tp1,
        signalConfidence: t.signalConfidence, trendDirection: t.trendDirection, expiry: t.expiry,
        netPnl: t.netPnl, status: String(t.status || ""), exitTime: t.exitTime, quantity: t.quantity, strategyId: t.strategyId,
      });
    }
    if (items.length < 100 || page * 100 >= (d.total || 0)) break;
  }
  return all;
}

export function defaultDeps(): ReplayDeps {
  return { daily: makeBreezeDailyLoader(), chainPair: makeBhavcopyPairLoader(), lotSize: makeLotSizeLoader() };
}

export async function runGateReplayReport(baseUrl = "http://localhost:4001"): Promise<{ summary: ReplaySummary; outcomes: ReplayOutcome[] }> {
  const trades = await fetchClosedTrades(baseUrl);
  const outcomes = await replayGate(trades, defaultDeps());
  return { summary: summarize(outcomes), outcomes };
}
