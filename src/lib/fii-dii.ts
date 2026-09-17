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
  participantOI?: ParticipantOI;  // NSE participant OI breakdown
  fiiNet5dAvg?: number;  // 5-day rolling FII net average
  diiNet5dAvg?: number;  // 5-day rolling DII net average
  fiiFutLongRatio?: number;  // FII futures long/short ratio (0-1)
}

export interface ParticipantOI {
  date: string;
  fii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number; };
  dii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number; };
  pro: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number; };
  client: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number; };
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
  // Retry up to 3 times with exponential backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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

      if (res.status === 403 || res.status === 429) {
        // Rate limited or blocked — clear cookie and retry
        nseCookieCache = null;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }

      if (!res.ok) return null;

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

      return {
        fiiNet: parseFloat(fii?.netValue || '0'),
        diiNet: parseFloat(dii?.netValue || '0'),
        fiiBuy: parseFloat(fii?.buyValue || '0'),
        fiiSell: parseFloat(fii?.sellValue || '0'),
        diiBuy: parseFloat(dii?.buyValue || '0'),
        diiSell: parseFloat(dii?.sellValue || '0'),
        date: fii?.date || dii?.date || '',
        source: 'nse',
      };
    } catch (err: any) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      console.warn(`[FII/DII] NSE fetch error after ${attempt} attempts: ${err.message?.substring(0, 80)}`);
      return null;
    }
  }
  return null;
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

async function fetchNSEParticipantOI(): Promise<ParticipantOI | null> {
  try {
    const now = Date.now();
    if (!nseCookieCache || now - nseCookieTime > COOKIE_TTL) {
      const initRes = await fetch('https://www.nseindia.com', {
        headers: NSE_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000),
      });
      const setCookie = initRes.headers.get('set-cookie');
      if (setCookie) {
        nseCookieCache = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
        nseCookieTime = now;
      }
    }

    // Try today, yesterday, and day before (weekends/holidays may have no data)
    for (let offset = 0; offset <= 3; offset++) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const dateStr = `${dd}${mm}${yyyy}`;

      try {
        const url = `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${dateStr}.csv`;
        const res = await fetch(url, {
          headers: { ...NSE_HEADERS, Cookie: nseCookieCache || '', Accept: 'text/csv' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;

        const csv = await res.text();
        if (!csv.includes('Client Type')) continue;

        const lines = csv.split('\n').filter(l => l.trim());
        const result: ParticipantOI = {
          date: `${dd}-${mm}-${yyyy}`,
          fii: { indexLong: 0, indexShort: 0, stockLong: 0, stockShort: 0, totalLong: 0, totalShort: 0 },
          dii: { indexLong: 0, indexShort: 0, stockLong: 0, stockShort: 0, totalLong: 0, totalShort: 0 },
          pro: { indexLong: 0, indexShort: 0, stockLong: 0, stockShort: 0, totalLong: 0, totalShort: 0 },
          client: { indexLong: 0, indexShort: 0, stockLong: 0, stockShort: 0, totalLong: 0, totalShort: 0 },
        };

        for (const line of lines) {
          const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
          if (cols.length < 9) continue;
          const type = cols[0]?.toLowerCase();
          if (!type) continue;

          const map: Record<string, keyof ParticipantOI> = {
            'fii': 'fii', 'fpi': 'fii',
            'dii': 'dii',
            'pro': 'pro', 'proprietary': 'pro',
            'client': 'client', 'retail': 'client',
          };
          const key = map[type];
          if (!key) continue;

          result[key] = {
            indexLong: parseInt(cols[1]) || 0,
            indexShort: parseInt(cols[2]) || 0,
            stockLong: parseInt(cols[3]) || 0,
            stockShort: parseInt(cols[4]) || 0,
            totalLong: parseInt(cols[7]) || 0,
            totalShort: parseInt(cols[8]) || 0,
          };
        }

        return result;
      } catch { continue; }
    }
    return null;
  } catch { return null; }
}

export async function fetchFiiDiiData(): Promise<FiiDiiResult> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  // NSE cookie must be set first — fetch latest FII/DII (sets cookie), then fetch CSV
  const nseLatest = await fetchNSEFiiDii();
  const [mcLatest, history, participantOI] = await Promise.all([
    fetchMrChartistLatest(),
    fetchMrChartistHistory(),
    fetchNSEParticipantOI(),
  ]);

  const latest = nseLatest || mcLatest || {
    fiiNet: 0, diiNet: 0,
    fiiBuy: 0, fiiSell: 0,
    diiBuy: 0, diiSell: 0,
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    source: 'mrchartist' as const,
  };

  const historySliced = history.slice(0, 30);
  // Compute 5-day rolling averages
  const last5 = historySliced.slice(-5);
  const fiiNet5dAvg = last5.length > 0 ? last5.reduce((s, d) => s + (d.fiiNet || 0), 0) / last5.length : 0;
  const diiNet5dAvg = last5.length > 0 ? last5.reduce((s, d) => s + (d.diiNet || 0), 0) / last5.length : 0;
  // FII futures long/short ratio (from latest participant OI)
  const fiiFutLongRatio = participantOI ? (() => {
    const fiiLong = (participantOI as any).fii?.indexLong || 0;
    const fiiShort = (participantOI as any).fii?.indexShort || 0;
    return fiiLong + fiiShort > 0 ? fiiLong / (fiiLong + fiiShort) : 0.5;
  })() : 0.5;

  const result: FiiDiiResult = {
    latest, history: historySliced, ...(participantOI ? { participantOI } : {}),
    fiiNet5dAvg: Math.round(fiiNet5dAvg),
    diiNet5dAvg: Math.round(diiNet5dAvg),
    fiiFutLongRatio: Math.round(fiiFutLongRatio * 100) / 100,
  };
  cache = { data: result, timestamp: Date.now() };
  return result;
}
