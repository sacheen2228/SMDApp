// Structured market context for Jev — verified fields only.
// Missing data is null / unavailable — never fabricated with zeros as "real".

import type { HermesContext, OptionStrike } from "@/lib/hermes/types";

export type FieldAvailability = "AVAILABLE" | "UNAVAILABLE" | "STALE";

export interface FieldMeta {
  availability: FieldAvailability;
  freshness?: string;
  source?: string;
  ageMs?: number;
}

export interface JevOptionLeg {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface JevStrikeEvidence {
  strike: number;
  position: "ATM" | "ITM" | "OTM" | "UNKNOWN";
  ce: JevOptionLeg | null;
  pe: JevOptionLeg | null;
}

export interface JevNormalizedContext {
  schemaVersion: "jev-context-v1";
  symbol: string;
  exchange: string;
  instrument: string;
  marketStatus: string;
  timestamp: string;
  mode?: string;

  spot: {
    price: number | null;
    changePct: number | null;
    prevClose: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    meta: FieldMeta;
  };

  optionChain: {
    available: boolean;
    atmStrike: number | null;
    expiry: string | null;
    daysToExpiry: number | null;
    maxPain: number | null;
    pcrOI: number | null;
    totalCallOI: number | null;
    totalPutOI: number | null;
    callOiChange: number | null;
    putOiChange: number | null;
    callWall: number | null;
    putWall: number | null;
    futuresPrice: number | null;
    strikes: JevStrikeEvidence[];
    meta: FieldMeta;
  };

  greeks: {
    available: boolean;
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    iv: number | null;
    meta: FieldMeta;
  };

  gammaIntel: {
    available: boolean;
    dealerBias: string | null;
    regime: string | null;
    gammaWallStrike: number | null;
    meta: FieldMeta;
  };

  structure: {
    available: boolean;
    trend: string | null;
    swingHigh: number | null;
    swingLow: number | null;
    supportLevels: number[];
    resistanceLevels: number[];
    lastEvent: string | null;
    pdh: number | null;
    pdl: number | null;
    meta: FieldMeta;
  };

  volumeProfile: {
    available: boolean;
    poc: number | null;
    vah: number | null;
    val: number | null;
    totalVolume: number | null;
    meta: FieldMeta;
  };

  vix: { available: boolean; value: number | null; meta: FieldMeta };

  fiiDII: {
    available: boolean;
    fiiNet: number | null;
    diiNet: number | null;
    meta: FieldMeta;
  };

  regime: {
    available: boolean;
    regime: string | null;
    bias: string | null;
    meta: FieldMeta;
  };

  news: {
    available: boolean;
    sentiment: string | null;
    headlines: string[];
    meta: FieldMeta;
  };

  quality: {
    criticalFieldsAvailable: string[];
    criticalFieldsMissing: string[];
    overall: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  };

  /** Explicit non-authoritative note for the model */
  constraints: string[];
}

function metaFrom(
  fresh?: {
    freshness?: string;
    source?: string;
    ageMs?: number;
    status?: string;
    value?: unknown;
  },
  hasValue = true
): FieldMeta {
  if (!fresh || !hasValue) return { availability: "UNAVAILABLE" };
  const freshness = fresh.freshness;
  const stale =
    freshness === "STALE" ||
    freshness === "UNAVAILABLE" ||
    (typeof fresh.status === "string" && /error|unavailable|stale/i.test(fresh.status));
  return {
    availability: stale ? "STALE" : "AVAILABLE",
    freshness,
    source: fresh.source,
    ageMs: fresh.ageMs,
  };
}

function numOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function legFrom(side: OptionStrike["ce"] | undefined | null): JevOptionLeg | null {
  if (!side) return null;
  return {
    ltp: numOrNull(side.ltp),
    bid: numOrNull(side.bid),
    ask: numOrNull(side.ask),
    spread: numOrNull(side.spread),
    volume: numOrNull(side.volume),
    oi: numOrNull(side.oi),
    oiChange: numOrNull(side.oiChange),
    iv: numOrNull(side.iv),
    delta: numOrNull(side.delta),
    gamma: numOrNull(side.gamma),
    theta: numOrNull(side.theta),
    vega: numOrNull(side.vega),
  };
}

function classifyStrike(strike: number, atm: number | null): JevStrikeEvidence["position"] {
  if (atm == null || !Number.isFinite(atm)) return "UNKNOWN";
  if (strike === atm) return "ATM";
  return strike < atm ? "ITM" : "OTM";
}

function pickNearStrikes(strikes: OptionStrike[], atm: number | null, limit = 21): OptionStrike[] {
  if (!strikes.length) return [];
  if (atm == null) return strikes.slice(0, limit);
  return [...strikes]
    .sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm))
    .slice(0, limit);
}

/**
 * Build a normalized, non-fabricated context from HermesContext.
 * Only maps fields that exist; zeros that mean "missing" become null when
 * freshness indicates unavailable.
 */
export function buildJevContext(ctx: HermesContext): JevNormalizedContext {
  const spotFresh = ctx.spot;
  const spotVal = spotFresh?.value;
  const spotAvailable =
    !!spotVal && typeof spotVal.price === "number" && spotVal.price > 0 &&
    spotFresh.freshness !== "UNAVAILABLE";

  const chainFresh = ctx.optionChain;
  const chainVal = chainFresh?.value;
  const chainAvailable =
    !!chainVal && Array.isArray(chainVal.strikes) && chainVal.strikes.length > 0 &&
    chainFresh.freshness !== "UNAVAILABLE";

  const greeksFresh = ctx.greeks;
  const greeksVal = greeksFresh?.value;
  const greeksAvailable =
    !!greeksVal && greeksFresh.freshness !== "UNAVAILABLE" &&
    (numOrNull(greeksVal.delta) != null || numOrNull(greeksVal.iv) != null);

  const structFresh = ctx.marketStructure;
  const structVal = structFresh?.value;
  const structureAvailable = !!structVal && structFresh.freshness !== "UNAVAILABLE";

  const volFresh = ctx.volume;
  const volVal = volFresh?.value;
  const volumeAvailable = !!volVal && volFresh.freshness !== "UNAVAILABLE";

  const vixVal = ctx.vix?.value;
  const vixAvailable = numOrNull(vixVal) != null && ctx.vix?.freshness !== "UNAVAILABLE";

  const fiiVal = ctx.fiiDII?.value;
  const fiiAvailable = !!fiiVal && ctx.fiiDII?.freshness !== "UNAVAILABLE";

  const regimeVal = ctx.regime?.value;
  const regimeAvailable = !!regimeVal && ctx.regime?.freshness !== "UNAVAILABLE";

  const newsVal = ctx.news?.value;
  const newsAvailable = !!newsVal && ctx.news?.freshness !== "UNAVAILABLE";

  const gammaVal = ctx.gamma?.value;
  const gammaAvailable = !!gammaVal && ctx.gamma?.freshness !== "UNAVAILABLE";

  const atm = chainVal ? numOrNull(chainVal.atmStrike) : null;
  const nearStrikes = chainVal ? pickNearStrikes(chainVal.strikes || [], atm) : [];

  const criticalAvailable: string[] = [];
  const criticalMissing: string[] = [];
  if (spotAvailable) criticalAvailable.push("spot");
  else criticalMissing.push("spot");
  if (chainAvailable) criticalAvailable.push("option_chain");
  else criticalMissing.push("option_chain");
  if (greeksAvailable) criticalAvailable.push("greeks");
  else criticalMissing.push("greeks");
  if (structureAvailable) criticalAvailable.push("structure");
  else criticalMissing.push("structure");

  let overall: JevNormalizedContext["quality"]["overall"] = "HIGH";
  if (criticalMissing.length === 0) overall = "HIGH";
  else if (criticalMissing.length === 1 && criticalMissing[0] === "greeks") overall = "MEDIUM";
  else if (criticalMissing.includes("spot") || criticalMissing.includes("option_chain"))
    overall = criticalAvailable.length <= 1 ? "INSUFFICIENT" : "LOW";
  else overall = "MEDIUM";

  return {
    schemaVersion: "jev-context-v1",
    symbol: ctx.symbol,
    exchange: ctx.exchange,
    instrument: ctx.instrument,
    marketStatus: ctx.marketStatus,
    timestamp: ctx.timestamp,
    mode: ctx.mode,

    spot: {
      price: spotAvailable ? numOrNull(spotVal.price) : null,
      changePct: spotAvailable ? numOrNull(spotVal.changePct) : null,
      prevClose: spotAvailable ? numOrNull(spotVal.prevClose) : null,
      open: spotAvailable ? numOrNull(spotVal.open) : null,
      high: spotAvailable ? numOrNull(spotVal.high) : null,
      low: spotAvailable ? numOrNull(spotVal.low) : null,
      meta: metaFrom(spotFresh, spotAvailable),
    },

    optionChain: {
      available: chainAvailable,
      atmStrike: chainAvailable ? numOrNull(chainVal.atmStrike) : null,
      expiry: chainAvailable ? chainVal.expiry || null : null,
      daysToExpiry: chainAvailable ? numOrNull(chainVal.daysToExpiry) : null,
      maxPain: chainAvailable ? numOrNull(chainVal.maxPain) : null,
      pcrOI: chainAvailable ? numOrNull(chainVal.pcrOI) : null,
      totalCallOI: chainAvailable ? numOrNull(chainVal.totalCallOI) : null,
      totalPutOI: chainAvailable ? numOrNull(chainVal.totalPutOI) : null,
      callOiChange: chainAvailable ? numOrNull(chainVal.callOiChange) : null,
      putOiChange: chainAvailable ? numOrNull(chainVal.putOiChange) : null,
      callWall: chainAvailable ? numOrNull(chainVal.callWall) : null,
      putWall: chainAvailable ? numOrNull(chainVal.putWall) : null,
      futuresPrice: chainAvailable ? numOrNull(chainVal.futuresPrice) : null,
      strikes: nearStrikes.map((s) => ({
        strike: s.strike,
        position: classifyStrike(s.strike, atm),
        ce: legFrom(s.ce),
        pe: legFrom(s.pe),
      })),
      meta: metaFrom(chainFresh, chainAvailable),
    },

    greeks: {
      available: greeksAvailable,
      delta: greeksAvailable ? numOrNull(greeksVal.delta) : null,
      gamma: greeksAvailable ? numOrNull(greeksVal.gamma) : null,
      theta: greeksAvailable ? numOrNull(greeksVal.theta) : null,
      vega: greeksAvailable ? numOrNull(greeksVal.vega) : null,
      iv: greeksAvailable ? numOrNull(greeksVal.iv) : null,
      meta: metaFrom(greeksFresh, greeksAvailable),
    },

    gammaIntel: {
      available: gammaAvailable,
      dealerBias: gammaAvailable ? gammaVal.dealerBias ?? null : null,
      regime: gammaAvailable ? gammaVal.regime ?? null : null,
      gammaWallStrike: gammaAvailable ? numOrNull(gammaVal.gammaWallStrike) : null,
      meta: metaFrom(ctx.gamma, gammaAvailable),
    },

    structure: {
      available: structureAvailable,
      trend: structureAvailable ? structVal.trend ?? null : null,
      swingHigh: structureAvailable ? numOrNull(structVal.swingHigh) : null,
      swingLow: structureAvailable ? numOrNull(structVal.swingLow) : null,
      supportLevels: structureAvailable ? (structVal.supportLevels || []).map((n) => numOrNull(n)).filter((n): n is number => n != null) : [],
      resistanceLevels: structureAvailable ? (structVal.resistanceLevels || []).map((n) => numOrNull(n)).filter((n): n is number => n != null) : [],
      lastEvent: structureAvailable ? structVal.lastEvent ?? null : null,
      pdh: structureAvailable ? numOrNull(structVal.pdh) : null,
      pdl: structureAvailable ? numOrNull(structVal.pdl) : null,
      meta: metaFrom(structFresh, structureAvailable),
    },

    volumeProfile: {
      available: volumeAvailable,
      poc: volumeAvailable ? numOrNull(volVal.poc) : null,
      vah: volumeAvailable ? numOrNull(volVal.vah) : null,
      val: volumeAvailable ? numOrNull(volVal.val) : null,
      totalVolume: volumeAvailable ? numOrNull(volVal.totalVolume) : null,
      meta: metaFrom(volFresh, volumeAvailable),
    },

    vix: {
      available: vixAvailable,
      value: vixAvailable ? numOrNull(vixVal) : null,
      meta: metaFrom(ctx.vix, vixAvailable),
    },

    fiiDII: {
      available: fiiAvailable,
      fiiNet: fiiAvailable ? numOrNull(fiiVal.fiiNet) : null,
      diiNet: fiiAvailable ? numOrNull(fiiVal.diiNet) : null,
      meta: metaFrom(ctx.fiiDII, fiiAvailable),
    },

    regime: {
      available: regimeAvailable,
      regime: regimeAvailable ? (regimeVal as any).regime ?? null : null,
      bias: regimeAvailable ? (regimeVal as any).bias ?? null : null,
      meta: metaFrom(ctx.regime, regimeAvailable),
    },

    news: {
      available: newsAvailable,
      sentiment: newsAvailable ? (newsVal as any).sentiment ?? null : null,
      headlines: newsAvailable
        ? ((newsVal as any).headlines || []).slice(0, 5).map((h: any) =>
            typeof h === "string" ? h : String(h?.title || "")
          ).filter(Boolean)
        : [],
      meta: metaFrom(ctx.news, newsAvailable),
    },

    quality: {
      criticalFieldsAvailable: criticalAvailable,
      criticalFieldsMissing: criticalMissing,
      overall,
    },

    constraints: [
      "Options: BUY_CE, BUY_PE, or NO_TRADE only. Never SELL options.",
      "This evidence is research input only. Entry, SL, TP, strike, and size come from deterministic engines.",
      "If data is missing or conflicting, prefer NO_TRADE.",
      "Do not invent prices, OI, Greeks, PCR, volume, or VIX.",
    ],
  };
}

/** Compact state string for Jev (JSON with critical missing fields noted). */
export function jevStatePayload(ctx: JevNormalizedContext): string {
  return JSON.stringify(ctx);
}
