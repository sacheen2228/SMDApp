// quant-data.ts — validated data access with provenance + freshness for the
// UNIVERSAL_QUANT_V1 engine.
//
// ISOLATION: read-only wrappers over the canonical data layer. Every wrapper
// is non-throwing — on any failure the data is null/absent and the
// observation says UNAVAILABLE. Never fabricates or substitutes data.
//
// Freshness policy: age is measured from the PROVIDER's own timestamp
// (chain.asOf / last candle ts). A present-but-undated payload is reported
// STALE (unverifiable age is never called FRESH).

import {
  getOptionChain,
  getExchangeForSymbol,
  type CanonicalOptionChain,
} from "@/lib/data-layer/chains/option-chain";
import { getNSEIndiaVIX, getNSEIndexQuote } from "@/lib/nse-api";
import { QUANT_FLAGS } from "./quant-config";
import { quantFetchCandles, normalizeInterval } from "./quant-candles";
import type { QuantObservation } from "./quant-types";

const IST_OFFSET_MIN = 330;

/** IST-aware ISO 8601 (fixed UTC+05:30, e.g. "2026-10-25T10:00:00.000+05:30"). */
export function istIso(tsMs: number): string {
  return new Date(tsMs + IST_OFFSET_MIN * 60_000).toISOString().replace("Z", "+05:30");
}

/** IST wall-clock day key "YYYY-MM-DD" — used for per-day dedupe keys. */
export function istDayKey(tsMs: number): string {
  return new Date(tsMs + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

function qualityFor(ageMs: number | null, maxMs: number): "FRESH" | "STALE" {
  if (ageMs == null) return "STALE"; // undated payload — never claimed fresh
  return ageMs <= maxMs ? "FRESH" : "STALE";
}

function unavailableObservation(
  source: string,
  symbol: string,
  collectedAt: string,
  contractId: string,
): QuantObservation {
  return {
    source,
    symbol,
    exchange: getExchangeForSymbol(symbol),
    providerTimestamp: null,
    collectedAt,
    ageMs: null,
    quality: "UNAVAILABLE",
    contractId,
  };
}

// ── Option chain ─────────────────────────────────────────────────────

export async function getQuantOptionChain(
  symbol: string,
  expiry?: string,
): Promise<{ chain: CanonicalOptionChain | null; observation: QuantObservation }> {
  const collectedAt = istIso(Date.now());
  const contractId = `${symbol}:${expiry ?? "-"}:chain`;
  try {
    const result = await getOptionChain(symbol, expiry);
    const chain = result?.data ?? null;
    if (!chain) {
      return {
        chain: null,
        observation: unavailableObservation(result?.source ?? "NO_DATA", symbol, collectedAt, contractId),
      };
    }
    const providerTimestamp = chain.asOf ?? null;
    const ageMs = providerTimestamp
      ? Math.max(0, Date.now() - Date.parse(providerTimestamp)) || null
      : null;
    return {
      chain,
      observation: {
        source: chain.source,
        symbol,
        exchange: getExchangeForSymbol(symbol),
        providerTimestamp,
        collectedAt,
        ageMs,
        quality: qualityFor(ageMs, QUANT_FLAGS.chainFreshnessMaxMs),
        contractId: `${symbol}:${chain.expiry ?? "-"}:${chain.source}`,
      },
    };
  } catch {
    return { chain: null, observation: unavailableObservation("ERROR", symbol, collectedAt, contractId) };
  }
}

// ── Candles ──────────────────────────────────────────────────────────

export async function getQuantCandles(
  symbol: string,
  interval: string,
): Promise<{
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  observation: QuantObservation;
}> {
  const collectedAt = istIso(Date.now());
  const date = istDayKey(Date.now());
  const contractId = `${symbol}:${interval}:candles`;
  try {
    const r = await quantFetchCandles(symbol, date, normalizeInterval(interval));
    const candles = r.candles ?? [];
    if (r.source === "none" || candles.length === 0) {
      return { candles: [], observation: unavailableObservation(r.source, symbol, collectedAt, contractId) };
    }
    const last = candles[candles.length - 1];
    const ageMs = Math.max(0, Date.now() - Date.parse(last.timestamp)) || null;
    let quality = qualityFor(ageMs, QUANT_FLAGS.candleFreshnessMaxMs);
    // Spec policy: degraded capture (e.g. close-only points) is never FRESH.
    if (r.degraded !== null) quality = "STALE";
    return {
      candles,
      observation: {
        source: r.source,
        symbol,
        exchange: getExchangeForSymbol(symbol),
        providerTimestamp: last.timestamp,
        collectedAt,
        ageMs,
        quality,
        contractId: `${symbol}:${interval}:candles:${r.source}`,
      },
    };
  } catch {
    return { candles: [], observation: unavailableObservation("ERROR", symbol, collectedAt, contractId) };
  }
}

// ── Spot ─────────────────────────────────────────────────────────────

/**
 * Spot price: NSE index quote first (no provider timestamp → unverifiable
 * age is reported STALE, never FRESH), then the canonical chain's own spot
 * (which carries asOf — real age). Null + UNAVAILABLE when both fail.
 */
export async function getQuantSpot(
  symbol: string,
): Promise<{ spot: number | null; observation: QuantObservation }> {
  const collectedAt = istIso(Date.now());
  const contractId = `${symbol}:spot`;
  try {
    const q = await getNSEIndexQuote(symbol);
    if (q && Number.isFinite(q.regularMarketPrice) && q.regularMarketPrice > 0) {
      return {
        spot: q.regularMarketPrice,
        observation: {
          source: "NSE_INDEX",
          symbol,
          exchange: getExchangeForSymbol(symbol),
          providerTimestamp: null,
          collectedAt,
          ageMs: null,
          quality: "STALE", // age unverifiable — honest label
          contractId,
        },
      };
    }
  } catch {
    // fall through to the chain
  }
  const { chain, observation } = await getQuantOptionChain(symbol);
  if (chain && chain.spot != null && Number.isFinite(chain.spot) && chain.spot > 0) {
    return { spot: chain.spot, observation: { ...observation, contractId } };
  }
  return { spot: null, observation: { ...observation, quality: "UNAVAILABLE", contractId } };
}

// ── India VIX ────────────────────────────────────────────────────────

export async function getQuantVix(): Promise<{
  value: number | null;
  change: number | null;
  observation: QuantObservation;
}> {
  const collectedAt = istIso(Date.now());
  const contractId = "INDIA_VIX:vix";
  try {
    const v = await getNSEIndiaVIX();
    if (v && Number.isFinite(v.value) && v.value > 0) {
      return {
        value: v.value,
        change: Number.isFinite(v.change) ? v.change : null,
        observation: {
          source: "NSE_INDIA_VIX",
          symbol: "INDIA_VIX",
          exchange: "NSE",
          providerTimestamp: null,
          collectedAt,
          ageMs: null,
          quality: "STALE", // age unverifiable — honest label
          contractId,
        },
      };
    }
  } catch {
    // fall through
  }
  return { value: null, change: null, observation: unavailableObservation("NSE_INDIA_VIX", "INDIA_VIX", collectedAt, contractId) };
}
