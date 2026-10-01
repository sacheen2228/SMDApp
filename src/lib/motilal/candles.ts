// Motilal Oswal candle access via OpenAPI.
//
// PLATFORM CAPABILITY (live-verified 2026-09-27 against the API itself, not just docs):
// - MO exposes NO intraday candle endpoint. The only OHLC history endpoint is
//     POST /rest/report/v3/geteoddatabyexchangename
//   (the documented /v1 path returns MO8001 "Invalid Token" on EVERY /rest/report/v1/*
//    endpoint even with a freshly verified session — v1 report auth is broken/deprecated
//    for this account; v3 accepts the same headers. Do NOT call v1: its auth-shaped
//    error would fake a SESSION_EXPIRED classification on a live session.)
// - Exchange NSE  → equity SPOT daily bars (~9s, 5.4k rows, docs schema). REAL.
// - Exchange NSEFO → derivatives only (82k rows, 80-128s, ZERO spot rows — every row
//   has an expiry). NEVER valid for spot candles; calling it would return option
//   contracts as if they were the underlying. Not used.
// - Index spot OHLC: NOT AVAILABLE anywhere on MO (IndexDataAPI = index code list only;
//   EOD has no index rows). Index symbols fail fast with a capability message →
//   session-health classifies SOURCE_UNAVAILABLE (never an alert).
// - Intraday: NOT supported; the candle chain records SOURCE_UNAVAILABLE for MO and
//   moves on (never substitutes daily bars for 1m).
// Auth: same session headers as every other /rest/report call (see market.ts getHeaders),
// so session expiry here is the standard MO auth flow (autoLogin TOTP-first recovery
// lives in the candle chain).
import { MOTILAL_CONFIG } from "./auth";
import { KNOWN_SCRIPS, getHeaders } from "./market";

export interface MOCandle {
  time: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Only daily-capable. Intraday is a capability skip, not an error.
export function moSupportsInterval(interval: string): boolean {
  return ["1day", "1d", "daily", "day"].includes(String(interval).toLowerCase());
}

function parseEODDate(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  let y = 0, m = 0, day = 0;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); // 2026-09-25
  if (mm) { y = +mm[1]; m = +mm[2]; day = +mm[3]; }
  if (!y && (mm = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s))) { day = +mm[1]; m = +mm[2]; y = +mm[3]; } // 25-09-2026
  if (!y && (mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) { day = +mm[1]; m = +mm[2]; y = +mm[3]; } // 25/09/2026
  if (!y) return null;
  // Daily bars close at 15:30 IST.
  return new Date(Date.UTC(y, m - 1, day, 10, 0, 0)).toISOString(); // 15:30 IST = 10:00 UTC
}

function num(v: any): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function rowToCandle(row: any): MOCandle | null {
  const time = parseEODDate(row.date ?? row.Date ?? row.tradeDate ?? row.datetime);
  if (!time) return null;
  const open = num(row.open ?? row.Open ?? row.o);
  const high = num(row.high ?? row.High ?? row.h);
  const low = num(row.low ?? row.Low ?? row.l);
  const close = num(row.close ?? row.Close ?? row.c);
  if (!open && !high && !low && !close) return null;
  return {
    time,
    open, high, low, close,
    volume: num(row.volume ?? row.Volume ?? row.v ?? row["totalTradedQty"] ?? 0),
  };
}

async function fetchEOD(exchange: string, symbol: string): Promise<MOCandle[]> {
  const res = await fetch(
    `${MOTILAL_CONFIG.BASE_URL}/rest/report/v3/geteoddatabyexchangename`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ exchangename: exchange }),
      signal: AbortSignal.timeout(30000),
    }
  );
  const json: any = await res.json().catch(() => null);
  if (!json) throw new Error(`MO EOD (${exchange}) HTTP ${res.status}: non-JSON response`);
  if (json.status === "ERROR" || json.status !== "SUCCESS") {
    // e.g. "Invalid Token" / "Your Auth Token is not verified" — messages the
    // candle chain classifies as SESSION_EXPIRED (mo).
    throw new Error(`MO EOD (${exchange}): ${json.message || json.error || json.status}`);
  }
  const rows = Array.isArray(json.data) ? json.data : [];
  const want = symbol.toUpperCase();
  const scripcode = KNOWN_SCRIPS[symbol.toUpperCase()]?.code;
  const matched = rows.filter((r: any) => {
    const name = String(r.scripshortname ?? r.ScripShortName ?? r.symbol ?? "").toUpperCase();
    if (name === want) return true;
    if (scripcode && num(r.scripcode ?? r.Scripcode) === scripcode) return true;
    return false;
  });
  const candles: MOCandle[] = [];
  for (const r of matched) {
    const c = rowToCandle(r);
    if (c) candles.push(c);
  }
  candles.sort((a, b) => a.time.localeCompare(b.time));
  return candles;
}

// Symbols MO can never serve as spot candles — fail fast (no network call) with a
// capability message the session-health classifier maps to SOURCE_UNAVAILABLE.
const INDEX_SPOT_UNSUPPORTED: Record<string, string> = {
  NIFTY: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  NIFTY50: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  BANKNIFTY: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  FINNIFTY: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  MIDCPNIFTY: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  SENSEX: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
  BANKEX: "MO OpenAPI has no index spot OHLC — IndexDataAPI is a code list and the NSEFO dump is derivatives-only (capability)",
};

// Daily SPOT bars for one symbol from the NSE equity EOD dump.
// Throws with a human-readable message on failure:
//   index/unsupported symbol → capability (classified SOURCE_UNAVAILABLE)
//   unknown symbol           → "no rows" (classified NO_DATA)
//   auth/session problems    → raw MO message (classified SESSION_EXPIRED)
export async function getMOCandles(symbol: string): Promise<MOCandle[]> {
  const key = symbol.toUpperCase();
  const cap = INDEX_SPOT_UNSUPPORTED[key];
  if (cap) throw new Error(cap);
  const candles = await fetchEOD("NSE", symbol);
  if (!candles.length) throw new Error(`MO EOD has no rows for ${key} on NSE`);
  return candles;
}
