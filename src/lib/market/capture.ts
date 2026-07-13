// Market Recorder capture core.
// Separates the testable store path (captureAndStore) from the live fetch glue
// (fetchRawMarketData), so the storage layer is verifiable without a Breeze session.
import { getOptionChain, getOptionChainExpiries, getQuotes } from "@/lib/icici-breeze/option-chain";
import { fetchIndiaVIX } from "@/lib/yahoo-finance-api";
import { getNSEGainers, getNSELosers } from "@/lib/nse-api";
import { getIntradayCandles } from "@/lib/breeze-historical";
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
  lastFailure: { symbol: string; reason: string; time: string } | null;
  totalCaptures: number;
  totalFailures: number;
}
const recorderState: RecorderState = {
  startTime: Date.now(),
  mode: getRecorderMode(),
  lastAutoCaptureAt: 0,
  lastSuccess: null,
  lastFailure: null,
  totalCaptures: 0,
  totalFailures: 0,
};
export function getRecorderRuntimeState(): RecorderState {
  recorderState.mode = getRecorderMode();
  return recorderState;
}

export interface RawMarketData {
  spot: number;
  futures?: number | null;
  chain: OptionLeg[];
  candles: Candle[];
  indiaVix?: number | null;
  breadthAdv?: number;
  breadthDec?: number;
}

function mapChain(strikes: any[]): OptionLeg[] {
  const legs: OptionLeg[] = [];
  for (const s of strikes ?? []) {
    const push = (leg: any, type: "CE" | "PE") => {
      if (!leg) return;
      legs.push({
        strike: s.strike,
        type,
        ltp: leg.ltp ?? 0,
        oi: leg.oi ?? 0,
        oiChg: leg.oiChg ?? 0,
        iv: leg.iv ?? null,
        greeks: { delta: leg.delta ?? 0, theta: leg.theta ?? 0, gamma: leg.gamma ?? 0, vega: leg.vega ?? 0 },
        volume: leg.volume ?? 0,
      });
    };
    push(s.ce, "CE");
    push(s.pe, "PE");
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

  if (chainRes.status !== "fulfilled" || !chainRes.value) {
    throw new Error(`option chain unavailable for ${symbol}`);
  }
  const chain = chainRes.value;
  const legs = mapChain(chain.strikes);
  const spot =
    quotesRes.status === "fulfilled" && quotesRes.value
      ? quotesRes.value.last_price ?? quotesRes.value.ltp ?? chain.spotPrice
      : chain.spotPrice;

  const hist = await getIntradayCandles(symbol, new Date().toISOString().slice(0, 10), "1minute").catch(() => ({ candles: [] as any[] }));
  const candles: Candle[] = (hist.candles ?? []).map((c) => ({
    timestamp: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  const indiaVix = vixRes.status === "fulfilled" ? vixRes.value?.value ?? null : null;
  const breadthAdv = gainersRes.status === "fulfilled" ? gainersRes.value.length : undefined;
  const breadthDec = losersRes.status === "fulfilled" ? losersRes.value.length : undefined;

  return { spot, futures: null, chain: legs, candles, indiaVix, breadthAdv, breadthDec };
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
  if (inserted && raw.candles.length) await recordCandles(symbol, "1minute", raw.candles);
  return { snapshot: snap, inserted };
}

export async function recordSymbol(symbol: string, opts?: { mode?: RecorderMode; interval?: number }): Promise<{ symbol: string; status: "ok" | "error"; inserted?: boolean; reason?: string }> {
  try {
    const raw = await fetchRawMarketData(symbol);
    const interval = opts?.interval ?? 60000;
    const { inserted } = await captureAndStore(symbol, raw, interval);
    recorderState.lastSuccess = { symbol, timestamp: new Date(Math.floor(Date.now() / interval) * interval).toISOString(), mode: opts?.mode ?? getRecorderMode(), interval: interval / 1000 };
    recorderState.totalCaptures++;
    return { symbol, status: "ok", inserted };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    recorderState.lastFailure = { symbol, reason, time: new Date().toISOString() };
    recorderState.totalFailures++;
    return { symbol, status: "error", reason };
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
