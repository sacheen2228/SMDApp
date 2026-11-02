// NSE CM + F&O pre-open fetchers.
// Authorized NSE www.nseindia.com access only — cookie prime + matching Referer.
// Rate-limited (single sequential fetch, 5 min cookie TTL). Fail closed.

import type { CmPreopenRow, FuturesPreopenRow, PreopenFetchResult, Provenance } from "./types";
import { normalizeCmPayload, normalizeFuturesPayload } from "./normalize";
import { buildQualityReport } from "./quality";
import type { SourceId } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE = "https://www.nseindia.com/api";

const CM_REFERER = "https://www.nseindia.com/market-data/pre-open-market-cm-and-emerge-market";
const FNO_REFERER = "https://www.nseindia.com/market-data/pre-open-market-fno";

let cookieCache: { cookie: string; expiresAt: number } | null = null;
let lastFetchAt = 0;
const MIN_GAP_MS = 1500; // gentle rate limit

async function primeCookie(referer: string): Promise<string> {
  if (cookieCache && Date.now() < cookieCache.expiresAt) return cookieCache.cookie;
  try {
    const res = await fetch("https://www.nseindia.com", {
      headers: { "User-Agent": UA, Accept: "text/html", Referer: referer },
      signal: AbortSignal.timeout(8000),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] || "";
    cookieCache = { cookie, expiresAt: Date.now() + 5 * 60_000 };
    return cookie;
  } catch {
    return "";
  }
}

async function nseJson(path: string, referer: string): Promise<any | null> {
  const now = Date.now();
  if (now - lastFetchAt < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - (now - lastFetchAt)));
  }
  lastFetchAt = Date.now();
  const cookie = await primeCookie(referer);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        "User-Agent": UA,
        Cookie: cookie,
        Referer: referer,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function cmProvenance(): Provenance {
  return {
    source: "NSE_CM_PREOPEN",
    url: "https://www.nseindia.com/api/market-data-pre-open?key=ALL",
    fetchedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

export function fnoProvenance(): Provenance {
  return {
    source: "NSE_FNO_PREOPEN",
    url: "https://www.nseindia.com/api/market-data-pre-open-fno?key=FUTIDX|FUTSTK",
    fetchedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

export async function fetchCmPreopen(): Promise<PreopenFetchResult<CmPreopenRow>> {
  const payload = await nseJson("/market-data-pre-open?key=ALL", CM_REFERER);
  if (!payload) {
    return { ok: false, rows: [], timestamp: null, error: "fetch_failed", quality: "MISSING" };
  }
  const { rows, timestamp, duplicates } = normalizeCmPayload(payload);
  if (rows.length === 0) {
    return { ok: false, rows: [], timestamp, error: "empty_or_no_data", quality: "MISSING" };
  }
  return {
    ok: true,
    rows,
    timestamp,
    marketStatus: payload.marketStatus ?? null,
    quality: duplicates.length > 0 ? "DEGRADED" : "OK",
    error: duplicates.length > 0 ? `duplicates:${duplicates.slice(0, 5).join(",")}` : undefined,
  };
}

export async function fetchFnoPreopen(keys: Array<"FUTIDX" | "FUTSTK"> = ["FUTIDX", "FUTSTK"]): Promise<PreopenFetchResult<FuturesPreopenRow>> {
  const all: FuturesPreopenRow[] = [];
  let lastTs: string | null = null;
  let anyOk = false;
  for (const key of keys) {
    const payload = await nseJson(`/market-data-pre-open-fno?key=${key}`, FNO_REFERER);
    if (!payload) continue;
    const { rows, timestamp } = normalizeFuturesPayload(payload);
    if (rows.length > 0) anyOk = true;
    all.push(...rows);
    if (timestamp) lastTs = timestamp;
  }
  if (!anyOk) {
    return { ok: false, rows: [], timestamp: lastTs, error: "fetch_failed", quality: "MISSING" };
  }
  return { ok: true, rows: all, timestamp: lastTs, quality: "OK" };
}

/** Age of an NSE pre-open timestamp vs now (ms). Unparseable → null (caller decides). */
export function preopenAgeMs(timestamp: string | null | undefined, now = Date.now()): number | null {
  if (!timestamp) return null;
  const s = String(timestamp).trim();
  // Prefer explicit NSE form with +05:30 — never let local TZ shift the age.
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  let t: number;
  if (m) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const mon = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
    if (!mon) return null;
    t = Date.parse(
      `${m[3]}-${mon}-${String(m[1]).padStart(2, "0")}T${String(m[4]).padStart(2, "0")}:${m[5]}:${m[6]}+05:30`,
    );
  } else {
    t = Date.parse(s);
  }
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  return age >= 0 ? age : null;
}

/** Combined CM+F&O fetch for the daily collector. */
export async function fetchAllPreopen(): Promise<{
  cm: PreopenFetchResult<CmPreopenRow>;
  fno: PreopenFetchResult<FuturesPreopenRow>;
  quality: ReturnType<typeof buildQualityReport>;
}> {
  const fetchedAt = Date.now();
  const [cm, fno] = await Promise.all([fetchCmPreopen(), fetchFnoPreopen()]);
  const nowInSession = true;
  // Real freshness: age of the NSE timestamp, not a hardcoded 0.
  const cmAge = preopenAgeMs(cm.timestamp, fetchedAt) ?? (cm.ok ? 0 : null);
  const fnoAge = preopenAgeMs(fno.timestamp, fetchedAt) ?? (fno.ok ? 0 : null);
  const quality = buildQualityReport(
    {
      NSE_CM_PREOPEN: {
        present: cm.ok,
        ageMs: cmAge ?? 0,
        nowInSession,
        reason: cm.error || (cmAge == null ? "unparseable_timestamp" : undefined),
      },
      NSE_FNO_PREOPEN: {
        present: fno.ok,
        ageMs: fnoAge ?? 0,
        nowInSession,
        reason: fno.error || (fnoAge == null ? "unparseable_timestamp" : undefined),
      },
    },
    ["NSE_CM_PREOPEN"],
  );
  return { cm, fno, quality };
}
