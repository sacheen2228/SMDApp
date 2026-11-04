// Market Context Integration — Phase D of Unified Intraday Intelligence Engine
//
// Composes India VIX, FII/DII, sector breadth, and market regime into a
// single context object consumed by the central decision coordinator.
//
// Reuses existing providers:
//   • India VIX — nse-api.ts getNSEIndiaVIX()
//   • FII/DII — fii-dii.ts fetchFiiDiiData()
//   • Sector breadth — universe module (Phase A)
//   • Regime — regime-classifier.ts + indicator bundle (Phase B)
//
// All outputs carry freshness + availability flags. Missing data → null,
// never fabricated. FII/DII daily activity is contextual evidence only —
// never an automatic entry trigger or veto.
//
// Does NOT modify production engines. Does NOT create a scanner.

import { readVIX, readFIIDII } from "./derivatives";
import type { IndicatorBundle } from "./indicators";
import type { SmcRead } from "./smc";
import type { MechanismRead } from "./mechanism";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type MarketContextFreshness = "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface MarketContextRead<T> {
  value: T | null;
  freshness: MarketContextFreshness;
  available: boolean;
  reason: string | null;
}

export interface FiiDiiContext {
  fiiNet: number | null;
  diiNet: number | null;
  fiiBuy: number | null;
  fiiSell: number | null;
  diiBuy: number | null;
  diiSell: number | null;
  date: string | null;
  source: string;
  flowTrend: "BUYING" | "SELLING" | "NEUTRAL" | null;
  consecutiveBuyingSessions: number;
  consecutiveSellingSessions: number;
}

export interface VixContext {
  value: number | null;
  change: number | null;
  regime: 'low' | 'normal' | 'high' | 'extreme' | null;
  vsAtr: "VIX_ABOVE_ATR" | "VIX_BELOW_ATR" | "NEUTRAL" | null;
}

export interface SectorBreadthContext {
  advancing: number | null;
  declining: number | null;
  unchanged: number | null;
  total: number | null;
  pctAdvancing: number | null;
  regime: "ADVANCING" | "DECLINING" | "MIXED" | null;
}

export interface MarketContext {
  symbol: string;
  timestamp: string;
  vix: MarketContextRead<VixContext>;
  fiiDii: MarketContextRead<FiiDiiContext>;
  sectorBreadth: MarketContextRead<SectorBreadthContext>;
  regime: MarketContextRead<{
    regime: string;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    tradeable: boolean;
  }>;
  // Overall context quality for the coordinator
  contextQuality: "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";
  missingCritical: string[]; // critical inputs that are unavailable
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function flowTrend(fiiNet: number | null, diiNet: number | null): FiiDiiContext["flowTrend"] {
  if (fiiNet == null && diiNet == null) return null;
  if (fiiNet != null && fiiNet > 500) return "BUYING";
  if (fiiNet != null && fiiNet < -500) return "SELLING";
  if (diiNet != null && diiNet > 500) return "BUYING";
  if (diiNet != null && diiNet < -500) return "SELLING";
  return "NEUTRAL";
}

function breadthRegime(pctAdv: number | null): SectorBreadthContext["regime"] {
  if (pctAdv == null) return null;
  if (pctAdv >= 55) return "ADVANCING";
  if (pctAdv <= 45) return "DECLINING";
  return "MIXED";
}

// ────────────────────────────────────────────────────────────────────────────
// Main: build market context
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build market context from VIX, FII/DII, sector breadth and regime.
 *
 * @param symbol — trading symbol
 * @param indicatorBundle — Phase B indicator bundle (for regime context)
 * @param smcRead — Phase C SMC read
 * @param mechanismRead — Phase C mechanism read
 * @param sectorBreadth — optional sector breadth from Phase A universe
 */
export function buildMarketContext(
  symbol: string,
  indicatorBundle: IndicatorBundle,
  smcRead: SmcRead,
  mechanismRead: MechanismRead,
  sectorBreadth?: { advancing: number; declining: number; unchanged: number } | null,
): MarketContext {
  const timestamp = new Date().toISOString();
  const missingCritical: string[] = [];

  // ── VIX ──
  const vixVal = mechanismRead // VIX is read inside derivatives; here we reconstruct from available data
    ? null
    : null;
  // VIX is fetched async in derivatives; pass it through mechanismRead if available
  const vixValue: VixContext = {
    value: null,
    change: null,
    regime: null,
    vsAtr: null,
  };

  // ── FII/DII ──
  // FII/DII is fetched async in derivatives; synthesize from available context
  const fiiValue: FiiDiiContext = {
    fiiNet: null,
    diiNet: null,
    fiiBuy: null,
    fiiSell: null,
    diiBuy: null,
    diiSell: null,
    date: null,
    source: "unavailable",
    flowTrend: null,
    consecutiveBuyingSessions: 0,
    consecutiveSellingSessions: 0,
  };

  // ── Sector breadth ──
  const breadthValue: SectorBreadthContext = {
    advancing: sectorBreadth?.advancing ?? null,
    declining: sectorBreadth?.declining ?? null,
    unchanged: sectorBreadth?.unchanged ?? null,
    total: sectorBreadth ? sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged : null,
    pctAdvancing: sectorBreadth
      ? ((sectorBreadth.advancing / (sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged)) * 100) || null
      : null,
    regime: sectorBreadth ? breadthRegime(
      (sectorBreadth.advancing / (sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged)) * 100 || null
    ) : null,
  };

  const breadthRead: MarketContextRead<SectorBreadthContext> = sectorBreadth
    ? {
        value: breadthValue,
        freshness: "FRESH",
        available: true,
        reason: null,
      }
    : {
        value: null,
        freshness: "UNAVAILABLE",
        available: false,
        reason: "sector breadth unavailable",
      };

  if (!breadthRead.available) missingCritical.push("sector breadth");

  // ── Regime (from mechanism + SMC + indicators) ──
  const regimeVal = {
    regime: mechanismRead.mechanism as string,
    bias: mechanismRead.control as "NEUTRAL" | "BULLISH" | "BEARISH",
    tradeable: mechanismRead.confirmationStatus === "CONFIRMED" && mechanismRead.control !== "neutral",
  };

  const regimeRead: MarketContextRead<typeof regimeVal> = {
    value: regimeVal,
    freshness: mechanismRead.freshness,
    available: mechanismRead.sufficientData,
    reason: mechanismRead.reason ?? null,
  };

  if (!regimeRead.available) missingCritical.push("market regime");

  // ── VIX read (from mechanism context if available) ──
  // VIX value comes from derivatives phase; here we note availability
  const vixRead: MarketContextRead<VixContext> = {
    value: vixValue,
    freshness: "UNAVAILABLE",
    available: false,
    reason: "VIX fetched in derivatives phase — pass via context",
  };

  // ── FII/DII read ──
  const fiiRead: MarketContextRead<FiiDiiContext> = {
    value: fiiValue,
    freshness: "UNAVAILABLE",
    available: false,
    reason: "FII/DII fetched in derivatives phase — pass via context",
  };

  // ── Context quality ──
  const availableCount = [vixRead, fiiRead, breadthRead, regimeRead].filter((r) => r.available).length;
  const contextQuality: MarketContext["contextQuality"] =
    availableCount >= 3 ? "HIGH"
    : availableCount >= 2 ? "MEDIUM"
    : availableCount >= 1 ? "LOW"
    : "UNAVAILABLE";

  return {
    symbol,
    timestamp,
    vix: vixRead,
    fiiDii: fiiRead,
    sectorBreadth: breadthRead,
    regime: regimeRead,
    contextQuality,
    missingCritical,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Async wrapper that fetches VIX + FII/DII and builds full context
// ────────────────────────────────────────────────────────────────────────────

/**
 * Async version that actually fetches VIX and FII/DII from providers.
 * Use this when you need real market context data.
 */
export async function buildMarketContextAsync(
  symbol: string,
  indicatorBundle: IndicatorBundle,
  smcRead: SmcRead,
  mechanismRead: MechanismRead,
  sectorBreadth?: { advancing: number; declining: number; unchanged: number } | null,
): Promise<MarketContext> {
  const [vixResult, fiiResult] = await Promise.all([readVIX(), readFIIDII()]);

  const timestamp = new Date().toISOString();
  const missingCritical: string[] = [];

  // ── VIX ──
  const vixContext: VixContext = {
    value: vixResult.value?.value ?? null,
    change: vixResult.value?.change ?? null,
    regime: vixResult.value?.regime ?? null,
    vsAtr: null, // would need ATR comparison
  };

  const atrVal = indicatorBundle.atr.value;
  if (vixContext.value != null && atrVal) {
    const atrPct = atrVal.atrPct;
    vixContext.vsAtr = vixContext.value > (atrPct ?? 0) * 10 ? "VIX_ABOVE_ATR"
      : vixContext.value < (atrPct ?? 0) * 10 ? "VIX_BELOW_ATR"
      : "NEUTRAL";
  }

  const vixRead: MarketContextRead<VixContext> = {
    value: vixResult.available ? vixContext : null,
    freshness: vixResult.freshness,
    available: vixResult.available,
    reason: vixResult.reason ?? null,
  };
  if (!vixRead.available) missingCritical.push("India VIX");

  // ── FII/DII ──
  const fiiContext: FiiDiiContext = {
    fiiNet: fiiResult.value?.fiiNet ?? null,
    diiNet: fiiResult.value?.diiNet ?? null,
    fiiBuy: fiiResult.value?.fiiBuy ?? null,
    fiiSell: fiiResult.value?.fiiSell ?? null,
    diiBuy: fiiResult.value?.diiBuy ?? null,
    diiSell: fiiResult.value?.diiSell ?? null,
    date: fiiResult.value?.date ?? null,
    source: fiiResult.value?.source ?? "unavailable",
    flowTrend: fiiResult.value
      ? flowTrend(fiiResult.value.fiiNet, fiiResult.value.diiNet)
      : null,
    consecutiveBuyingSessions: 0,
    consecutiveSellingSessions: 0,
  };

  const fiiRead: MarketContextRead<FiiDiiContext> = {
    value: fiiResult.available ? fiiContext : null,
    freshness: fiiResult.freshness,
    available: fiiResult.available,
    reason: fiiResult.reason ?? null,
  };
  if (!fiiRead.available) missingCritical.push("FII/DII");

  // ── Sector breadth ──
  const breadthValue: SectorBreadthContext = {
    advancing: sectorBreadth?.advancing ?? null,
    declining: sectorBreadth?.declining ?? null,
    unchanged: sectorBreadth?.unchanged ?? null,
    total: sectorBreadth ? sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged : null,
    pctAdvancing: sectorBreadth
      ? ((sectorBreadth.advancing / (sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged)) * 100) || null
      : null,
    regime: sectorBreadth ? breadthRegime(
      (sectorBreadth.advancing / (sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged)) * 100 || null
    ) : null,
  };

  const breadthRead: MarketContextRead<SectorBreadthContext> = sectorBreadth
    ? {
        value: breadthValue,
        freshness: "FRESH",
        available: true,
        reason: null,
      }
    : {
        value: null,
        freshness: "UNAVAILABLE",
        available: false,
        reason: "sector breadth unavailable",
      };

  if (!breadthRead.available) missingCritical.push("sector breadth");

  // ── Regime ──
  const regimeVal = {
    regime: mechanismRead.mechanism as string,
    bias: mechanismRead.control as "NEUTRAL" | "BULLISH" | "BEARISH",
    tradeable: mechanismRead.confirmationStatus === "CONFIRMED" && mechanismRead.control !== "neutral",
  };

  const regimeRead: MarketContextRead<typeof regimeVal> = {
    value: regimeVal,
    freshness: mechanismRead.freshness,
    available: mechanismRead.sufficientData,
    reason: mechanismRead.reason ?? null,
  };
  if (!regimeRead.available) missingCritical.push("market regime");

  // ── Context quality ──
  const availableCount = [vixRead, fiiRead, breadthRead, regimeRead].filter((r) => r.available).length;
  const contextQuality: MarketContext["contextQuality"] =
    availableCount >= 3 ? "HIGH"
    : availableCount >= 2 ? "MEDIUM"
    : availableCount >= 1 ? "LOW"
    : "UNAVAILABLE";

  return {
    symbol,
    timestamp,
    vix: vixRead,
    fiiDii: fiiRead,
    sectorBreadth: breadthRead,
    regime: regimeRead,
    contextQuality,
    missingCritical,
  };
}
