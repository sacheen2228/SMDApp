// Market Recorder capture core.
// Separates the testable store path (captureAndStore) from the live fetch glue
// (fetchRawMarketData), so the storage layer is verifiable without a Breeze session.
import { getQuotes } from "@/lib/icici-breeze/option-chain";
import { runOptionChainRace } from "@/lib/market-data-race";
import { getNSEIndiaVIX } from "@/lib/nse-api";
import { getNSEGainers, getNSELosers } from "@/lib/nse-api";
import { calculateGreeks } from "@/lib/greeks";
import { fetchCandlesWithFallback, normalizeInterval, type CandleChainFailure } from "@/lib/market/candle-chain";
import { reportSessionRecovery, classifySourceError, getSessionHealth, type FailureKind } from "@/lib/session-health";
import { buildCanonicalSnapshot, type CanonicalMarketSnapshot, type OptionLeg, type Candle } from "@/lib/market/canonical";
import { classifyFreshness } from "@/lib/api-freshness";
import { recordSnapshot, recordCandles } from "@/lib/market-history-client";
import { getRecorderMode, getIntervalSeconds, RECORDER_SYMBOLS, type RecorderMode } from "@/lib/market/recorder-config";

// Re-exported here so quant/premarket modules can normalize intervals without
// importing the chain itself (import scan: only this module may touch it).
export { RECORDER_SYMBOLS, normalizeInterval };

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
  /** The PROVIDER's own chain/quote time. null when the provider publishes none. */
  providerTimestamp?: string | null;
  /** Which source produced this capture. */
  source?: string | null;
  /** Contract expiry the chain belongs to. */
  expiry?: string | null;
}

// ─── P0 data-integrity helpers ──────────────────────────────────
// A field the provider did not publish is recorded as MISSING (null), never as
// an invented zero. `numOrNull` is the single normalisation point so every
// source mapper behaves identically.
/**
 * Freshness of a captured payload, derived ONLY from the provider's own
 * timestamp.
 *
 * No provider timestamp → UNAVAILABLE (an undated payload is undated; a 200
 * response is not proof of liveness). The provider clock is accepted as-is —
 * including the NSE exchange clock, which runs on IST — because the age is
 * what matters and both clocks are IST-based.
 */
export function classifyCaptureFreshness(
  providerTimestamp: string | null,
  collectedAt: string = new Date().toISOString(),
): string {
  if (!providerTimestamp) return "UNAVAILABLE";
  const ts = Date.parse(providerTimestamp);
  if (!Number.isFinite(ts)) return "UNAVAILABLE";
  const ageMs = Date.parse(collectedAt) - ts;
  if (!Number.isFinite(ageMs)) return "UNAVAILABLE";
  return classifyFreshness(ageMs, "optionChain");
}

export function numOrNull(v: any): number | null {  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A price/IV of 0 in an option quote means "no quote / no trades" — NOT a
// real zero. Record it as MISSING, never as a priceable 0.
export function positiveOrNull(v: any): number | null {
  const n = numOrNull(v);
  return n != null && n > 0 ? n : null;
}

// Hard cap on one symbol's capture. Without it a hung upstream (Breeze socket,
// NSE scrape, sidecar write) blocked the whole POST forever — which is how the
// recorder died silently on 18-Nov (the systemd tick held its flock for 10h).
export const CAPTURE_TIMEOUT_MS = 40_000;

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: any;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a canonical chain payload into recorded option legs.
 *
 * Two canonical shapes feed this: the provider-race winner
 * (market-data-race → CanonicalChain) and the data-layer canonical chain
 * (src/lib/data-layer/chains/option-chain). Both expose
 * `strikes[{strike, ce, pe}]`, so one mapper serves both and the recorder
 * stays on the SAME paths the live /api/option-chain route uses.
 *
 * Missing semantics: a published 0 LTP/IV means "no quote" (recorded as
 * MISSING, null); OI/ΔOI/volume of 0 are real values and stay 0. Greeks are
 * recorded only when the payload actually carries them — otherwise they stay
 * MISSING (null) and `estimated` is true.
 */
export function mapCanonicalChain(
  chain: {
    strikes: Array<{ strike: number; ce: any; pe: any }>;
    spotPrice?: number;
  },
  expiry?: string | null,
): OptionLeg[] {
  const legs: OptionLeg[] = [];
  const spot = numOrNull(chain.spotPrice) ?? 0;
  const tte = yearsToExpiry(expiry ?? undefined);
  const push = (leg: any, type: "CE" | "PE", strike: number) => {
    if (!leg) return;
    const iv = positiveOrNull(leg.iv);
    let g: OptionLeg["greeks"] = { delta: null, theta: null, gamma: null, vega: null };
    const published =
      leg.delta != null || leg.theta != null || leg.gamma != null || leg.vega != null;
    if (published) {
      g = {
        delta: numOrNull(leg.delta),
        theta: numOrNull(leg.theta),
        gamma: numOrNull(leg.gamma),
        vega: numOrNull(leg.vega),
      };
    } else if (iv != null && spot > 0 && strike > 0) {
      try {
        const calc = calculateGreeks(spot, strike, tte, iv / 100, type === "CE");
        g = {
          delta: numOrNull(calc.delta),
          theta: numOrNull(calc.theta),
          gamma: numOrNull(calc.gamma),
          vega: numOrNull(calc.vega),
        };
      } catch {}
    }
    legs.push({
      strike,
      type,
      ltp: positiveOrNull(leg.ltp),
      oi: numOrNull(leg.oi),
      oiChg: numOrNull(leg.oiChg),
      iv,
      greeks: g,
      volume: numOrNull(leg.volume),
      bid: positiveOrNull(leg.bid),
      ask: positiveOrNull(leg.ask),
      estimated: !published,
    });
  };
  for (const row of chain.strikes ?? []) {
    push(row.ce, "CE", row.strike);
    push(row.pe, "PE", row.strike);
  }
  return legs;
}
/**
 * @deprecated (P0, 2026-11-19) — superseded by mapCanonicalChain() + the
 * shared provider race. Kept for one release cycle as the reference mapping
 * for a raw Breeze payload; the recorder no longer calls it.
 */
function mapBreezeChain(chain: { calls?: any[]; puts?: any[] }): OptionLeg[] {
  const legs: OptionLeg[] = [];
  const push = (q: any, type: "CE" | "PE") => {
    if (!q) return;
    // ICICI Breeze publishes NO greeks — src/lib/icici-breeze/option-chain.ts
    // computes them locally from the published IV (Black-Scholes). So they are
    // DERIVED, never "published", and when the IV is missing the placeholders
    // (0) are a MISSING value, not a real zero.
    const iv = positiveOrNull(q.iv);
    const hasIv = iv != null;
    legs.push({
      strike: numOrNull(q.strikePrice) ?? 0,
      type,
      ltp: positiveOrNull(q.ltp),
      oi: numOrNull(q.openInterest),
      oiChg: numOrNull(q.oiChange),
      iv,
      greeks: hasIv
        ? {
            delta: numOrNull(q.delta),
            theta: numOrNull(q.theta),
            gamma: numOrNull(q.gamma),
            vega: numOrNull(q.vega),
          }
        : { delta: null, theta: null, gamma: null, vega: null },
      volume: numOrNull(q.volume),
      bid: positiveOrNull(q.bid),
      ask: positiveOrNull(q.ask),
      estimated: true,
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
/**
 * @deprecated (P0, 2026-11-19) — superseded by mapCanonicalChain() + the
 * shared provider race. Still exported for the mapping unit test; the
 * recorder no longer calls it.
 */
export function mapNSEChain(nse: any): OptionLeg[] {
  const rows = nse?.records?.data ?? [];
  const spot = Number(nse?.records?.underlyingValue) || 0;
  const legs: OptionLeg[] = [];
  for (const row of rows) {
    const push = (o: any, type: "CE" | "PE") => {
      if (!o) return;
      const iv = positiveOrNull(o.impliedVolatility);
      const publishedGreeks =
        o.greeks?.delta != null || o.greeks?.theta != null || o.greeks?.gamma != null || o.greeks?.vega != null;
      // Legacy shape (deprecated mapper, pinned by tests/market-recorder-capture.test.ts):
      // an IV=0 / non-computable leg keeps ZERO greeks — never fabricated BS.
      // The recorder's live path (mapCanonicalChain) records null (= missing) instead.
      let g: OptionLeg["greeks"] = { delta: 0, theta: 0, gamma: 0, vega: 0 };
      let estimated = true;
      if (publishedGreeks) {
        g = {
          delta: numOrNull(o.greeks.delta),
          theta: numOrNull(o.greeks.theta),
          gamma: numOrNull(o.greeks.gamma),
          vega: numOrNull(o.greeks.vega),
        };
        estimated = false;
      } else if (iv !== null && iv > 0 && spot > 0 && row.strikePrice > 0) {
        try {
          const calc = calculateGreeks(
            spot,
            row.strikePrice,
            yearsToExpiry(o.expiryDate),
            iv / 100,
            type === "CE"
          );
          g = {
            delta: numOrNull(calc.delta),
            theta: numOrNull(calc.theta),
            gamma: numOrNull(calc.gamma),
            vega: numOrNull(calc.vega),
          };
        } catch {}
      }
      legs.push({
        strike: numOrNull(row.strikePrice) ?? 0,
        type,
        ltp: positiveOrNull(o.lastPrice),
        oi: numOrNull(o.openInterest),
        oiChg: numOrNull(o.changeinOpenInterest),
        iv,
        greeks: g,
        volume: numOrNull(o.totalTradedVolume),
        estimated,
      });
    };
    push(row.CE, "CE");
    push(row.PE, "PE");
  }
  return legs;
}

// BSE getBSEOptionChain returns { data: [{ strike, ce, pe }] } — IV but no greeks.
// Compute greeks from IV with Black-Scholes (same as the Breeze path does).
/**
 * @deprecated (P0, 2026-11-19) — superseded by mapCanonicalChain() + the
 * shared provider race.
 */
function mapBSEChain(bse: { data: any[]; spotPrice: number }, expiry: string): OptionLeg[] {
  const legs: OptionLeg[] = [];
  const tte = yearsToExpiry(expiry);
  const spot = bse.spotPrice ?? 0;
  for (const row of bse.data ?? []) {
    const push = (o: any, type: "CE" | "PE") => {
      if (!o) return;
      const iv = positiveOrNull(o.iv);
      let g: OptionLeg["greeks"] = { delta: null, theta: null, gamma: null, vega: null };
      if (iv !== null && iv > 0 && spot > 0 && row.strike > 0) {
        try {
          const calc = calculateGreeks(spot, row.strike, tte, iv / 100, type === "CE");
          g = {
            delta: numOrNull(calc.delta),
            theta: numOrNull(calc.theta),
            gamma: numOrNull(calc.gamma),
            vega: numOrNull(calc.vega),
          };
        } catch {}
      }
      legs.push({
        strike: numOrNull(row.strike) ?? 0,
        type,
        ltp: positiveOrNull(o.ltp),
        oi: numOrNull(o.oi),
        oiChg: numOrNull(o.oiChg),
        iv,
        greeks: g,
        volume: numOrNull(o.volume),
        estimated: true,
      });
    };
    push(row.ce, "CE");
    push(row.pe, "PE");
  }
  return legs;
}

// Live fetch glue — requires a provider session at runtime. Defensive: never throws.
export async function fetchRawMarketData(symbol: string): Promise<RawMarketData> {
  // ── Option chain: the app's CANONICAL provider paths ─────────
  // Stage 1 — provider race (Breeze → MO → NSE → nse-mcp → BSE), with
  // per-provider timeouts and exchange awareness (src/lib/market-data-race.ts).
  // Stage 2 — the data-layer canonical chain (bhavcopy/archives safety net),
  // the SAME fallback the live /api/option-chain route uses.
  //
  // Both stages run CONCURRENTLY and the first one that yields legs wins, so
  // a dead live provider costs no extra minutes. The recorder used to run its
  // own Breeze→NSE→BSE chain; that duplicate path missed the MO/data-layer
  // fallbacks and died whenever the Breeze session expired (18-Nov).
  const { getOptionChain: canonicalChain } = await import("@/lib/data-layer/chains/option-chain");
  const [raceRes, canonRes] = await Promise.allSettled([
    withTimeout(runOptionChainRace({ symbol }), 12_000, `chain-race(${symbol})`),
    withTimeout(canonicalChain(symbol), 12_000, `data-layer-chain(${symbol})`),
  ]);

  const race = raceRes.status === "fulfilled" ? raceRes.value : null;
  const canon = canonRes.status === "fulfilled" ? canonRes.value : null;
  const winner = race?.winner ?? null;
  const canonData = (canon as any)?.data ?? null;

  let legs: OptionLeg[] = [];
  let spot = 0;
  let chainSource: string | null = null;
  let providerTimestamp: string | null = null;
  let expiry: string | null = null;

  if (winner?.strikes?.length) {
    legs = mapCanonicalChain(winner as any, winner.expiry);
    spot = numOrNull(winner.spotPrice) ?? 0;
    chainSource = winner.source;
    providerTimestamp = winner.providerTimestamp ?? null;
    expiry = winner.expiry ?? null;
  } else if (canonData?.strikes?.length) {
    legs = mapCanonicalChain(
      { strikes: canonData.strikes, spotPrice: canonData.spot },
      canonData.expiry ?? null
    );
    spot = numOrNull(canonData.spot) ?? 0;
    chainSource =
      canonData.source === "BSE" ? "bse-api" : canonData.source === "NSE" ? "nse-api" : "data-layer";
    providerTimestamp = canonData.providerTimestamp ?? null;
    expiry = canonData.expiry ?? null;
  }

  if (!legs.length) {
    throw new Error(`option chain unavailable for ${symbol} (provider race + data-layer returned no data)`);
  }
  if (chainSource === "icici-breeze") reportSessionRecovery("breeze");
  if (chainSource === "nse-api" || chainSource === "nse-mcp") reportSessionRecovery("nse");

  const [quotesRes, vixRes, gainersRes, losersRes] = await Promise.allSettled([
    withTimeout(getQuotes(symbol), 8_000, `quotes(${symbol})`),
    withTimeout(getNSEIndiaVIX(), 8_000, "vix"),
    withTimeout(getNSEGainers(), 8_000, "gainers"),
    withTimeout(getNSELosers(), 8_000, "losers"),
  ]);

  if (quotesRes.status === "fulfilled" && quotesRes.value) {
    spot = quotesRes.value.last_price ?? quotesRes.value.ltp ?? spot;
  }

  // Candles: multi-source chain (Breeze → MO → NSE index-only). Never throws;
  // failures are classified into session-health (single alert owner) + lastCandle.
  const candleResult = await withTimeout(
    fetchCandlesWithFallback(
      symbol,
      new Date().toISOString().slice(0, 10),
      "1minute"
    ),
    15_000,
    `candles(${symbol})`
  ).catch((e: any) => ({
    candles: [] as Candle[],
    source: "none",
    intervalLabel: "none",
    degraded: `candle chain failed: ${String(e?.message ?? e)}`,
    failures: [
      { source: "nse", kind: "SOURCE_UNAVAILABLE", detail: String(e?.message ?? e) },
    ] as CandleChainFailure[],
  }));
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

  return {
    spot,
    futures: null,
    chain: legs,
    candles,
    candleInterval,
    indiaVix,
    breadthAdv,
    breadthDec,
    providerTimestamp,
    source: chainSource,
    expiry,
  };
}

// Testable store path — no network. Builds the canonical snapshot and persists it.
// `bucketMs` aligns the capture timestamp to a deterministic bucket (per the active
// interval) so that duplicate scheduler ticks map to the SAME (symbol, timestamp) key
// and are ignored by the UNIQUE index — making recording idempotent.
export async function captureAndStore(symbol: string, raw: RawMarketData, bucketMs = 60000): Promise<{ snapshot: CanonicalMarketSnapshot; inserted: boolean }> {
  const bucketed = Math.floor(Date.now() / bucketMs) * bucketMs;
  const collectedAt = new Date().toISOString();
  // Freshness is derived from the PROVIDER's own timestamp. A payload with no
  // provider timestamp stays UNAVAILABLE — a 200 response is not proof of
  // liveness (same rule as src/lib/api-freshness.ts).
  const freshness = classifyCaptureFreshness(raw.providerTimestamp ?? null, collectedAt);
  const snap = buildCanonicalSnapshot({
    symbol,
    timestamp: new Date(bucketed).toISOString(),
    providerTimestamp: raw.providerTimestamp ?? null,
    collectedAt,
    source: raw.source ?? null,
    freshness,
    expiry: raw.expiry ?? null,
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
    await recordCandles(symbol, raw.candleInterval || "1minute", raw.candles, raw.source ?? null);
  }
  return { snapshot: snap, inserted };
}

/**
 * Sanctioned accessor for LIVE candles (Breeze → MO → NSE). The candle chain may
 * only be imported by this module (architecture test: backtest/evaluation modules
 * must stay isolated from live capture), so live signal cards read candles here.
 */
export async function getLiveCandles(symbol: string, interval: string, date = new Date().toISOString().slice(0, 10)) {
  const { fetchCandlesWithFallback } = await import("./candle-chain");
  const res = await fetchCandlesWithFallback(symbol, date, interval);
  return {
    candles: res.candles || [],
    source: res.source,
    degraded: res.degraded,
    intervalLabel: res.intervalLabel,
    failures: res.failures.map((f) => `${f.source}: ${f.detail}`),
  };
}

export async function recordSymbol(symbol: string, opts?: { mode?: RecorderMode; interval?: number; timeoutMs?: number }): Promise<{ symbol: string; status: "ok" | "error"; inserted?: boolean; reason?: string; kind?: FailureKind }> {
  try {
    // HARD CAP: one symbol may never block the route. A hung Breeze socket or
    // an unreachable sidecar used to hang the POST forever — the systemd tick
    // then held its flock for hours and the recorder stopped silently.
    const raw = await withTimeout(
      fetchRawMarketData(symbol),
      opts?.timeoutMs ?? CAPTURE_TIMEOUT_MS,
      `capture(${symbol})`
    );
    const interval = opts?.interval ?? 60000;
    const { inserted } = await withTimeout(
      captureAndStore(symbol, raw, interval),
      opts?.timeoutMs ?? CAPTURE_TIMEOUT_MS,
      `store(${symbol})`
    );
    recorderState.lastSuccess = { symbol, timestamp: new Date(Math.floor(Date.now() / interval) * interval).toISOString(), mode: opts?.mode ?? getRecorderMode(), interval: interval / 1000 };
    recorderState.totalCaptures++;
    return { symbol, status: "ok", inserted };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    // Classify for status/evidence surfaces: an active source session-expiry
    // (from session-health, single owner) wins over generic classification.
    const health = getSessionHealth();
    const expired = (["breeze", "mo", "nse"] as const).find((s) => health[s].kind === "SESSION_EXPIRED");
    // A timeout is its own failure kind — do NOT let a stale "expired" flag
    // from another source mislabel it.
    const kind: FailureKind = /timed out after/i.test(reason)
      ? "SOURCE_UNAVAILABLE"
      : expired
        ? "SESSION_EXPIRED"
        : classifySourceError("breeze", reason);
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
    // allSettled: one symbol's failure must never cancel the others' captures.
    const settled = await Promise.allSettled(
      symbols.map((s) => recordSymbol(s, { mode, interval: intervalMs }))
    );
    const results = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            symbol: symbols[i],
            status: "error" as const,
            reason: String((r as any)?.reason?.message ?? r),
            kind: "SOURCE_UNAVAILABLE" as FailureKind,
          }
    );
    return { recorded: results.filter((r) => r.status === "ok").length, results };
  }
  // Manual / forced — 1-minute bucket, always captures.
  const settled = await Promise.allSettled(
    symbols.map((s) => recordSymbol(s, { mode, interval: 60000 }))
  );
  const results = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          symbol: symbols[i],
          status: "error" as const,
          reason: String((r as any)?.reason?.message ?? r),
          kind: "SOURCE_UNAVAILABLE" as FailureKind,
        }
  );
  return { recorded: results.filter((r) => r.status === "ok").length, results };
}
