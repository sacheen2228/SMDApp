// FII/DII data from NSE India (primary) + MrChartist (history/F&O)
// All data is public — NSE publishes daily FII/FPI & DII cash activity

export interface FiiDiiDay {
  date: string;          // "17-Jul-2026"
  fiiBuy: number;        // ₹ Cr
  fiiSell: number;
  fiiNet: number;        // negative = net selling
  diiBuy: number;
  diiSell: number;
  diiNet: number;        // negative = net selling
  // F&O participant OI (contracts) — MrChartist only
  fiiIdxFutLong?: number;
  fiiIdxFutShort?: number;
  diiIdxFutLong?: number;
  diiIdxFutShort?: number;
  fiiStkFutLong?: number;
  fiiStkFutShort?: number;
  diiStkFutLong?: number;
  diiStkFutShort?: number;
  pcr?: number;
  sentimentScore?: number;
}

export interface FiiDiiSnapshot {
  fiiNet: number;
  diiNet: number;
  fiiBuy: number;
  fiiSell: number;
  diiBuy: number;
  diiSell: number;
  date: string;
  source: 'nse' | 'mrchartist';
}

export interface FiiDiiResult {
  latest: FiiDiiSnapshot;
  history: FiiDiiDay[];  // last 30 trading days
}

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

let nseCookieCache: string | null = null;
let nseCookieTime = 0;
const COOKIE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchNSEFiiDii(): Promise<FiiDiiSnapshot | null> {
  try {
    // NSE requires a session cookie — first hit the homepage
    const now = Date.now();
    if (!nseCookieCache || now - nseCookieTime > COOKIE_TTL) {
      const initRes = await fetch('https://www.nseindia.com', {
        headers: NSE_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const setCookie = initRes.headers.get('set-cookie');
      if (setCookie) {
        nseCookieCache = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
        nseCookieTime = now;
      }
    }

    const res = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: {
        ...NSE_HEADERS,
        ...(nseCookieCache ? { 'Cookie': nseCookieCache } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[FII/DII] NSE returned ${res.status}`);
      return null;
    }

    const data = await res.json() as Array<{
      buyValue: string;
      category: string;
      date: string;
      netValue: string;
      sellValue: string;
    }>;

    let fii: any = null;
    let dii: any = null;
    for (const row of data) {
      if (row.category?.includes('FII') || row.category?.includes('FPI')) fii = row;
      if (row.category?.includes('DII')) dii = row;
    }

    if (!fii && !dii) return null;

    const date = fii?.date || dii?.date || '';
    return {
      fiiNet: parseFloat(fii?.netValue || '0'),
      diiNet: parseFloat(dii?.netValue || '0'),
      fiiBuy: parseFloat(fii?.buyValue || '0'),
      fiiSell: parseFloat(fii?.sellValue || '0'),
      diiBuy: parseFloat(dii?.buyValue || '0'),
      diiSell: parseFloat(dii?.sellValue || '0'),
      date,
      source: 'nse',
    };
  } catch (err: any) {
    console.warn(`[FII/DII] NSE fetch error: ${err.message?.substring(0, 80)}`);
    return null;
  }
}

async function fetchMrChartistLatest(): Promise<FiiDiiSnapshot | null> {
  try {
    const res = await fetch('https://fii-diidata.mrchartist.com/api/data', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      fiiNet: d.fii_net ?? 0,
      diiNet: d.dii_net ?? 0,
      fiiBuy: d.fii_buy ?? 0,
      fiiSell: d.fii_sell ?? 0,
      diiBuy: d.dii_buy ?? 0,
      diiSell: d.dii_sell ?? 0,
      date: d.date ?? '',
      source: 'mrchartist',
    };
  } catch {
    return null;
  }
}

async function fetchMrChartistHistory(): Promise<FiiDiiDay[]> {
  try {
    const res = await fetch('https://fii-diidata.mrchartist.com/api/history', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((r: any) => ({
      date: r.date ?? '',
      fiiBuy: r.fii_buy ?? 0,
      fiiSell: r.fii_sell ?? 0,
      fiiNet: r.fii_net ?? 0,
      diiBuy: r.dii_buy ?? 0,
      diiSell: r.dii_sell ?? 0,
      diiNet: r.dii_net ?? 0,
      fiiIdxFutLong: r.fii_idx_fut_long ?? 0,
      fiiIdxFutShort: r.fii_idx_fut_short ?? 0,
      diiIdxFutLong: r.dii_idx_fut_long ?? 0,
      diiIdxFutShort: r.dii_idx_fut_short ?? 0,
      fiiStkFutLong: r.fii_stk_fut_long ?? 0,
      fiiStkFutShort: r.fii_stk_fut_short ?? 0,
      diiStkFutLong: r.dii_stk_fut_long ?? 0,
      diiStkFutShort: r.dii_stk_fut_short ?? 0,
      pcr: r.pcr ?? 0,
      sentimentScore: r.sentiment_score ?? 50,
    }));
  } catch {
    return [];
  }
}

// Cache
let cache: { data: FiiDiiResult; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function fetchFiiDiiData(): Promise<FiiDiiResult> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  // Run both in parallel — NSE for latest (authoritative), MrChartist for history
  const [nseLatest, mcLatest, history] = await Promise.all([
    fetchNSEFiiDii(),
    fetchMrChartistLatest(),
    fetchMrChartistHistory(),
  ]);

  // Prefer NSE latest (direct from exchange), fall back to MrChartist
  const latest = nseLatest || mcLatest || {
    fiiNet: 0, diiNet: 0,
    fiiBuy: 0, fiiSell: 0,
    diiBuy: 0, diiSell: 0,
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    source: 'mrchartist' as const,
  };

  const result: FiiDiiResult = { latest, history: history.slice(0, 30) };
  cache = { data: result, timestamp: Date.now() };
  return result;
}
