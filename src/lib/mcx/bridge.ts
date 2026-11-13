// MCX Commodity Module — Integration Bridge
//
// Single, PURE surface that connects the MCX engines to their consumers
// (morning signals, the agent tools, Hermes context, the /api/mcx route).
//
// Every function here is offline and deterministic so the wiring can be
// tested without hitting a provider. The historical bugs were all shape
// mismatches between an MCX producer and its consumer — centralising the
// mapping here is what makes those bugs impossible to reintroduce.

import type { MCXCommodity, MCXQuote, MCXScannerResult } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';

// ─── /api/mcx route view selection ──────────────────────────────────────────

export type MCXRouteMode = 'market' | 'quote' | 'best' | 'summary';

/**
 * Resolve what the caller asked /api/mcx for.
 *   - ?symbol=CRUDEOIL            → single quote
 *   - ?mode=best                  → best scanner trade
 *   - ?mode=summary               → scanner summary
 *   - ?mode=scanner / mode=full   → full scanner-compatible market payload
 *   - no params                   → market (energy + precious metals)
 */
export function resolveMCXRouteMode(params: {
  mode?: string | null;
  symbol?: string | null;
}): MCXRouteMode {
  const symbol = params.symbol?.trim().toUpperCase();
  if (symbol && isApprovedMCXSymbol(symbol)) return 'quote';

  switch ((params.mode || '').trim().toLowerCase()) {
    case 'best':
      return 'best';
    case 'summary':
      return 'summary';
    case 'scanner':
    case 'full':
      return 'market';
    default:
      return 'market';
  }
}

export function isApprovedMCXSymbol(symbol: string): symbol is MCXCommodity {
  return (MCX_APPROVED_CONTRACTS as string[]).includes(symbol);
}

// ─── Scanner result → morning signal ────────────────────────────────────────

export interface MCXMorningSignalFields {
  symbol: string;
  name: string;
  sector: string;
  type: 'FUT';
  side: 'BUY' | 'SELL';
  direction: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rr: number;
  confidence: number;
  instrument: string;
  reasoning: string;
  source: 'mcx-scanner';
}

/**
 * Map an MCXScannerResult onto the fields a MorningSignal needs.
 *
 * Field-name contract (the old bug): the scanner exposes `target` (single),
 * `score` (0-100) and `reasons` (string[]). The morning signal wants `tp1`,
 * `tp2`, `confidence` and `reasoning`.
 */
export function mapMCXScannerResultToMorningSignal(
  best: Pick<MCXScannerResult, 'symbol' | 'direction' | 'entry' | 'stopLoss' | 'score' | 'reasons'> &
    Partial<Pick<MCXScannerResult, 'target' | 'riskReward'>>
): MCXMorningSignalFields {
  const dir = String(best.direction || 'LONG').toUpperCase();
  const side: 'BUY' | 'SELL' = dir === 'SHORT' || dir === 'SELL' ? 'SELL' : 'BUY';
  const target = typeof best.target === 'number' ? best.target : 0;
  const rr = typeof best.riskReward === 'number' && best.riskReward > 0 ? best.riskReward : 1;
  const confidence = typeof best.score === 'number' ? best.score : 0;

  return {
    symbol: best.symbol,
    name: best.symbol,
    sector: 'Commodity',
    type: 'FUT',
    side,
    direction: dir,
    entry: best.entry || 0,
    stopLoss: best.stopLoss || 0,
    tp1: target,
    tp2: target,
    rr,
    confidence,
    instrument: `MCX ${best.symbol} Futures`,
    reasoning: Array.isArray(best.reasons) && best.reasons.length > 0
      ? best.reasons.join('; ')
      : 'MCX commodity scan',
    source: 'mcx-scanner',
  };
}

// ─── Quote → get_mcx_data tool text ─────────────────────────────────────────

/**
 * Format a single MCXQuote for the `get_mcx_data` agent tool.
 * Reads the REAL MCXQuote field names (`changePercent`, `high`, `low`,
 * `dataSource`), never the non-existent `changePct`/`dayHigh`/`source`.
 */
export function formatMCXQuoteToolResponse(symbol: string, quote: MCXQuote | null | undefined): string {
  if (!quote || quote.ltp === null || quote.dataStatus === 'DATA_UNAVAILABLE') {
    return `MCX ${symbol}: DATA_UNAVAILABLE — no live quote (source: ${quote?.dataSource || 'NONE'})`;
  }

  const num = (v: number | null, digits = 2) => (v === null || v === undefined ? 'N/A' : v.toFixed(digits));
  const lines = [
    `MCX ${symbol}:`,
    `LTP: ₹${num(quote.ltp)}`,
    `Change: ${num(quote.change)} (${num(quote.changePercent)}%)`,
    `Day High: ₹${num(quote.high)} | Day Low: ₹${num(quote.low)}`,
    `Volume: ${quote.volume !== null ? quote.volume.toLocaleString('en-IN') : 'N/A'}`,
    `Source: ${quote.dataSource} (${quote.dataStatus})`,
  ];
  return lines.join('\n');
}

// ─── /api/mcx/intelligence → Hermes flat shape ──────────────────────────────

export interface MCXIntelligenceFlat {
  symbol: string | null;
  regime: string;
  regimeConfidence: number;
  structureBias: string;
  structureEvent: string;
  oiClassification: string;
  oiDivergence: boolean;
  relativeVolume: number;
  volumeState: string;
  atr: number;
  atrPercent: number;
  volatilityRegime: string;
  ivClassification: string;
  expectedMove: number;
  chainQuality: string;
  bestCandidateDirection: string;
  bestCandidateScore: number;
  bestCandidateRR: number;
  longScore: number;
  shortScore: number;
  dataFreshness: {
    candlesAvailable: boolean;
    candleCount: number;
    optionChainAvailable: boolean;
    quoteAvailable: boolean;
  };
}

function scoreTotal(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as any).total === 'number') return (v as any).total;
  return 0;
}

/**
 * Flatten the `/api/mcx/intelligence` response (nested under `intelligence`)
 * into the flat shape Hermes' MCXIntelligenceData expects. Also tolerates the
 * `action=scan` shape where `longScore` is already a number.
 */
export function extractMCXIntelligence(apiResponse: any): MCXIntelligenceFlat | null {
  const intel = apiResponse?.intelligence ?? apiResponse?.data?.intelligence ?? apiResponse;
  if (!intel || typeof intel !== 'object') return null;

  const regime = intel.regime ?? {};
  const structure = intel.structure ?? {};
  const volumeOI = intel.volumeOI ?? {};
  const volatility = intel.volatility ?? {};
  const optionIntel = intel.optionIntel ?? {};
  const bestCandidate = intel.bestCandidate ?? null;

  return {
    symbol: intel.symbol ?? null,
    regime: regime.regime || 'NO_TRADE',
    regimeConfidence: regime.confidence || 0,
    structureBias: structure.bias || 'NEUTRAL',
    structureEvent: structure.event || 'NONE',
    oiClassification: volumeOI.oiClassification || 'NEUTRAL',
    oiDivergence: volumeOI.oiDivergence || false,
    relativeVolume: volumeOI.relativeVolume || 1,
    volumeState: volumeOI.volumeState || 'NORMAL',
    atr: volatility.atr || 0,
    atrPercent: volatility.atrPercent || 0,
    volatilityRegime: volatility.volatilityRegime || 'NORMAL_VOL',
    ivClassification: volatility.ivClassification || 'NORMAL',
    expectedMove: volatility.expectedMove || 0,
    chainQuality: optionIntel.chainQuality || 'UNTRADEABLE',
    bestCandidateDirection: bestCandidate?.direction || 'NEUTRAL',
    bestCandidateScore: scoreTotal(bestCandidate?.score),
    bestCandidateRR: bestCandidate?.actualRR || bestCandidate?.netRR || 0,
    longScore: scoreTotal(intel.longScore),
    shortScore: scoreTotal(intel.shortScore),
    dataFreshness: intel.dataFreshness || {
      candlesAvailable: false,
      candleCount: 0,
      optionChainAvailable: false,
      quoteAvailable: false,
    },
  };
}
