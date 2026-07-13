// BSE API - Real option chain data from api.bseindia.com
// BSE indices: SENSEX (scrip_cd=1), BANKEX (scrip_cd=12), SX50 (scrip_cd=47), BSE FOCUSED IT (scrip_cd=75)

const BSE_API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Origin': 'https://www.bseindia.com',
  'Referer': 'https://www.bseindia.com/markets/Derivatives/DeriReports/DeriOptionchain',
  'Accept': 'application/json',
};

const BSE_SCRIP_CODES: Record<string, number> = {
  SENSEX: 1,
  BANKEX: 12,
};

export function isBSEIndex(symbol: string): boolean {
  return symbol.toUpperCase() in BSE_SCRIP_CODES;
}

export function getBseScripCd(symbol: string): number | null {
  return BSE_SCRIP_CODES[symbol.toUpperCase()] ?? null;
}

export interface BSEData {
  spotPrice: number;
  previousClose: number;
  high: number;
  low: number;
  volume: number;
  timestamp: string;
  source: string;
}

// Get SENSEX/BANKEX spot price from BSE's real-time index API
export async function getBSEIndexData(symbol: string): Promise<BSEData | null> {
  try {
    const response = await fetch(`${BSE_API_BASE}/GetSensexDatanew/w`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    const index = data.find((d: any) =>
      symbol.toUpperCase() === 'SENSEX' ? d.indxnm === 'BSE SENSEX' : d.indxnm === 'BSE BANKEX'
    );
    if (!index) return null;
    const ltp = parseFloat((index.ltp || '0').replace(/,/g, ''));
    return {
      spotPrice: ltp,
      previousClose: parseFloat((index.Prev_Close || '0').replace(/,/g, '')),
      high: parseFloat((index.High || '0').replace(/,/g, '')),
      low: parseFloat((index.Low || '0').replace(/,/g, '')),
      volume: 0,
      timestamp: new Date().toISOString(),
      source: 'bse-api',
    };
  } catch {
    return null;
  }
}

function parseBseExpiryDate(dateStr: string): Date | null {
  if (!dateStr || dateStr === '-') return null;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  let parts = dateStr.split(' ');
  if (parts.length === 3) {
    const month = months[parts[1]] ?? -1;
    if (month < 0) return null;
    return new Date(parseInt(parts[2]), month, parseInt(parts[0]));
  }
  parts = dateStr.split('-');
  if (parts.length === 3) {
    const month = months[parts[1]] ?? -1;
    if (month < 0) return null;
    return new Date(parseInt(parts[2]), month, parseInt(parts[0]));
  }
  return null;
}

// Get available expiry dates for a BSE index (future dates only, sorted)
export async function getBSEExpiryDates(symbol: string): Promise<string[]> {
  const scrip_cd = getBseScripCd(symbol);
  if (!scrip_cd) return [];

  try {
    const url = `${BSE_API_BASE}/Mkt_Archive_SerachDeriDropDown_beta/w?Product_Type=IO&scrip_cd=${scrip_cd}&Flag=1`;
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    const table1 = data?.table1 || [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return table1
      .filter((r: any) => {
        if (!r.EXPIRYDT || r.EXPIRYDT === '-') return false;
        const d = parseBseExpiryDate(r.EXPIRYDT);
        return d && d.getTime() >= now.getTime();
      })
      .sort((a: any, b: any) => {
        const da = parseBseExpiryDate(a.EXPIRYDT);
        const db = parseBseExpiryDate(b.EXPIRYDT);
        return (da?.getTime() || 0) - (db?.getTime() || 0);
      })
      .map((r: any) => r.EXPIRYDT);
  } catch {
    return [];
  }
}

export interface BSEOptionStrike {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    bid: number;
    ask: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    bid: number;
    ask: number;
  } | null;
}

function parseNum(val: string | undefined | null): number {
  if (!val || val === '' || val === '-') return 0;
  return parseFloat(val.replace(/,/g, '')) || 0;
}

export async function getBSEOptionChain(symbol: string, expiry: string): Promise<{
  data: BSEOptionStrike[];
  spotPrice: number;
  expiries: string[];
} | null> {
  const scrip_cd = getBseScripCd(symbol);
  if (!scrip_cd) return null;

  try {
    const encodedExpiry = expiry.replace(/ /g, '+');
    const url = `${BSE_API_BASE}/DerivOptionChain_IV/w?Expiry=${encodedExpiry}&scrip_cd=${scrip_cd}&strprice=0`;
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    const table = result?.Table || [];
    if (!table.length) return null;

    const spotPrice = parseFloat(table[0]?.UlaValue || '0');

    // Get available expiries from the table
    const expirySet = new Set(table.map((r: any) => r.End_TimeStamp).filter(Boolean));
    const expiries = Array.from(expirySet) as string[];

    // Merge CE/PE data into strikes
    const strikeMap = new Map<number, BSEOptionStrike>();
    for (const row of table) {
      const strike = parseNum(row.Strike_Price1);
      if (!strike) continue;

      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { strike, ce: null, pe: null });
      }

      const entry = strikeMap.get(strike)!;

      // PE data fields
      const peOi = parseNum(row.Open_Interest);
      const peOiChg = parseNum(row.Absolute_Change_OI);
      const peVol = parseNum(row.Vol_Traded);
      const peIv = parseNum(row.IV);

      // CE data fields (prefixed with C_)
      const ceOi = parseNum(row.C_Open_Interest);
      const ceOiChg = parseNum(row.C_Absolute_Change_OI);
      const ceVol = parseNum(row.C_Vol_Traded);
      const ceIv = parseNum(row.C_IV);

      if (peOi > 0 || peVol > 0) {
        entry.pe = {
          oi: peOi,
          oiChg: peOiChg,
          volume: peVol,
          iv: peIv,
          ltp: parseNum(row.Last_Trd_Price),
          chg: parseNum(row.NetChange),
          bid: parseNum(row.BidPrice),
          ask: parseNum(row.OfferPrice),
        };
      }

      if (ceOi > 0 || ceVol > 0) {
        entry.ce = {
          oi: ceOi,
          oiChg: ceOiChg,
          volume: ceVol,
          iv: ceIv,
          ltp: parseNum(row.C_Last_Trd_Price),
          chg: parseNum(row.C_NetChange),
          bid: parseNum(row.C_BidPrice),
          ask: parseNum(row.C_OfferPrice),
        };
      }
    }

    const data = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

    return { data, spotPrice, expiries };
  } catch {
    return null;
  }
}
