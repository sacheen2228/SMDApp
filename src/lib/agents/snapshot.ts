// ═══════════════════════════════════════════════════════════════════════════
// Shared Market Snapshot (v2 §3 / §21)
// ONE fetch cycle → one AgentContext + one fetchedAtIso for all 30 agents.
// Agents are pure functions of this snapshot; they never poll NSE/MOAPI.
// ═══════════════════════════════════════════════════════════════════════════

import { collectHermesContext } from '../hermes/context';
import type { HermesContext } from '../hermes/types';
import type { OptionChain, OptionLeg } from '../jarvis/types';
import {
  freshnessFromIso,
  type AgentContext,
  type DataFreshnessLevel,
  type FuturesFlowSlice,
} from './agent-contract';
import { runInstitutionalPositioning } from '@/lib/institutional-positioning-engine';
import { buildTechnicalSnapshot, fetchTechnicalCandles } from '@/lib/technical-snapshot';
import { readFuturesFlow, istDateStr, type FuturesFlowRead } from '@/lib/market/futures-flow';

export interface AgentSnapshot {
  ctx: AgentContext;
  fetchedAtIso: string;
  hermes: HermesContext;
}

export interface BuildSnapshotOptions {
  apiBase?: string;
  timeframe?: string;
  // Phase 4 technical layer: fetch real OHLCV (5m/15m/1d, parallel) and
  // compute ctx.technical. Off by default so the v2 §3 fetch-budget tests
  // and non-production callers stay at the deliberate ≤12 set; the
  // production pipeline route enables it.
  technical?: boolean;
  // Futures-leg flow slice (real volume + open interest from the nearest
  // index futures contract). Off by default like `technical` — the v2 §3
  // fetch-budget tests and non-production callers stay network-free; the
  // production pipeline route enables it.
  flow?: boolean;
}

export function defaultApiBase(): string {
  return process.env.SMD_API_BASE || 'http://127.0.0.1:3000';
}

export async function buildAgentSnapshot(
  symbol: string,
  opts: BuildSnapshotOptions = {}
): Promise<AgentSnapshot> {
  const apiBase = opts.apiBase ?? defaultApiBase();
  // Single collection cycle — hermes RESEARCH mode fetches each data type
  // exactly once in parallel (option chain, FII/DII, news, regime, structure,
  // gamma, …). This is the "deliberate small number" of §28, never 30.
  const hermes = await collectHermesContext(symbol, 'RESEARCH', apiBase);
  const fetchedAtIso = hermes.timestamp || new Date().toISOString();
  const ctx = mapHermesToAgentContext(
    hermes,
    fetchedAtIso,
    opts.timeframe || '15m'
  );
  // Resolve the reconciled institutional slice here (async) so both
  // Agent 02 (analyzeFIIDII) and the SDM filter read the same data.
  // dbOnly: the snapshot must never blow the ≤12-fetch cycle budget (v2 §3/§21);
  // NSE CSV refresh stays with the cron + /api/sdm-signal paths.
  try {
    ctx.institutional = await runInstitutionalPositioning({ dbOnly: true });
  } catch { /* non-fatal — agents guard on undefined */ }

  // Phase 4 — technical evidence layer from REAL candles (best-effort).
  // Failure at any point → ctx.technical stays absent → technical agents
  // report NO_DATA (never fabricated evidence).
  if (opts.technical) {
    try {
      const candlesByTF = await fetchTechnicalCandles(symbol);
      ctx.technical = buildTechnicalSnapshot({
        candlesByTF,
        spot: ctx.spot,
        prevClose: ctx.prevClose,
        pdh: ctx.pdh,
        pdl: ctx.pdl,
        iv: ctx.atmIV > 0 ? ctx.atmIV : null,
        oiSupportLevels: ctx.supportLevels,
        oiResistanceLevels: ctx.resistanceLevels,
        fetchedAtIso,
      });
    } catch (err) {
      console.warn('[Snapshot] technical layer unavailable:', err);
    }
  }

  // Futures flow — real futures volume + open interest (best-effort).
  // Same shared read the Daily Derivatives card uses. Failure → ctx.flow
  // stays absent → the flow agents report NO_DATA, never fabricated numbers.
  if (opts.flow) {
    try {
      const read = await readFuturesFlow(symbol, istDateStr(0));
      ctx.flow = toFlowSlice(read);
    } catch (err) {
      console.warn('[Snapshot] futures flow unavailable:', err);
    }
  }

  return { ctx, fetchedAtIso, hermes };
}

/** Map the shared futures-flow read onto the agent context slice. */
export function toFlowSlice(read: FuturesFlowRead): FuturesFlowSlice {
  const cvd = read?.cvd;
  return {
    available: Boolean(read?.available && cvd?.available),
    source: read?.source || "none",
    contract: read?.contract,
    bars: read?.bars || 0,
    cvd: cvd?.cumulative,
    deltaPercent: cvd?.deltaPercent,
    verdict: cvd?.verdict,
    oiFirst: cvd?.oiFirst,
    oiLast: cvd?.oiLast,
    oiChange: cvd?.oiChange,
    oiChangePct: cvd?.oiChangePct,
    buildup: cvd?.buildup ?? null,
    divergence: cvd?.divergence ?? null,
    relativeVolume: read?.relativeVolume?.ratio,
    avgVolume: read?.relativeVolume?.average,
    lastBarVolume: read?.relativeVolume?.current,
    note: read?.note,
  };
}

export function mapHermesToAgentContext(
  h: HermesContext,
  fetchedAtIso: string,
  timeframe: string
): AgentContext {
  const spot = (h.spot?.value || {}) as any;
  const chain = (h.optionChain?.value || {}) as any;
  const fii = (h.fiiDII?.value || null) as any;
  const regime = (h.regime?.value || null) as any;
  const struct = (h.marketStructure?.value || null) as any;
  const greeks = (h.greeks?.value || null) as any;
  const gamma = (h.gamma?.value || null) as any;
  const volume = (h.volume?.value || null) as any;
  const news = (h.news?.value || null) as any;
  const freshness: DataFreshnessLevel = freshnessFromIso(fetchedAtIso);

  return {
    symbol: h.symbol,
    timeframe,
    exchange: h.exchange,
    instrument: h.instrument,

    spot: spot.price ?? 0,
    prevClose: spot.prevClose ?? 0,
    open: spot.open ?? 0,
    high: spot.high ?? 0,
    low: spot.low ?? 0,
    volume: spot.volume ?? 0,

    optionChain: chain,
    strikes: chain.strikes ?? [],

    vix: h.vix?.value ?? chain.vix ?? 0,
    vixChange: 0,

    fiiNet: fii?.fiiNet ?? 0,
    diiNet: fii?.diiNet ?? 0,
    fiiBias: fii?.fiiBias ?? 'NEUTRAL',
    participantOI: fii?.participantOI ?? null,

    regime: regime?.type ?? 'UNKNOWN',
    regimeBias: regime?.bias ?? 'NEUTRAL',
    regimeConfidence: regime?.confidence ?? 0,

    trend: struct?.trend ?? 'SIDEWAYS',
    swingHigh: struct?.swingHigh ?? 0,
    swingLow: struct?.swingLow ?? 0,
    supportLevels: struct?.supportLevels ?? [],
    resistanceLevels: struct?.resistanceLevels ?? [],
    pdh: struct?.pdh ?? 0,
    pdl: struct?.pdl ?? 0,
    lastEvent: struct?.lastEvent ?? '',

    atmDelta: greeks?.delta ?? 0,
    atmGamma: greeks?.gamma ?? 0,
    atmTheta: greeks?.theta ?? 0,
    atmVega: greeks?.vega ?? 0,
    atmIV: greeks?.iv ?? 0,

    totalVolume: volume?.totalVolume ?? 0,
    poc: volume?.poc ?? 0,
    vah: volume?.vah ?? 0,
    val: volume?.val ?? 0,

    gammaDetected: gamma?.detected ?? false,
    gammaWallStrike: gamma?.gammaWallStrike ?? chain.gammaWall ?? 0,
    gammaFlip: chain.gammaFlip ?? 0,
    dealerBias: gamma?.dealerBias ?? 'NEUTRAL',

    newsSentiment: news?.sentiment ?? 'NEUTRAL',
    newsScore: news?.score ?? 0,
    headlines: news?.headlines ?? [],

    marketStatus: String(h.marketStatus ?? 'UNKNOWN'),
    daysToExpiry: chain.daysToExpiry ?? 0,
    expiry: chain.expiry ?? '',

    dataTimestamp: fetchedAtIso,
    spotFreshness: freshness,
    chainFreshness: freshness,
    fetchedAtIso,
    institutional: undefined,
    jarvisChain: toJarvisChain(chain) ?? undefined,

    rawContext: h,
  };
}

// ─── Jarvis chain mapping (v2 §2) ────────────────────────────────────────
// Pure reshaping of the SAME Hermes fetch — zero extra network calls.
// Lets agents wrap jarvis scoring/greeks/levels instead of running
// parallel OI/Greeks math.

function toJarvisLeg(d: any): OptionLeg | undefined {
  if (!d) return undefined;
  return {
    openInterest: Number(d.oi) || 0,
    changeinOpenInterest: Number(d.oiChange) || 0,
    impliedVolatility: Number(d.iv) || 0,
    lastPrice: Number(d.ltp) || 0,
    bidPrice: typeof d.bid === 'number' ? d.bid : undefined,
    askPrice: typeof d.ask === 'number' ? d.ask : undefined,
    totalTradedVolume: Number(d.volume) || 0,
  };
}

export function toJarvisChain(chain: any): OptionChain | null {
  if (!chain) return null;
  const spot = Number(chain.spot);
  const expiry = String(chain.expiry || '');
  const strikes = chain.strikes;
  if (!spot || spot <= 0 || !expiry) return null;
  if (!Array.isArray(strikes) || strikes.length === 0) return null;
  return {
    underlyingValue: spot,
    expiryDates: [expiry],
    data: strikes.map((s: any) => ({
      strikePrice: Number(s.strike) || 0,
      expiryDate: expiry,
      CE: toJarvisLeg(s.ce),
      PE: toJarvisLeg(s.pe),
    })),
  };
}
