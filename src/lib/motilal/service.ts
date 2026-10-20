// ── MOAPI SERVICE CLIENT ────────────────────────────────────────────────────
// The local Motilal OpenAPI service (official Python SDK, read-only) is the
// FIRST rung of the Motilal price chain (see ./quote.ts):
//
//     MOAPI service → direct Motilal REST (./market.ts) → NSE → unavailable
//
// THE SERVICE IS OPTIONAL. When MOAPI_SERVICE_URL is not set every function
// below returns null WITHOUT touching the network — the app then behaves
// EXACTLY as it did before the service existed (the direct REST client is
// the only Motilal path). Nothing here ever fabricates a value: a failed
// call returns null and the caller falls through to the next rung.
//
// CONTRACT (the service exposes EXACTLY this):
//   GET  /health                → {ok, authed, source, ts, error?}
//   GET  /instrument            → {ok, ts, instruments:[{tradingsymbol, exchange,
//                                 expiry, lotSize, instrumentType, symbol, strike,
//                                 optionType}]}
//   GET  /ltp?tradingsymbol=X   → {ok, ts, tradingsymbol, ltp, source}
//   GET  /oi?tradingsymbol=X    → {ok, ts, tradingsymbol, oi, oiChange, source}
//   GET  /depth?tradingsymbol=X → {ok, ts, tradingsymbol, bids:[[p,q]], asks:[[p,q]]}
//   Errors: {ok:false, error:"…"} with HTTP 503.
//
// A 503 (the service cannot serve it) and a refused connection (the service
// is down) are the SAME thing to the caller: this rung did not produce a
// value → fall through. The service is never allowed to break a caller.

import { applyServiceInstruments } from "../symbol-config";

// ── Config ───────────────────────────────────────────────────────────────────
/** The service must never hold a caller hostage — 2.5s then fall through. */
export const SERVICE_TIMEOUT_MS = 2500;
/** The instrument master changes once a day — 30 minutes is generous. */
export const INSTRUMENTS_CACHE_TTL_MS = 30 * 60 * 1000;
/** /health is a cheap probe; do not hammer it. */
export const HEALTH_CACHE_TTL_MS = 10 * 1000;

/** The service base URL (no trailing slash). "" when the service is off. */
export function getServiceUrl(): string {
  return String(process.env.MOAPI_SERVICE_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

/** Is the MOAPI service configured at all? */
export function isServiceConfigured(): boolean {
  return getServiceUrl().length > 0;
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface ServiceHealth {
  ok: boolean;
  authed: boolean;
  source: string;
  ts: number | string;
  error?: string;
}

export interface ServiceInstrument {
  tradingsymbol: string;
  exchange: string;
  expiry: string;
  lotSize: number;
  instrumentType: string;
  symbol: string;
  strike: number;
  optionType: string;
}

export interface ServiceLTP {
  ok: boolean;
  ts: number | string;
  tradingsymbol: string;
  ltp: number;
  source: string;
}

export interface ServiceOI {
  ok: boolean;
  ts: number | string;
  tradingsymbol: string;
  oi: number;
  oiChange: number;
  source: string;
}

export interface ServiceDepth {
  ok: boolean;
  ts: number | string;
  tradingsymbol: string;
  /** [price, quantity] pairs, best first. */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

// ── Cache ───────────────────────────────────────────────────────────────────
type CacheEntry<T> = { data: T; ts: number };

let instrumentsCache: CacheEntry<ServiceInstrument[]> | null = null;
let healthCache: CacheEntry<ServiceHealth> | null = null;

/** Drop the in-memory caches (the instrument master / the health probe). */
export function resetServiceCache(): void {
  instrumentsCache = null;
  healthCache = null;
}

// ── The one HTTP call ───────────────────────────────────────────────────────
/**
 * GET a service endpoint. Returns the parsed body, or null for ANY failure:
 * the service is not configured, the connection was refused, the call timed
 * out, the status was not 2xx, the body was not JSON, or the body said
 * `{ok:false}` (the service's own error shape). It never throws.
 */
async function serviceGet<T = any>(
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T | null> {
  const base = getServiceUrl();
  if (!base) return null;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}${suffix}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) return null; // 503 / 404 / 500 → this rung produced nothing
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return null;
    if (json.ok === false) return null; // the service's error shape
    return json as T;
  } catch {
    // Down, refused, DNS failure, timeout, abort → null (fall through).
    return null;
  }
}

// ── /health ─────────────────────────────────────────────────────────────────
/**
 * The service's auth/feed state. null when the service is not configured or
 * not reachable — the caller then simply uses the next rung.
 */
export async function fetchServiceHealth(): Promise<ServiceHealth | null> {
  if (!isServiceConfigured()) return null;

  const cached = healthCache;
  if (cached && Date.now() - cached.ts < HEALTH_CACHE_TTL_MS) return cached.data;

  const json = await serviceGet<any>("/health");
  if (!json) return null;

  const authed = Boolean(
    json.authed ?? json.auth?.verified ?? json.auth?.authed ?? json.auth?.ok ?? false
  );
  const health: ServiceHealth = {
    ok: json.ok !== false,
    authed,
    source: String(json.source || "moapi-service"),
    ts: json.ts ?? Date.now(),
    ...(json.error ? { error: String(json.error) } : {}),
  };
  healthCache = { data: health, ts: Date.now() };
  return health;
}

// ── /instrument ─────────────────────────────────────────────────────────────
function normalizeInstrument(row: any): ServiceInstrument | null {
  if (!row || typeof row !== "object") return null;
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const tradingsymbol = String(row.tradingsymbol ?? "").trim().toUpperCase();
  if (!symbol && !tradingsymbol) return null;
  return {
    tradingsymbol,
    exchange: String(row.exchange ?? "").trim().toUpperCase(),
    expiry: String(row.expiry ?? "").trim(),
    lotSize: Number(row.lotSize ?? row.lotsize ?? 0) || 0,
    instrumentType: String(row.instrumentType ?? row.instrumenttype ?? "").trim().toUpperCase(),
    symbol,
    strike: Number(row.strike ?? row.strikePrice ?? 0) || 0,
    optionType: String(row.optionType ?? row.optiontype ?? "").trim().toUpperCase(),
  };
}

/**
 * The instrument master (cached 30 minutes). null when the service is off
 * or has no master.
 *
 * The master is ALSO the authoritative lot-size source (the live exchange
 * contract list), so a successful fetch feeds the lot sizes into
 * symbol-config — see applyServiceInstruments() there.
 */
export async function fetchServiceInstruments(force = false): Promise<ServiceInstrument[] | null> {
  if (!isServiceConfigured()) return null;

  const cached = instrumentsCache;
  if (!force && cached && Date.now() - cached.ts < INSTRUMENTS_CACHE_TTL_MS) {
    return cached.data;
  }

  const json = await serviceGet<any>("/instrument");
  if (!json) return null;

  const rows = Array.isArray(json.instruments) ? json.instruments : [];
  const data = rows
    .map((r: any) => normalizeInstrument(r))
    .filter((r: ServiceInstrument | null): r is ServiceInstrument => r !== null);
  if (!data.length) return null; // an empty master is not a usable master

  instrumentsCache = { data, ts: Date.now() };
  applyServiceInstruments(data);
  return data;
}

// ── /ltp ────────────────────────────────────────────────────────────────────
/**
 * The live premium / index price for a tradingsymbol. null when the service
 * is off, the contract is unknown, or the price is not a positive number —
 * a non-positive price is never returned as a "price".
 */
export async function fetchServiceLTP(tradingsymbol: string): Promise<ServiceLTP | null> {
  const ts = String(tradingsymbol || "").trim().toUpperCase();
  if (!ts || !isServiceConfigured()) return null;

  const json = await serviceGet<any>("/ltp", { tradingsymbol: ts });
  if (!json) return null;

  const ltp = Number(json.ltp ?? json.lastPrice ?? 0);
  if (!Number.isFinite(ltp) || ltp <= 0) return null;

  return {
    ok: true,
    ts: json.ts ?? Date.now(),
    tradingsymbol: String(json.tradingsymbol || ts),
    ltp,
    source: String(json.source || "moapi-service"),
  };
}

// ── /oi ─────────────────────────────────────────────────────────────────────
/** The last open interest for a tradingsymbol (a websocket feed value). */
export async function fetchServiceOI(tradingsymbol: string): Promise<ServiceOI | null> {
  const ts = String(tradingsymbol || "").trim().toUpperCase();
  if (!ts || !isServiceConfigured()) return null;

  const json = await serviceGet<any>("/oi", { tradingsymbol: ts });
  if (!json) return null;

  const oi = Number(json.oi ?? json.openInterest ?? 0);
  if (!Number.isFinite(oi)) return null;

  return {
    ok: true,
    ts: json.ts ?? Date.now(),
    tradingsymbol: String(json.tradingsymbol || ts),
    oi,
    oiChange: Number(json.oiChange ?? json.change ?? 0) || 0,
    source: String(json.source || "moapi-service"),
  };
}

// ── /depth ──────────────────────────────────────────────────────────────────
function normalizeLevels(raw: any): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const row of raw) {
    if (Array.isArray(row) && row.length >= 2) {
      const price = Number(row[0]);
      const qty = Number(row[1]);
      if (Number.isFinite(price) && Number.isFinite(qty)) out.push([price, qty]);
      continue;
    }
    if (row && typeof row === "object") {
      const price = Number(row.price ?? row.bidPrice ?? row.askPrice ?? 0);
      const qty = Number(row.quantity ?? row.qty ?? row.bidQty ?? row.askQty ?? 0);
      if (Number.isFinite(price) && Number.isFinite(qty) && price > 0) out.push([price, qty]);
    }
  }
  return out;
}

/** The 5-level market depth for a tradingsymbol (a websocket feed value). */
export async function fetchServiceDepth(tradingsymbol: string): Promise<ServiceDepth | null> {
  const ts = String(tradingsymbol || "").trim().toUpperCase();
  if (!ts || !isServiceConfigured()) return null;

  const json = await serviceGet<any>("/depth", { tradingsymbol: ts });
  if (!json) return null;

  let bids = normalizeLevels(json.bids);
  let asks = normalizeLevels(json.asks);

  // The service may publish the depth as a list of levels instead of two
  // side-lists — split them (a level carries both a bid and an ask).
  if (!bids.length && !asks.length && Array.isArray(json.levels)) {
    for (const level of json.levels) {
      if (!level || typeof level !== "object") continue;
      const bid = [Number(level.bidPrice ?? 0), Number(level.bidQty ?? level.bidQuantity ?? 0)];
      const ask = [Number(level.askPrice ?? 0), Number(level.askQty ?? level.askQuantity ?? 0)];
      if (bid[0] > 0 && bid[1] > 0) bids.push([bid[0], bid[1]] as [number, number]);
      if (ask[0] > 0 && ask[1] > 0) asks.push([ask[0], ask[1]] as [number, number]);
    }
  }

  return {
    ok: true,
    ts: json.ts ?? Date.now(),
    tradingsymbol: String(json.tradingsymbol || ts),
    bids,
    asks,
  };
}
