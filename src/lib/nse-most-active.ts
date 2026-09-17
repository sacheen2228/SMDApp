// NSE Most Active Contracts — Fetcher + Cache + Scheduler
// Fetches F&O most active contracts from NSE India API
// Scheduled: 9:05 AM IST (market open) + every 60 min
// Data: contracts, futures, options, calls, puts, OI

// ─── Types ───────────────────────────────────────────────────────
export interface MostActiveContract {
  instrument: string;       // FUTIDX, OPTIDX, FUTSTK, OPTSTK
  underlying: string;       // NIFTY, BANKNIFTY, etc.
  expiryDate: string;       // expiry date
  optionType: string;       // CE, PE, or empty for futures
  strikePrice: number;
  lastPrice: number;
  pChange: number;
  numberOfContractsTraded: number;
  totalTurnover: number;
  openInterest: number;
  underlyingValue: number;
}

export interface MostActiveCategory {
  data: MostActiveContract[];
  timestamp: string;
}

export interface MostActiveSnapshot {
  contracts: MostActiveCategory;
  futures: MostActiveCategory;
  options: MostActiveCategory;
  callsIndex: MostActiveCategory;
  putsIndex: MostActiveCategory;
  callsStocks: MostActiveCategory;
  putsStocks: MostActiveCategory;
  oi: MostActiveCategory;
  fetchedAt: number;
  marketStatus: string;
}

// ─── NSE Cookie Management ──────────────────────────────────────
const NSE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

let nseCookieCache: { cookie: string; expiresAt: number } | null = null;

async function getNSECookie(): Promise<string> {
  if (nseCookieCache && Date.now() < nseCookieCache.expiresAt) return nseCookieCache.cookie;
  try {
    const res = await fetch("https://www.nseindia.com", {
      headers: {
        "User-Agent": NSE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0] || "";
    nseCookieCache = { cookie, expiresAt: Date.now() + 5 * 60 * 1000 };
    return cookie;
  } catch {
    return "";
  }
}

// ─── Fetch a single NSE endpoint ────────────────────────────────
async function fetchNSEEndpoint(
  endpoint: string,
  cookie: string,
  params: Record<string, string> = {}
): Promise<any> {
  const url = new URL(`https://www.nseindia.com${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": NSE_UA,
      Cookie: cookie,
      Referer: "https://www.nseindia.com/market-data/most-active-contracts",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`NSE ${endpoint} returned ${res.status}`);
  return res.json();
}

// ─── Normalize data from NSE response ───────────────────────────
function normalizeContracts(raw: any): MostActiveCategory {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return {
    data: data.map((d: any) => ({
      instrument: d.instrument || "",
      underlying: d.underlying || "",
      expiryDate: d.expiryDate || "",
      optionType: d.optionType || "",
      strikePrice: d.strikePrice || 0,
      lastPrice: d.lastPrice || 0,
      pChange: d.pChange || 0,
      numberOfContractsTraded: d.numberOfContractsTraded || 0,
      totalTurnover: d.totalTurnover || 0,
      openInterest: d.openInterest || 0,
      underlyingValue: d.underlyingValue || 0,
    })),
    timestamp: raw?.timestamp || "",
  };
}

function normalizeWrapped(raw: any): MostActiveCategory {
  // NSE wraps calls/puts as { OPTIDX: { volume: { data: [...] } } }
  if (!raw || typeof raw !== "object") return { data: [], timestamp: "" };

  const allContracts: MostActiveContract[] = [];
  let timestamp = "";

  for (const instrumentType of Object.keys(raw)) {
    const instrumentData = raw[instrumentType];
    if (!instrumentData || typeof instrumentData !== "object") continue;

    for (const sortType of Object.keys(instrumentData)) {
      const sortData = instrumentData[sortType];
      if (sortData?.data && Array.isArray(sortData.data)) {
        if (!timestamp && sortData.timestamp) timestamp = sortData.timestamp;
        for (const d of sortData.data) {
          allContracts.push({
            instrument: d.instrument || instrumentType,
            underlying: d.underlying || "",
            expiryDate: d.expiryDate || "",
            optionType: d.optionType || "",
            strikePrice: d.strikePrice || 0,
            lastPrice: d.lastPrice || 0,
            pChange: d.pChange || 0,
            numberOfContractsTraded: d.numberOfContractsTraded || 0,
            totalTurnover: d.totalTurnover || 0,
            openInterest: d.openInterest || 0,
            underlyingValue: d.underlyingValue || 0,
          });
        }
      }
    }
  }

  return { data: allContracts, timestamp };
}

// ─── Main Fetcher ───────────────────────────────────────────────
export async function fetchMostActiveContracts(): Promise<MostActiveSnapshot | null> {
  try {
    const cookie = await getNSECookie();
    if (!cookie) {
      console.warn("[MostActive] Failed to get NSE cookie");
      return null;
    }

    // Fetch all categories in parallel
    const [contractsRaw, futuresRaw, optionsRaw, callsIdxRaw, putsIdxRaw, callsStkRaw, putsStkRaw, oiRaw] =
      await Promise.allSettled([
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "contracts", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "futures", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "options", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "calls-index", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "puts-index", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "calls-stocks", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "puts-stocks", limit: "20" }),
        fetchNSEEndpoint("/api/snapshot-derivatives-equity", cookie, { index: "oi", limit: "20" }),
      ]);

    const snapshot: MostActiveSnapshot = {
      contracts: normalizeContracts(contractsRaw.status === "fulfilled" ? contractsRaw.value : null),
      futures: normalizeContracts(futuresRaw.status === "fulfilled" ? futuresRaw.value : null),
      options: normalizeContracts(optionsRaw.status === "fulfilled" ? optionsRaw.value : null),
      callsIndex: normalizeWrapped(callsIdxRaw.status === "fulfilled" ? callsIdxRaw.value : null),
      putsIndex: normalizeWrapped(putsIdxRaw.status === "fulfilled" ? putsIdxRaw.value : null),
      callsStocks: normalizeWrapped(callsStkRaw.status === "fulfilled" ? callsStkRaw.value : null),
      putsStocks: normalizeWrapped(putsStkRaw.status === "fulfilled" ? putsStkRaw.value : null),
      oi: normalizeContracts(oiRaw.status === "fulfilled" ? oiRaw.value : null),
      fetchedAt: Date.now(),
      marketStatus: "unknown",
    };

    // Check market status
    try {
      const statusRes = await fetchNSEEndpoint("/api/marketStatus", cookie);
      snapshot.marketStatus = statusRes?.marketState?.[0]?.market || "unknown";
    } catch {
      snapshot.marketStatus = "unknown";
    }

    console.log(`[MostActive] Fetched snapshot: ${snapshot.contracts.data.length} contracts, ${snapshot.futures.data.length} futures, ${snapshot.options.data.length} options`);
    return snapshot;
  } catch (err: any) {
    console.error("[MostActive] Fetch error:", err.message);
    return null;
  }
}

// ─── In-Memory Cache ────────────────────────────────────────────
let cachedSnapshot: MostActiveSnapshot | null = null;
let lastFetchTime = 0;

export function getMostActiveCache(): MostActiveSnapshot | null {
  return cachedSnapshot;
}

export function getMostActiveCacheAge(): number {
  return Date.now() - lastFetchTime;
}

// ─── Manual Refresh ─────────────────────────────────────────────
export async function refreshMostActive(): Promise<MostActiveSnapshot | null> {
  const snapshot = await fetchMostActiveContracts();
  if (snapshot) {
    cachedSnapshot = snapshot;
    lastFetchTime = Date.now();
  }
  return snapshot;
}

// ─── Scheduler ──────────────────────────────────────────────────
let schedulerRunning = false;

function getISTHour(): number {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  return istTime.getHours();
}

function getISTMinutes(): number {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  return istTime.getMinutes();
}

function isMarketHours(): boolean {
  const hour = getISTHour();
  const min = getISTMinutes();
  const time = hour * 60 + min;
  // Market: 9:15 AM to 3:30 PM IST (Mon-Fri)
  const day = new Date().getDay();
  if (day === 0 || day === 6) return false;
  return time >= 9 * 60 + 15 && time <= 15 * 60 + 30;
}

export function startMostActiveScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;

  console.log("[MostActive] Scheduler started — runs at 9:05 AM IST + every 60 min during market hours");

  // Check every minute
  const interval = setInterval(async () => {
    try {
      // At 9:05 AM IST: first fetch of the day
      if (getISTHour() === 9 && getISTMinutes() === 5) {
        console.log("[MostActive] 9:05 AM IST — fetching pre-market snapshot");
        await refreshMostActive();
        return;
      }

      // During market hours: every 60 minutes
      if (isMarketHours()) {
        const age = getMostActiveCacheAge();
        if (age > 55 * 60 * 1000) { // ~55 min since last fetch
          console.log("[MostActive] Hourly refresh during market hours");
          await refreshMostActive();
        }
      }
    } catch (err: any) {
      console.error("[MostActive] Scheduler error:", err.message);
    }
  }, 60 * 1000); // Check every minute

  // Initial fetch on startup
  (async () => {
    console.log("[MostActive] Initial fetch on startup...");
    await refreshMostActive();
  })();
}

// ─── Helpers for UI ─────────────────────────────────────────────
export function formatVolume(vol: number): string {
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
  if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
  return vol.toLocaleString("en-IN");
}

export function formatTurnover(val: number): string {
  if (val >= 100) return `₹${(val / 100).toFixed(0)}Cr`;
  if (val >= 1) return `₹${val.toFixed(0)}L`;
  return `₹${(val * 100).toFixed(0)}K`;
}

export function getSentimentLabel(calls: MostActiveContract[], puts: MostActiveContract[]): string {
  const callVol = calls.reduce((s, c) => s + c.numberOfContractsTraded, 0);
  const putVol = puts.reduce((s, c) => s + c.numberOfContractsTraded, 0);
  if (callVol === 0 && putVol === 0) return "Neutral";
  const ratio = putVol / Math.max(callVol, 1);
  if (ratio > 1.5) return "Bearish";
  if (ratio > 1.1) return "Mildly Bearish";
  if (ratio < 0.67) return "Bullish";
  if (ratio < 0.9) return "Mildly Bullish";
  return "Neutral";
}
