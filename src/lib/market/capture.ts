// Market Recorder capture core.
// Separates the testable store path (captureAndStore) from the live fetch glue
// (fetchRawMarketData), so the storage layer is verifiable without a Breeze session.
import { getOptionChain, getOptionChainExpiries, getQuotes } from "@/lib/icici-breeze/option-chain";
import { fetchIndiaVIX } from "@/lib/yahoo-finance-api";
import { getNSEGainers, getNSELosers, getNSEOptionChain } from "@/lib/nse-api";
import { getBSEOptionChain, getBSEExpiryDates } from "@/lib/bse-api";
import { calculateGreeks } from "@/lib/greeks";
import { fetchCandlesWithFallback, type CandleChainFailure } from "@/lib/market/candle-chain";
import { reportSessionRecovery, classifySourceError, getSessionHealth, type FailureKind } from "@/lib/session-health";
import { buildCanonicalSnapshot, type CanonicalMarketSnapshot, type OptionLeg, type Candle } from "@/lib/market/canonical";
import { recordSnapshot, recordCandles } from "@/lib/market-history-client";
import { getRecorderMode, getIntervalSeconds, RECORDER_SYMBOLS, type RecorderMode } from "@/lib/market/recorder-config";

export { RECORDER_SYMBOLS };

// Recorder runtime state (in-memory, per server process). Surfaced by the Status endpoint.
interface RecorderState {
  startTime: number;
  mode: RecorderMode;
  lastAutoCaptureAt: number;
  lastSuccess: { symbol: string; timestamp: string; mode: RecorderMode; interval: number } | null;
  lastFailure: { symbol: string; reason: string; time: string; kind?: FailureKind } | null;
  lastCandle: {
    symbol: string;
    source: string;
    interval: string;
    count: number;
    degraded: string | null;
    failures: CandleChainFailure[];
    at: string;
  } | null;
  totalCaptures: number;
  totalFailures: number;
}
// Process-wide singleton: each Next.js route is a separate module graph, so
// module-level state would be per-route (counters/status shown by the status
// route would never see writes from the record route). globalThis shares it.
const recorderState: RecorderState = ((globalThis as any).__SMD_RECORDER_STATE__ ??= {
  startTime: Date.now(),
  mode: getRecorderMode(),
  lastAutoCaptureAt: 0,
  lastSuccess: null,
  lastFailure: null,
  lastCandle: null,
  totalCaptures: 0,
  totalFailures: 0,
});
export function getRecorderRuntimeState(): RecorderState {
  recorderState.mode = getRecorderMode();
  return recorderState;
}

export interface RawMarketData {
  spot: number;
  futures?: number | null;
  chain: OptionLeg[];
  candles: Candle[];
  candleInterval?: string; // actual interval of `candles` (derived by the chain)
  indiaVix?: number | null;
  breadthAdv?: number;
  breadthDec?: number;
}

// Breeze getOptionChain returns { strikes: number[], calls: OptionQuote[], puts: OptionQuote[] }
// (flattened quote arrays, NOT {strike, ce, pe} rows) — map accordingly.
function mapBreezeChain(chain: { calls?: any[]; puts?: any[] }): OptionLeg[] {
  const legs: OptionLeg[] = [];
  const push = (q: any, type: "CE" | "PE") => {
    if (!q) return;
    legs.push({
      strike: q.strikePrice ?? 0,
      type,
      ltp: q.ltp ?? 0,
      oi: q.openInterest ?? 0,
      oiChg: q.oiChange ?? 0,
      iv: q.iv > 0 ? q.iv : null,
      greeks: { delta: q.delta ?? 0, theta: q.theta ?? 0, gamma: q.gamma ?? 0, vega: q.vega ?? 0 },
      volume: q.volume ?? 0,
    });
  };
  for (const q of chain.calls ?? []) push(q, "CE");
  for (const q of chain.puts ?? []) push(q, "PE");
  return legs;
}

// Expiry string → years to expiry (min 1 day; 7 days when unparsable).
// Handles NSE per-leg DD-MM-YYYY ("29-09-2026"), which new Date() rejects
// with an Invalid Date, plus month-name/ISO forms the other sources use.
function yearsToExpiry(expiry?: string): number {
  const fallback = 7 / 365;
  if (typeof expiry !== "string" || !expiry) return fallback;
  let exp: Date | null = null;
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(expiry);
  if (m) {
    exp = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 15, 30, 0, 0);
  } else {
    const d = new Date(expiry);
    if (!isNaN(d.getTime())) {
      d.setHours(15, 30, 0, 0);
      exp = d;
    }
  }
  if (!exp || isNaN(exp.getTime())) return fallback;
  return Math.max(
    (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365),
    1 / 365
  );
}
export { yearsToExpiry };

// NSE getNSEOptionChain returns { records: { data: [{ strikePrice, CE, PE }] } }.
// v3 rows carry impliedVolatility but NO greeks field — compute them from IV
// with Black-Scholes (same as the Breeze/BSE paths) so recorded history has
// real greeks instead of all-zero placeholders.
export function mapNSEChain(nse: any): OptionLeg[] {
  const rows = nse?.records?.data ?? [];
  const spot = Number(nse?.records?.underlyingValue) || 0;
  const legs: OptionLeg[] = [];
  for (const row of rows) {
    const push = (o: any, type: "CE" | "PE") => {
      if (!o) return;
      const iv = o.impliedVolatility > 0 ? o.impliedVolatility : null;
      let g = { delta: 0, theta: 0, gamma: 0, vega: 0 };
      if (o.greeks?.delta) {
        g = {
          delta: o.greeks.delta ?? 0,
          theta: o.greeks.theta ?? 0,
          gamma: o.greeks.gamma ?? 0,
          vega: o.greeks.vega ?? 0,
        };
      } else if (iv !== null && spot > 0 && row.strikePrice > 0) {
        try {
          const calc = calculateGreeks(
            spot,
            row.strikePrice,
            yearsToExpiry(o.expiryDate),
            iv / 100,
            type === "CE"
          );
          g = {
            delta: calc.delta ?? 0,
            theta: calc.theta ?? 0,
            gamma: calc.gamma ?? 0,
            vega: calc.vega ?? 0,
          };
        } catch {}
      }
      legs.push({
        strike: row.strikePrice ?? 0,
        type,
        ltp: o.lastPrice ?? 0,
        oi: o.openInterest ?? 0,
        oiChg: o.changeinOpenInterest ?? 0,
        iv,
        greeks: g,
        volume: o.totalTradedVolume ?? 0,
      });
    };
    push(row.CE, "CE");
    push(row.PE, "PE");
  }
  return legs;
}

// BSE getBSEOptionChain returns { data: [{ strike, ce, pe }] } — IV but no greeks.
// Compute greeks from IV with Black-Scholes (same as the Breeze path does).
function mapBSEChain(bse: { data: any[]; spotPrice: number }, expiry: string): OptionLeg[] {
  const legs: OptionLeg[] = [];
  const tte = yearsToExpiry(expiry);
  const spot = bse.spotPrice ?? 0;
  for (const row of bse.data ?? []) {
    const push = (o: any, type: "CE" | "PE") => {
      if (!o) return;
      let g = { delta: 0, theta: 0, gamma: 0, vega: 0 };
      if (o.iv > 0 && spot > 0 && row.strike > 0) {
        try {
          const calc = calculateGreeks(spot, row.strike, tte, o.iv / 100, type === "CE");
          g = { delta: calc.delta ?? 0, theta: calc.theta ?? 0, gamma: calc.gamma ?? 0, vega: calc.vega ?? 0 };
        } catch {}
      }
      legs.push({
        strike: row.strike ?? 0,
        type,
        ltp: o.ltp ?? 0,
        oi: o.oi ?? 0,
        oiChg: o.oiChg ?? 0,
        iv: o.iv > 0 ? o.iv : null,
        greeks: g,
        volume: o.volume ?? 0,
      });
    };
    push(row.ce, "CE");
    push(row.pe, "PE");
  }
  return legs;
}

// Live fetch glue — requires a Breeze/NSE session at runtime. Defensive: never throws.
export async function fetchRawMarketData(symbol: string): Promise<RawMarketData> {
  // Resolve nearest expiry first (mirrors live-data-engine / sdm-signal), then fetch chain.
  const expiries = (await getOptionChainExpiries(symbol).catch(() => [])) as string[];
  const nearestExpiry = expiries[0];

  const [chainRes, quotesRes, vixRes, gainersRes, losersRes] = await Promise.allSettled([
    getOptionChain(symbol, nearestExpiry),
    getQuotes(symbol),
    fetchIndiaVIX(),
    getNSEGainers(),
    getNSELosers(),
  ]);

  // Chain: Breeze first; fall back to NSE (Breeze session expires daily and the
  // recorder must keep recording through auth failures).
  const breezeChain = chainRes.status === "fulfilled" ? chainRes.value : null;
  let legs = breezeChain ? mapBreezeChain(breezeChain) : [];
  let spot = breezeChain?.spotPrice ?? 0;
  let chainSource: "breeze" | "nse" | "bse" | "none" = breezeChain ? "breeze" : "none";
  if (breezeChain) reportSessionRecovery("breeze");

  if (!legs.length) {
    const nseChain = await getNSEOptionChain(symbol).catch(() => null);
    legs = mapNSEChain(nseChain);
    spot = nseChain?.records?.underlyingValue ?? spot;
    if (legs.length) chainSource = "nse";
  }

  // SENSEX/BANKEX are BSE symbols — NSE has no chain for them.
  if (!legs.length) {
    const expiries = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
    const bseChain = expiries[0]
      ? await getBSEOptionChain(symbol, expiries[0]).catch(() => null)
      : null;
    if (bseChain?.data?.length) {
      legs = mapBSEChain(bseChain, expiries[0]);
      spot = bseChain.spotPrice || spot;
      chainSource = "bse";
    }
  }

  if (!legs.length) {
    throw new Error(`option chain unavailable for ${symbol} (chain sources exhausted)`);
  }
  if (chainSource === "nse") reportSessionRecovery("nse");

  if (quotesRes.status === "fulfilled" && quotesRes.value) {
    spot = quotesRes.value.last_price ?? quotesRes.value.ltp ?? spot;
  }

  // Candles: multi-source chain (Breeze → MO → NSE index-only). Never throws;
  // failures are classified into session-health (single alert owner) + lastCandle.
  const candleResult = await fetchCandlesWithFallback(
    symbol,
    new Date().toISOString().slice(0, 10),
    "1minute"
  );
  recorderState.lastCandle = {
    symbol,
    source: candleResult.source,
    interval: candleResult.intervalLabel,
    count: candleResult.candles.length,
    degraded: candleResult.degraded,
    failures: candleResult.failures,
    at: new Date().toISOString(),
  };
  const candles: Candle[] = candleResult.candles;
  const candleInterval = candleResult.intervalLabel;
  const indiaVix = vixRes.status === "fulfilled" ? vixRes.value?.value ?? null : null;
  const breadthAdv = gainersRes.status === "fulfilled" ? gainersRes.value.length : undefined;
  const breadthDec = losersRes.status === "fulfilled" ? losersRes.value.length : undefined;

  return { spot, futures: null, chain: legs, candles, candleInterval, indiaVix, breadthAdv, breadthDec };
}

// Testable store path — no network. Builds the canonical snapshot and persists it.
// `bucketMs` aligns the capture timestamp to a deterministic bucket (per the active
// interval) so that duplicate scheduler ticks map to the SAME (symbol, timestamp) key
// and are ignored by the UNIQUE index — making recording idempotent.
export async function captureAndStore(symbol: string, raw: RawMarketData, bucketMs = 60000): Promise<{ snapshot: CanonicalMarketSnapshot; inserted: boolean }> {
  const bucketed = Math.floor(Date.now() / bucketMs) * bucketMs;
  const snap = buildCanonicalSnapshot({
    symbol,
    timestamp: new Date(bucketed).toISOString(),
    spot: raw.spot,
    futures: raw.futures ?? null,
    indiaVix: raw.indiaVix ?? null,
    breadthAdv: raw.breadthAdv,
    breadthDec: raw.breadthDec,
    optionChain: raw.chain,
    candles: raw.candles,
  });
  const inserted = await recordSnapshot(snap);
  if (inserted && raw.candles.length) {
    await recordCandles(symbol, raw.candleInterval || "1minute", raw.candles);
  }
  return { snapshot: snap, inserted };
}

export async function recordSymbol(symbol: string, opts?: { mode?: RecorderMode; interval?: number }): Promise<{ symbol: string; status: "ok" | "error"; inserted?: boolean; reason?: string; kind?: FailureKind }> {
  try {
    const raw = await fetchRawMarketData(symbol);
    const interval = opts?.interval ?? 60000;
    const { inserted } = await captureAndStore(symbol, raw, interval);
    recorderState.lastSuccess = { symbol, timestamp: new Date(Math.floor(Date.now() / interval) * interval).toISOString(), mode: opts?.mode ?? getRecorderMode(), interval: interval / 1000 };
    recorderState.totalCaptures++;
    return { symbol, status: "ok", inserted };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    // Classify for status/evidence surfaces: an active source session-expiry
    // (from session-health, single owner) wins over generic classification.
    const health = getSessionHealth();
    const expired = (["breeze", "mo", "nse"] as const).find((s) => health[s].kind === "SESSION_EXPIRED");
    const kind: FailureKind = expired ? "SESSION_EXPIRED" : classifySourceError("breeze", reason);
    recorderState.lastFailure = { symbol, reason, time: new Date().toISOString(), kind };
    recorderState.totalFailures++;
    return { symbol, status: "error", reason, kind };
  }
}

export interface RecordAllOptions {
  auto?: boolean; // invoked by scheduler (mode/throttle applies)
  force?: boolean; // bypass mode + throttle (manual POST)
}
export async function recordAll(
  symbols: string[] = RECORDER_SYMBOLS,
  opts: RecordAllOptions = {},
): Promise<{ recorded: number; skipped?: boolean; reason?: string; nextIn?: number; results: { symbol: string; status: string; inserted?: boolean; reason?: string }[] }> {
  const mode = getRecorderMode();
  if (opts.auto && !opts.force) {
    if (mode === "MANUAL") return { recorded: 0, skipped: true, reason: "MANUAL mode — auto capture disabled", results: [] };
    const intervalMs = getIntervalSeconds(mode) * 1000;
    const elapsed = Date.now() - recorderState.lastAutoCaptureAt;
    if (elapsed < intervalMs - 1000) {
      return { recorded: 0, skipped: true, reason: `throttled — interval ${intervalMs / 1000}s not elapsed`, nextIn: Math.ceil((intervalMs - elapsed) / 1000), results: [] };
    }
    recorderState.lastAutoCaptureAt = Date.now();
    const results = await Promise.all(symbols.map((s) => recordSymbol(s, { mode, interval: intervalMs })));
    return { recorded: results.filter((r) => r.status === "ok").length, results };
  }
  // Manual / forced — 1-minute bucket, always captures.
  const results = await Promise.all(symbols.map((s) => recordSymbol(s, { mode, interval: 60000 })));
  return { recorded: results.filter((r) => r.status === "ok").length, results };
}
