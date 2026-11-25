// FII/DII data from NSE India (primary) + MrChartist (history/F&O)
// All data is public — NSE publishes daily FII/FPI & DII cash activity

import { isTradingDayIso, previousTradingDayIso } from './expiry-calculator';

/** Where a snapshot came from. `nse-eod` = the NSE figure captured by the
 *  skill's 19:05 EOD job (same NSE numbers, read from disk when the live
 *  endpoint is rate-limited). */
export type FiiDiiSource = 'nse' | 'nse-eod' | 'mrchartist';

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
  source: FiiDiiSource;
}

export interface FiiDiiResult {
  latest: FiiDiiSnapshot;
  history: FiiDiiDay[];  // last 30 trading days
  participantOI?: ParticipantOI;  // NSE participant OI breakdown
  fiiNet5dAvg?: number;  // 5-day rolling FII net average
  diiNet5dAvg?: number;  // 5-day rolling DII net average
  fiiFutLongRatio?: number;  // FII futures long/short ratio (0-1)
  /**
   * False when NEITHER NSE nor MrChartist answered. The `latest` snapshot is
   * then a zero-filled placeholder — the card must show it as unavailable,
   * never as "FII net 0".
   */
  available: boolean;
  /** ISO session whose figures are the latest published ones ("2026-11-25"). */
  expectedSession?: string;
  /** Sources whose data was too old to serve (kept for the UI's provenance). */
  rejectedSources?: { source: string; date: string }[];
  /** Why nothing could be served (only when `available` is false). */
  reason?: string;
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

// MrChartist's API sits behind bot protection: a bare `fetch()` (no headers)
// gets 403, while the same URL with a browser UA + Origin/Referer returns 200.
// Verified live 2026-11-04 — both /api/data and /api/history.
const MC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.mrchartist.com',
  'Referer': 'https://www.mrchartist.com/',
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
        // nseindia.com 301s to nseindia.in — hit .in directly so set-cookie
        // is not lost on the redirect hop (live-verified: 200, date fresh).
        const initRes = await fetch('https://www.nseindia.in/', {
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

      const res = await fetch('https://www.nseindia.in/api/fiidiiTradeReact', {
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
      headers: MC_HEADERS,
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
      headers: MC_HEADERS,
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
/** How long a FAILED fetch may be served before the next call retries. */
const FAILURE_TTL = 30 * 1000;

/** Test-only: drop the in-memory result + cookie caches between cases. */
export function _resetFiiDiiCacheForTests(): void {
  cache = null;
  nseCookieCache = null;
  nseCookieTime = 0;
}

/**
 * Resolve `p` within `ms`, else `fallback`. The underlying promise keeps
 * running (its own AbortSignals still apply) — we only stop WAITING on it,
 * so a slow NSE retry ladder cannot pin the endpoint past the budget.
 */
function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * NSE's retry ladder is 3×10s + backoff ≈ 33s worst case. The market-data
 * provider cap for this category is 15s — without a race budget one hung
 * NSE minute returns UNAVAILABLE even though MrChartist answered in 100ms.
 */
const NSE_RACE_BUDGET_MS = 3_000;

// ─── History ordering ─────────────────────────────────────────────
// MrChartist ships `history` NEWEST-FIRST (verified live 2026-11-24:
// first=20-Nov-2026, last=31-Jul-2026). Dates are "DD-MMM-YYYY", so a
// string compare puts 01-Oct-2026 after 01-Nov-2026 AND `slice(-5)` takes
// the OLDEST five rows — the reported fiiNet5dAvg was -1710 (September)
// while the true newest-five average was +8730. Order must never be
// assumed: parse the date and sort.

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse "17-Jul-2026" → epoch ms, or null when unparseable. */
function parseChartistDate(date: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(date || "");
  if (!m) return null;
  const month = MONTH_INDEX[m[2].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) return null;
  return new Date(year, month, day).getTime();
}

/**
 * Return history ordered newest-first regardless of provider order.
 * Rows whose date cannot be parsed keep their relative order at the tail —
 * never dropped, never thrown on.
 */
export function sortHistoryNewestFirst(history: FiiDiiDay[]): FiiDiiDay[] {
  const withKey = history.map((row, i) => ({ row, i, t: parseChartistDate(row.date) }));
  withKey.sort((a, b) => {
    if (a.t === null && b.t === null) return a.i - b.i;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return b.t - a.t;
  });
  return withKey.map((x) => x.row);
}

/**
 * 5-day averages over the NEWEST five rows (order-independent).
 * Fewer than five rows → undefined — a 0 average over an empty history
 * reads as "FII net 0 for 5 days", which is a fabricated neutral.
 */
export function fiveDayAverages(history: FiiDiiDay[]): {
  fiiNet5dAvg?: number;
  diiNet5dAvg?: number;
} {
  const newest = sortHistoryNewestFirst(history).slice(0, 5);
  if (newest.length < 5) return {};
  const fiiNet5dAvg = newest.reduce((s, d) => s + (d.fiiNet || 0), 0) / newest.length;
  const diiNet5dAvg = newest.reduce((s, d) => s + (d.diiNet || 0), 0) / newest.length;
  return { fiiNet5dAvg, diiNet5dAvg };
}

// ─── Session-date gate ───────────────────────────────────────────
// The FII/DII cash figures are published once per session (~18:00 IST). A
// provider that answers with an OLD session's numbers must never be served as
// "today's flow": the card showed a 5-day-old row (20-Nov) as the current
// figure whenever NSE was rate-limited and the MrChartist fallback was used.

/** NSE publishes the FII/DII cash figures around 18:00 IST. */
export const FII_DII_PUBLISH_MINUTE_IST = 18 * 60;

/** The IST calendar date ("YYYY-MM-DD") of an instant. */
function istIsoDate(now: Date): string {
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}

/** Minutes since IST midnight. */
function istMinuteOfDay(now: Date): number {
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist.getHours() * 60 + ist.getMinutes();
}

/**
 * The session whose published figures are the latest ones.
 * Before the publication time on a trading day that is the PREVIOUS session;
 * after it, today. On a weekend/holiday it is the last session before today
 * (the holiday list is the canonical one).
 * `publishMinuteIst` is the IST minute the exchange publishes that feed
 * (18:00 for the FII/DII cash figures, 16:00 for the derivatives snapshot).
 */
export function expectedPublishedSession(now: Date = new Date(), publishMinuteIst: number = FII_DII_PUBLISH_MINUTE_IST): string {
  const today = istIsoDate(now);
  const tradingToday = isTradingDayIso(today);
  const publishedToday = tradingToday && istMinuteOfDay(now) >= publishMinuteIst;
  if (publishedToday) return today;
  return previousTradingDayIso(today) ?? today;
}

/** The FII/DII figures belong to the session that published them. */
export function fiiDiiExpectedSession(now: Date = new Date()): string {
  return expectedPublishedSession(now, FII_DII_PUBLISH_MINUTE_IST);
}

/**
 * The publication instant of a snapshot date (18:00 IST) as an ISO string.
 * The figures are stamped at publication time — midnight would age a
 * same-session figure into "STALE" by the end of the evening.
 */
export function fiiDiiPublishedAtIso(date: string): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '').slice(0, 10))
    ? String(date).slice(0, 10)
    : (() => {
        const t = parseFiiDiiDate(date);
        if (t === null) return null;
        const dt = new Date(t);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      })();
  if (!iso) return null;
  return `${iso}T18:00:00+05:30`;
}

/**
 * Parse a snapshot date ("DD-MMM-YYYY" from NSE/MrChartist or "YYYY-MM-DD"
 * from the EOD artifact) → epoch ms of that local calendar day.
 */
export function parseFiiDiiDate(date: string): number | null {
  const s = String(date || '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt.getTime();
  }
  const dm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (dm) {
    const mi = MONTH_INDEX[dm[2].toLowerCase()];
    if (mi === undefined) return null;
    const day = Number(dm[1]);
    const year = Number(dm[3]);
    if (day < 1 || day > 31) return null;
    return new Date(year, mi, day).getTime();
  }
  return null;
}

/**
 * Is a snapshot date acceptable as the latest published figure?
 * Accepts the expected session and the session before it (a delayed
 * publication is still the current published figure). Anything older — a
 * stale fallback — is rejected instead of being served as current.
 */
export function isFiiDiiDateAcceptable(date: string, expectedSession: string): boolean {
  const t = parseFiiDiiDate(date);
  const e = parseFiiDiiDate(expectedSession);
  if (t === null || e === null) return false;
  const dayMs = 24 * 60 * 60 * 1000;
  const ageDays = Math.round((e - t) / dayMs);
  if (ageDays < 0) return false;   // a future date is not a published figure
  return ageDays <= 1;
}

export interface FiiDiiSelection {
  snapshot: FiiDiiSnapshot | null;
  rejected: { source: string; date: string }[];
}

/**
 * Pick the snapshot to serve from the candidates, in the caller's priority
 * order (NSE live → NSE EOD artifact → MrChartist). Among the ACCEPTABLE
 * candidates the newest date wins; a tie keeps the caller's priority (the
 * sort is stable). Stale candidates are reported, never served.
 */
export function selectFiiDiiLatest(
  candidates: (FiiDiiSnapshot | null | undefined)[],
  expectedSession: string,
): FiiDiiSelection {
  const rejected: { source: string; date: string }[] = [];
  const accepted: { snap: FiiDiiSnapshot; t: number }[] = [];
  for (const cand of candidates) {
    if (!cand) continue;
    const t = parseFiiDiiDate(cand.date);
    if (t === null || !isFiiDiiDateAcceptable(cand.date, expectedSession)) {
      rejected.push({ source: cand.source, date: cand.date });
      continue;
    }
    accepted.push({ snap: cand, t });
  }
  if (!accepted.length) return { snapshot: null, rejected };
  accepted.sort((a, b) => b.t - a.t);
  return { snapshot: accepted[0].snap, rejected };
}

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

  // Every provider starts together. NSE (latest + participant CSV) is
  // raced against a short budget so its retry ladder cannot block the
  // MrChartist answer; NSE still wins whenever it responds in time.
  // (Previously NSE was awaited FIRST — one slow NSE minute hung the
  // whole endpoint past the 15s provider cap.)
  const [nseLatest, mcLatest, history, participantOI] = await Promise.all([
    withBudget(fetchNSEFiiDii(), NSE_RACE_BUDGET_MS, null),
    fetchMrChartistLatest(),
    fetchMrChartistHistory(),
    withBudget(fetchNSEParticipantOI(), NSE_RACE_BUDGET_MS, null),
  ]);

  // The session whose figures are the latest published ones. A snapshot that
  // belongs to an older session is NOT served as the current flow — that is
  // how a 5-day-old fallback row ended up on the card as today's number.
  const expectedSession = fiiDiiExpectedSession(new Date());
  const selection = selectFiiDiiLatest([nseLatest, mcLatest], expectedSession);

  const latest = selection.snapshot || {
    fiiNet: 0, diiNet: 0,
    fiiBuy: 0, fiiSell: 0,
    diiBuy: 0, diiSell: 0,
    date: '',
    source: 'mrchartist' as const,
  };
  const available = !!selection.snapshot;
  const reason = available
    ? undefined
    : (selection.rejected.length > 0
      ? `FII/DII data is stale — newest available ${selection.rejected[0].date}, expected ${expectedSession}`
      : 'FII/DII feed unavailable (all providers failed)');

  const historySliced = sortHistoryNewestFirst(history).slice(0, 30);
  // Compute 5-day rolling averages — only when the history actually exists.
  // (A 0 average over an EMPTY history reads as "FII net 0 for 5 days".)
  // fiveDayAverages() re-sorts internally, so it never depends on this order.
  const { fiiNet5dAvg, diiNet5dAvg } = fiveDayAverages(historySliced);
  // FII futures long/short ratio (from the latest participant OI). undefined
  // when there is no participant data — 0.5 was a fabricated "neutral".
  const fiiFutLongRatio = participantOI ? (() => {
    const fiiLong = (participantOI as any).fii?.indexLong || 0;
    const fiiShort = (participantOI as any).fii?.indexShort || 0;
    return fiiLong + fiiShort > 0 ? fiiLong / (fiiLong + fiiShort) : undefined;
  })() : undefined;

  const result: FiiDiiResult = {
    latest, history: historySliced, available,
    expectedSession,
    ...(selection.rejected.length > 0 ? { rejectedSources: selection.rejected } : {}),
    ...(reason ? { reason } : {}),
    ...(participantOI ? { participantOI } : {}),
    ...(fiiNet5dAvg != null ? { fiiNet5dAvg: Math.round(fiiNet5dAvg) } : {}),
    ...(diiNet5dAvg != null ? { diiNet5dAvg: Math.round(diiNet5dAvg) } : {}),
    ...(fiiFutLongRatio != null ? { fiiFutLongRatio: Math.round(fiiFutLongRatio * 100) / 100 } : {}),
  };
  // Only a REAL answer earns the 5-minute TTL. Caching a failure for the same
  // window meant one bad minute (blocked IP, bot challenge) pinned the card on
  // "unavailable" long after the provider recovered — the next call has to be
  // able to retry.
  if (available) {
    cache = { data: result, timestamp: Date.now() };
  } else {
    // Brief negative cache so a hard-down provider isn't re-hit on every poll.
    cache = { data: result, timestamp: Date.now() - CACHE_TTL + FAILURE_TTL };
  }
  return result;
}
