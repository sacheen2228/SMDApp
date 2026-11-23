import { MOTILAL_CONFIG, getSessionToken, getAccessTokenValue, isSessionValid, autoLogin } from "./auth";

// ── Types ──
export interface MotilalLTP {
  symbol: string;
  ltp: number;
  change: number;
  changePercent: number;
  exchange: string;
  scripcode: number;
  volume: number;         // LTP_Qty (tick volume) or LTP_Cumulative Qty (total day volume)
  openInterest: number;   // LTP_Open Interest
  avgTradePrice: number;  // LTP_AvgTradePrice
}

export interface MotilalScrip {
  symbol: string;
  name: string;
  scripcode: number;
  exchange: string;
  instrumenttype: string;
  series: string;
  expirydate: string;
  strikeprice: number;
  optiontype: string;
  lotsize: number;
}

// ── Futures contract snapshot (NSEFO / BFO) ──
// Live-verified 2026-11-20:
//   - getScrips("NSEFO") → 93,402 contracts in ~22s (cached 6h below). The
//     futures rows are instrumenttype "FUTIDX", optiontype "", strikeprice -1
//     (e.g. NIFTY 23-Nov-2026 → scripcode 61471).
//   - getLTP(scripcode) → real DAY volume (NIFTY 23-Nov-2026: 5,327,920) but
//     openInterest comes back 0 — MO publishes no futures OI, and its LTP is
//     scaled (2,575,200 for a ~25,752 print), so only the volume is used.
//   - MO has NO intraday futures series (EOD report endpoints only) → this can
//     never replace the Breeze intraday CVD curve; it is a degraded fallback.

export interface MotilalFuturesSnapshot {
  symbol: string;
  contract: string;
  scripcode: number;
  dayVolume: number;
  openInterest: number | null;
  asOf: string;
}

const FUTURES_CONTRACT_TTL_MS = 6 * 60 * 60_000;
const futuresContractCache = new Map<string, { ts: number; scrip: MotilalScrip | null }>();

function expiryFromContractName(name: string): string | null {
  const m = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(name || ""));
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mon = months.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1]}`;
}

/** "23-Nov-2026" / "2026-11-23" → "2026-11-23". */
function toIsoExpiry(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})$/.exec(s);
  if (m) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mon = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** Nearest listed futures contract for an index symbol (cached 6h). */
export async function getFuturesContract(
  symbol: string,
  expiryLabel?: string,
): Promise<MotilalScrip | null> {
  const sym = String(symbol || "").toUpperCase();
  const wanted = expiryLabel ? toIsoExpiry(expiryLabel) : null;
  const key = `${sym}:${wanted ?? ""}`;
  const hit = futuresContractCache.get(key);
  if (hit && Date.now() - hit.ts < FUTURES_CONTRACT_TTL_MS) return hit.scrip;

  let found: MotilalScrip | null = null;
  if (!isSessionValid()) await autoLogin();
  const token = getSessionToken() || "";

  for (const exchange of ["NSEFO", "BFO"]) {
    const scrips = await getScrips(exchange, token);
    const futures = scrips.filter(
      (s: any) =>
        String(s.symbol).trim().toUpperCase() === sym &&
        /FUT/i.test(String(s.instrumenttype || "")) &&
        !String(s.optiontype || "").trim(),
    );
    if (!futures.length) continue;
    const withExpiry = wanted
      ? futures.filter((s: any) => expiryFromContractName(s.name) === wanted)
      : [];
    const pool = withExpiry.length ? withExpiry : futures;
    pool.sort((a: any, b: any) => {
      const da = expiryFromContractName(a.name) || "";
      const db = expiryFromContractName(b.name) || "";
      return da.localeCompare(db);
    });
    found = pool[0];
    break;
  }

  futuresContractCache.set(key, { ts: Date.now(), scrip: found });
  return found;
}

/** Real day volume for the nearest futures contract (no OI — MO publishes none). */
export async function getFuturesSnapshot(
  symbol: string,
  expiryLabel?: string,
): Promise<MotilalFuturesSnapshot | null> {
  const contract = await getFuturesContract(symbol, expiryLabel);
  if (!contract) return null;
  if (!isSessionValid()) await autoLogin();
  const token = getSessionToken() || "";
  const ltp = await getLTP(contract.exchange || "NSEFO", contract.scripcode, token);
  if (!ltp) return null;
  return {
    symbol: String(symbol || "").toUpperCase(),
    contract: contract.name,
    scripcode: contract.scripcode,
    dayVolume: ltp.volume || 0,
    openInterest: ltp.openInterest > 0 ? ltp.openInterest : null,
    asOf: new Date().toISOString(),
  };
}

// ── Common headers ──
export function getHeaders(authToken?: string): Record<string, string> {
  const session = getSessionToken();
  const access = getAccessTokenValue();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "MOSL/V.1.1.0",
    apikey: MOTILAL_CONFIG.API_KEY,
    apisecretkey: MOTILAL_CONFIG.SECRET_KEY,
    macaddress: "AA:BB:CC:DD:EE:FF",
    clientlocalip: MOTILAL_CONFIG.SECONDARY_IP,
    clientpublicip: MOTILAL_CONFIG.PRIMARY_IP,
    sourceid: "WEB",
    vendorinfo: MOTILAL_CONFIG.VENDOR_ID,
    osname: "Ubuntu 20.04",
    osversion: "20.04",
    installedappid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    devicemodel: "VMware Virtual Platform",
    manufacturer: "unknown",
    productname: "Investor",
    productversion: "1",
    browsername: "Chrome",
    browserversion: "120.0",
    sdkversion: "Node 1.0",
    latitude: "19.0760",
    longitude: "72.8777",
    Authorization: authToken || session || "",
    accesstoken: access || "",
  };

  return headers;
}

// ── Get LTP for a single scrip ──
export async function getLTP(
  exchange: string,
  scripcode: number,
  authToken: string
): Promise<MotilalLTP | null> {
  try {
    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/report/v3/getltpdata`,
      {
        method: "POST",
        headers: getHeaders(authToken),
        body: JSON.stringify({
          exchange,
          scripcode,
        }),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && data.data) {
      return {
        symbol: data.data.symbol || "",
        ltp: data.data.ltp || 0,
        change: data.data.change || 0,
        changePercent: data.data.changepercent || 0,
        exchange,
        scripcode,
        volume: data.data.volume || data.data["LTP_Cumulative Qty"] || data.data["LTP_Qty"] || 0,
        openInterest: data.data.openinterest || data.data["LTP_Open Interest"] || 0,
        avgTradePrice: data.data["LTP_AvgTradePrice"] || 0,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Get LTP for multiple scrips ──
export async function getMultiLTP(
  scrips: Array<{ exchange: string; scripcode: number }>,
  authToken: string
): Promise<Map<number, MotilalLTP>> {
  const results = new Map<number, MotilalLTP>();

  // Motilal doesn't have batch LTP endpoint, fetch sequentially
  for (const scrip of scrips) {
    const ltp = await getLTP(scrip.exchange, scrip.scripcode, authToken);
    if (ltp) {
      results.set(scrip.scripcode, ltp);
    }
  }

  return results;
}

// ── Get index LTP data ──
export async function getIndexLTP(
  authToken: string
): Promise<Array<{ name: string; ltp: number; change: number }>> {
  try {
    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/report/v1/getindexltpdata`,
      {
        method: "POST",
        headers: getHeaders(authToken),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && Array.isArray(data.data)) {
      return data.data.map((item: any) => ({
        name: item.indexname || item.name || "",
        ltp: item.ltp || item.lastprice || 0,
        change: item.change || 0,
      }));
    }

    return [];
  } catch {
    return [];
  }
}

// ── Get scrips by exchange name ──
export async function getScrips(
  exchange: string,
  authToken: string
): Promise<MotilalScrip[]> {
  try {
    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/report/v3/getscripsbyexchangename`,
      {
        method: "POST",
        headers: getHeaders(authToken),
        body: JSON.stringify({ exchangename: exchange }),
        // Cold MCX master is ~69s (14.9k scrips); cap so a hung MO can never
        // block callers forever — timeout lands in catch → [] → static fallback.
        signal: AbortSignal.timeout(90_000),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && Array.isArray(data.data)) {
      return data.data.map((item: any) => ({
        symbol: item.scripshortname || item.symbol || "",
        name: item.scripname || item.scripfullname || "",
        scripcode: item.scripcode || 0,
        exchange: item.exchangename || exchange,
        instrumenttype: item.instrumentname || "",
        series: item.markettype || "",
        expirydate: item.expirydate
          ? typeof item.expirydate === "number"
            ? new Date((item.expirydate + 315360000) * 1000).toISOString().split("T")[0] // +10 years (Motilal API quirk)
            : String(item.expirydate)
          : "",
        strikeprice: item.strikeprice || 0,
        optiontype: item.optiontype === "XX" ? "" : (item.optiontype || "").trim(),
        lotsize: item.marketlot || 0,
      }));
    }

    return [];
  } catch {
    return [];
  }
}

// ── Get DPR (Daily Price Range) data ──
export async function getDPR(
  exchange: string,
  scripcode: number,
  authToken: string
): Promise<any | null> {
  try {
    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/report/v3/getdpr`,
      {
        method: "POST",
        headers: getHeaders(authToken),
        body: JSON.stringify({ exchange, scripcode }),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && data.data) {
      return data.data;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Well-known BSE scrip codes (MOAPI BSE works, NSE does not for LTP) ──
export const KNOWN_SCRIPS: Record<string, { code: number; exchange: string }> = {
  RELIANCE: { code: 500325, exchange: 'BSE' },
  TCS: { code: 532540, exchange: 'BSE' },
  INFY: { code: 500209, exchange: 'BSE' },
  HDFCBANK: { code: 500180, exchange: 'BSE' },
  ICICIBANK: { code: 532174, exchange: 'BSE' },
  WIPRO: { code: 507685, exchange: 'BSE' },
  SBIN: { code: 500112, exchange: 'BSE' },
  BHARTIARTL: { code: 532493, exchange: 'BSE' },
  ITC: { code: 500875, exchange: 'BSE' },
  KOTAKBANK: { code: 500247, exchange: 'BSE' },
  LT: { code: 500203, exchange: 'BSE' },
  AXISBANK: { code: 532215, exchange: 'BSE' },
  ASIANPAINT: { code: 500820, exchange: 'BSE' },
  MARUTI: { code: 532500, exchange: 'BSE' },
  HCLTECH: { code: 532281, exchange: 'BSE' },
  TATAMOTORS: { code: 500570, exchange: 'BSE' },
  SUNPHARMA: { code: 524715, exchange: 'BSE' },
};

// Legacy flat map for backward compat (all BSE)
export const KNOWN_SCRIPS_LEGACY: Record<string, number> = Object.fromEntries(
  Object.entries(KNOWN_SCRIPS).map(([k, v]) => [k, v.code])
);

// ── Get current session token (from auth module) ──
export function getCurrentAuthToken(): string | null {
  return getSessionToken();
}

// ── Get LTP by symbol name (auto-resolves exchange + scripcode) ──
export async function getLTPBySymbol(
  symbol: string,
  authToken?: string
): Promise<MotilalLTP | null> {
  const entry = KNOWN_SCRIPS[symbol.toUpperCase()];
  if (!entry) return null;
  const token = authToken || getSessionToken();
  if (!token) return null;
  return getLTP(entry.exchange, entry.code, token);
}

// ── Get LTP for known equities (batch) ──
export async function getKnownEquityLTP(
  authToken?: string
): Promise<Map<string, MotilalLTP>> {
  const results = new Map<string, MotilalLTP>();
  const token = authToken || getSessionToken();
  if (!token) return results;

  for (const [symbol, entry] of Object.entries(KNOWN_SCRIPS)) {
    const ltp = await getLTP(entry.exchange, entry.code, token);
    if (ltp) {
      results.set(symbol, ltp);
    }
  }
  return results;
}
