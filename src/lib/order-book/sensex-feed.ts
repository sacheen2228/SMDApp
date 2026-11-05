/**
 * Order Book feed — SENSEX futures via the local MO API sidecar
 * (moapi-service on 127.0.0.1:8781).
 *
 * The MO REST surface has no market-depth endpoint, so depth comes from the
 * broadcast websocket feed the service maintains (registered for the default
 * symbols). A FUTURE contract (the SENSEX future) is not in the default
 * subscription list, so the service registers it on demand + waits for the
 * first depth packet — see moapi-service/moapi/service.py `depth()`.
 *
 * Lot sizes / expiries come from the MO instrument master (`/instrument?symbol=BSX`).
 */

import { fetchServiceDepth, fetchServiceInstruments, fetchServiceLTP } from "@/lib/motilal/service";
import { FRESH_MS } from "./nifty-feed";
import type { BookSnapshot } from "./types";

export interface SensexContract {
  tradingsymbol: string;
  expiry: string;
  lotSize: number;
}

let contractCache: { contract: SensexContract | null; resolveTs: number } = {
  contract: null,
  resolveTs: 0,
};

const CONTRACT_TTL_MS = 10 * 60 * 1000;

function isSensexFutures(row: any): boolean {
  const sym = String(row?.symbol ?? "").toUpperCase();
  const ts = String(row?.tradingsymbol ?? "").toUpperCase();
  const it = String(row?.instrumentType ?? row?.instrumenttype ?? "").toUpperCase();
  const type = String(row?.instrument_type ?? row?.instrumenttype ?? "").toUpperCase();
  const isFUT = it === "FUT" || it === "FUTSTK" || type === "FUT" || type === "FUTSTK";
  const isBSX =
    sym === "BSX" || ts.startsWith("BSX") || ts === "SENSEX";
  if (!isFUT) return false;
  if (!isBSX) return false;
  const expiry = String(row?.expiry ?? row?.expiryDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return false;
  return true;
}

async function resolveSensexFuture(): Promise<SensexContract | null> {
  const now = Date.now();
  if (
    contractCache.contract &&
    now - contractCache.resolveTs < CONTRACT_TTL_MS
  ) {
    return contractCache.contract;
  }
  const rows = await fetchServiceInstruments(false, "BSX");
  let best: SensexContract | null = null;
  let bestExpiry = "";
  let bestTs = Infinity;
  if (rows) {
    for (const r of rows) {
      if (!isSensexFutures(r)) continue;
      const expiry = String(r.expiry ?? "");
      const t = Date.parse(expiry + "T00:00:00");
      if (Number.isNaN(t)) continue;
      if (t < new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()) {
        continue; // expiry must be >= today (IST)
      }
      if (t < bestTs) {
        bestTs = t;
        best = {
          tradingsymbol: String(r.tradingsymbol ?? ""),
          expiry,
          lotSize: Number(r.lotSize ?? 0) || 0,
        };
      }
    }
  }
  const contract = best;
  contractCache = { contract, resolveTs: now };
  return contract;
}

function toMs(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // unix seconds (≈1.7e9) vs ms (≈1.7e12)
  return n > 1e12 ? n : n * 1000;
}

let sensexSnap: BookSnapshot | null = null;

export async function fetchSensexBook(): Promise<BookSnapshot | null> {
  const contract = await resolveSensexFuture();
  if (!contract || !contract.tradingsymbol) return null;

  const depth = await fetchServiceDepth(contract.tradingsymbol);
  if (!depth || !depth.bids?.length || !depth.asks?.length) return null;

  const ltpRes = await fetchServiceLTP(contract.tradingsymbol);
  const ltp = ltpRes?.ltp;
  if (!ltp) return null;

  const dataTs = toMs((depth as any).dataTs ?? (depth as any).ts);
  if (!dataTs || Date.now() - dataTs > FRESH_MS) return null;

  const bids = depth.bids as Array<[number, number]>;
  const asks = depth.asks as Array<[number, number]>;
  const now = Date.now();
  const prev = sensexSnap;
  sensexSnap = {
    ltp,
    expiry: contract.expiry || "",
    low: prev?.low || ltp,
    high: prev?.high || ltp,
    bids,
    asks,
    levels: Math.max(bids.length, asks.length),
    ts: now,
  };
  if (ltp > sensexSnap.high) sensexSnap.high = ltp;
  if (ltp < sensexSnap.low) sensexSnap.low = ltp;
  return sensexSnap;
}
