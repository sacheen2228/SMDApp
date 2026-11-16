/// NSE MCP Research Layer — Strict Field Whitelisting & Normalization
///
/// Pure functions. Zero HTTP. Zero DB writes.
/// Only the fields listed in the whitelists are accepted.
/// Any other top-level key (optionChain, greeks, iv, pcr, oi, bid, ask, etc.)
/// causes the entire record to be rejected (null returned).

import { McpFreshness, McpSource } from "./mcp-types";

// ──────────────────────────────────────────────────────────────
// MCP Reference Quote — Whitelist
const REF_QUOTE_ALLOWED_KEYS = ["symbol", "spotPrice", "changePct", "volume", "timestamp", "open", "high", "low", "expiryDate", "openInterest", "totalTradedQuantity", "markedPrice"];
const REF_QUOTE_REJECTED_KEYS = ["optionChain", "greeks", "iv", "pcr", "oi", "bid", "ask"];

// ──────────────────────────────────────────────────────────────
// normalizeMarketData
//
// Returns McpReferenceQuote | null.
// Zero HTTP. Zero DB. Pure function.
//──────────────────────────────────────────────────────────────

export function normalizeMarketData(raw: any): McpReferenceQuote | null {
  if (raw == null || typeof raw !== "object") return null;

  const keys = Object.keys(raw);
  if (keys.length === 0) return null;

  // Reject any key not in the allowed set or in the rejected set
  for (const key of keys) {
    if (REF_QUOTE_REJECTED_KEYS.includes(key)) return null;
    if (!REF_QUOTE_ALLOWED_KEYS.includes(key)) return null;
    // Nested/child object values → reject
    const value = raw[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return null;
    if (Array.isArray(value)) return null;
  }

  // Extract and validate critical fields
  const symbol = String(raw.symbol || "").trim();
  const spotPrice = Number(raw.spotPrice);
  const changePct = Number(raw.changePct);
  const volume = Number(raw.volume);
  const timestamp = String(raw.timestamp || "");

  if (!symbol) return null;
  if (!isFinite(spotPrice) || spotPrice <= 0) return null;
  if (!isFinite(changePct)) return null;
  if (!timestamp) return null;

  // Build and return the normalized quote
  return {
    symbol,
    spotPrice,
    changePct,
    volume,
    timestamp,
    freshness: McpFreshness.UNKNOWN,
    source: McpSource.NSE_MCP,
    collectionTimestamp: new Date().toISOString(),
    // Optional fields — undefined if not present
    open: raw.open !== undefined ? Number(raw.open) : undefined,
    high: raw.high !== undefined ? Number(raw.high) : undefined,
    low: raw.low !== undefined ? Number(raw.low) : undefined,
    expiryDate: raw.expiryDate !== undefined ? String(raw.expiryDate) : undefined,
    openInterest: raw.openInterest !== undefined ? Number(raw.openInterest) : undefined,
    totalTradedQuantity: raw.totalTradedQuantity !== undefined ? Number(raw.totalTradedQuantity) : undefined,
    markedPrice: raw.markedPrice !== undefined ? Number(raw.markedPrice) : undefined,
    provenance: {
      collector: "mcp-normalization",
      httpStatus: 0,
      cacheKey: "",
      fetchDurationMs: 0,
      errorType: undefined,
    },
  } as McpReferenceQuote;
}

// ──────────────────────────────────────────────────────────────
// McpBhavcopyEod — Whitelist
const BHAV_ALLOWED_KEYS = ["symbolIdentifier", "expiryDate", "openInterest", "totalTradedQuantity", "markedPrice"];
const BHAV_REJECTED_KEYS = ["optionChain", "iv", "pcr"];

// ──────────────────────────────────────────────────────────────
// normalizeBhavcopyEod
//
// Returns McpBhavcopyEod[] (one or more records).
// Zero HTTP. Zero DB.
// Any non-whitelisted or rejected key → entire result is [] (empty).
//──────────────────────────────────────────────────────────────

export function normalizeBhavcopyEod(raw: any): McpBhavcopyEod[] {
  if (raw == null || typeof raw !== "object") return [];

  // Normalize to array of items
  const items = Array.isArray(raw) ? raw : [raw];
  const results: McpBhavcopyEod[] = [];

  for (const item of items) {
    if (item == null || typeof item !== "object") continue;

    const keys = Object.keys(item);
    if (keys.length === 0) continue;

    // Validate keys — if any key is rejected, discard this entire item
    let rejected = false;
    for (const key of keys) {
      if (BHAV_REJECTED_KEYS.includes(key)) { rejected = true; break; }
      if (!BHAV_ALLOWED_KEYS.includes(key)) { rejected = true; break; }
      // Nested object/array values → discard this item
      const value = item[key];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) { rejected = true; break; }
      if (Array.isArray(value)) { rejected = true; break; }
    }

    if (rejected) continue; // skip this item, try next

    // Build the normalized record for this valid item
    const normalized: McpBhavcopyEod = {
      symbolIdentifier: String(item.symbolIdentifier || "").trim(),
      expiryDate: String(item.expiryDate || ""),
      openInterest: Number(item.openInterest),
      totalTradedQuantity: Number(item.totalTradedQuantity),
      markedPrice: Number(item.markedPrice),
      timestamp: String(item.timestamp || new Date().toISOString()),
      freshness: McpFreshness.UNKNOWN,
      source: McpSource.NSE_MCP,
      collectionTimestamp: new Date().toISOString(),
      provenance: {
        collector: "mcp-normalization",
        httpStatus: 0,
        cacheKey: "",
        fetchDurationMs: 0,
        errorType: undefined,
      },
    };

    results.push(normalized);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────
// Export test-visible helpers
//──────────────────────────────────────────────────────────────

export { REF_QUOTE_ALLOWED_KEYS, REF_QUOTE_REJECTED_KEYS };
export { BHAV_ALLOWED_KEYS, BHAV_REJECTED_KEYS };
