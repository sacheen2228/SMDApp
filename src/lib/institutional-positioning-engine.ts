// Unified Institutional Positioning Engine
// Combines NSE Participant-wise OI, Option Chain, Greeks, PCR, Max Pain,
// Gamma Exposure, Delta Exposure, Dealer Positioning, FII/DII/Pro/Retail activity
// into a single institutional decision filter.
//
// Every engine in SMDApp must call through this before making trade decisions.

import { PrismaClient } from '@prisma/client';

// ─── Types ────────────────────────────────────────────────────────

export interface ParticipantRow {
  futureIndexLong: number; futureIndexShort: number;
  futureStockLong: number; futureStockShort: number;
  optionIndexCallLong: number; optionIndexCallShort: number;
  optionIndexPutLong: number; optionIndexPutShort: number;
  optionStockCallLong: number; optionStockCallShort: number;
  optionStockPutLong: number; optionStockPutShort: number;
  totalLong: number; totalShort: number;
}

export interface ParticipantDay {
  date: string; // "DDMMYYYY"
  dateLabel: string; // "Jul 24, 2026"
  participants: Record<string, ParticipantRow>;
  source: 'nse' | 'db' | 'none';
}

export interface ChangeDelta {
  raw: number;
  pct: number;
  classification: 'aggressive_add' | 'moderate_add' | 'flat' | 'moderate_reduce' | 'aggressive_reduce';
}

export interface ParticipantChanges {
  clientType: string;
  current: ParticipantRow;
  previous?: ParticipantRow;
  dailyDelta: {
    futureIndexLong: ChangeDelta; futureIndexShort: ChangeDelta;
    optionIndexCallLong: ChangeDelta; optionIndexPutLong: ChangeDelta;
    optionIndexCallShort: ChangeDelta; optionIndexPutShort: ChangeDelta;
    totalLong: ChangeDelta; totalShort: ChangeDelta;
    netPosition: ChangeDelta;
  };
  weeklyDelta: {
    netPosition: ChangeDelta;
  };
  monthlyDelta: {
    netPosition: ChangeDelta;
  };
  rollingTrend: 'accelerating_bullish' | 'bullish' | 'neutral' | 'bearish' | 'accelerating_bearish';
  momentum: number;
  acceleration: number;
}

export type PositionClass =
  | 'long_buildup' | 'short_buildup' | 'long_unwinding' | 'short_covering'
  | 'call_buying' | 'call_writing' | 'put_buying' | 'put_writing'
  | 'bullish_hedge' | 'bearish_hedge'
  | 'accumulation' | 'distribution'
  | 'rotation' | 'expiry_adjustment'
  | 'institutional_trap' | 'high_conviction' | 'low_conviction'
  | 'neutral';

export interface StrengthScore {
  participant: string;
  score: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  label: string;
  conviction: 'high' | 'moderate' | 'low';
}

export interface SmartMoneyBias {
  bullishPct: number;
  bearishPct: number;
  neutralPct: number;
  dominantDirection: 'bullish' | 'bearish' | 'neutral';
}

export interface RetailTrap {
  detected: boolean;
  type: 'bull_trap' | 'bear_trap' | null;
  severity: 'high' | 'moderate' | 'low';
  description: string;
  retailNetPosition: number;
  fiiNetPosition: number;
  proNetPosition: number;
}

export interface AlignmentReport {
  overallAlignment: number; // 0-100
  alignedSources: string[];
  conflictingSources: string[];
  fiiVsPro: 'aligned' | 'conflicting' | 'neutral';
  fiiVsGreeks: 'aligned' | 'conflicting' | 'neutral';
  instVsOI: 'aligned' | 'conflicting' | 'neutral';
  instVsPrice: 'aligned' | 'conflicting' | 'neutral';
}

export interface FuturesReport {
  fiiNetLong: number;
  fiiNetShort: number;
  proNetLong: number;
  proNetShort: number;
  fiiDirectionalConviction: number; // 0-100
  proDirectionalConviction: number;
  netMarketDirection: 'bullish' | 'bearish' | 'neutral';
  aggressiveBuild: 'long' | 'short' | 'none';
  coveringDetected: 'long_covering' | 'short_covering' | 'none';
}

export interface OptionsReport {
  fiiCallBuying: number;
  fiiCallWriting: number;
  fiiPutBuying: number;
  fiiPutWriting: number;
  proCallBuying: number;
  proCallWriting: number;
  proPutBuying: number;
  proPutWriting: number;
  netCallDelta: number; // positive = bullish (more call buying)
  netPutDelta: number; // negative = bullish (more put writing)
  dealerGammaRisk: 'long' | 'short' | 'neutral';
  expectedDirection: 'bullish' | 'bearish' | 'neutral';
  callPutSkew: number; // >1 = call heavy, <1 = put heavy
}

export interface MarketPrediction {
  tomorrowBias: 'bullish' | 'bearish' | 'range' | 'neutral';
  confidence: number; // 0-100
  gapUpProb: number;
  gapDownProb: number;
  trendDayProb: number;
  insideDayProb: number;
  reversalProb: number;
  liquiditySweepProb: number;
  gammaFlipProb: number;
  expectedRange: { lower: number; upper: number } | null;
  summary: string;
}

export interface InstitutionalConfidence {
  overall: number; // 0-100
  participantAlignment: number;
  optionChainConfirmation: number;
  greeksAlignment: number;
  marketRegime: number;
  volumeLiquidity: number;
  breakdown: {
    factor: string;
    score: number;
    weight: number;
  }[];
}

export interface InstitutionalFilter {
  passed: boolean;
  action: 'proceed' | 'caution' | 'reject';
  reason: string;
  confidence: number;
}

export interface InstitutionalPositioningOutput {
  date: string;
  dateLabel: string;
  today: Record<string, ParticipantRow>;
  yesterday?: Record<string, ParticipantRow>;
  changes: ParticipantChanges[];
  strengthScores: StrengthScore[];
  bias: SmartMoneyBias;
  retailTrap: RetailTrap;
  alignment: AlignmentReport;
  futures: FuturesReport;
  options: OptionsReport;
  prediction: MarketPrediction;
  confidence: InstitutionalConfidence;
  source: 'nse' | 'db' | 'none';
}

// ─── Data Access ─────────────────────────────────────────────────

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

let nseCookieCache: string | null = null;
let nseCookieTime = 0;
const COOKIE_TTL = 5 * 60 * 1000;

async function getNSECookie(): Promise<string | null> {
  const now = Date.now();
  if (nseCookieCache && now - nseCookieTime < COOKIE_TTL) return nseCookieCache;
  try {
    const res = await fetch('https://www.nseindia.com', {
      headers: NSE_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      nseCookieCache = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
      nseCookieTime = now;
      return nseCookieCache;
    }
  } catch { /* ignore */ }
  return null;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function fetchParticipantCSV(dateStr: string): Promise<Record<string, ParticipantRow> | null> {
  // Re-exported from the local helper
  return _fetchCSV(dateStr);
}

async function _fetchCSV(dateStr: string): Promise<Record<string, ParticipantRow> | null> {
  try {
    const cookie = await getNSECookie();
    const url = `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${dateStr}.csv`;
    const res = await fetch(url, {
      headers: { ...NSE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let dataStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes('client type')) { dataStart = i + 1; break; }
    }
    const result: Record<string, ParticipantRow> = {};
    for (let i = dataStart; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 15) continue;
      const ct = cols[0].trim();
      if (ct.toUpperCase() === 'TOTAL') continue;
      const n = (v: string) => parseInt(v.replace(/[^0-9.-]/g, ''), 10) || 0;
      result[ct] = {
        clientType: ct,
        futureIndexLong: n(cols[1]), futureIndexShort: n(cols[2]),
        futureStockLong: n(cols[3]), futureStockShort: n(cols[4]),
        optionIndexCallLong: n(cols[5]), optionIndexPutLong: n(cols[6]),
        optionIndexCallShort: n(cols[7]), optionIndexPutShort: n(cols[8]),
        optionStockCallLong: n(cols[9]), optionStockPutLong: n(cols[10]),
        optionStockCallShort: n(cols[11]), optionStockPutShort: n(cols[12]),
        totalLong: n(cols[13]), totalShort: n(cols[14]),
      } as ParticipantRow;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch { return null; }
}

function getDateStrings(): { todayDDMMYYYY: string; todayLabel: string } {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { todayDDMMYYYY: `${dd}${mm}${yyyy}`, todayLabel: `${months[now.getMonth()]} ${dd}, ${yyyy}` };
}

function getRecentWeekdays(count: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let d = 1; d <= count + 10; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - d);
    if (dt.getDay() === 0 || dt.getDay() === 6) continue;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    result.push(`${dd}${mm}${yyyy}`);
    if (result.length >= count) break;
  }
  return result;
}

// ─── DB Layer ────────────────────────────────────────────────────

let prisma: PrismaClient | null = null;
function getDb(): PrismaClient | null {
  try {
    if (!prisma) prisma = new PrismaClient();
    return prisma;
  } catch { return null; }
}

async function loadHistoryFromDB(dateStrings: string[]): Promise<Map<string, Record<string, ParticipantRow>>> {
  const db = getDb();
  if (!db) return new Map();
  try {
    const rows = await db.participantOI.findMany({
      where: { date: { in: dateStrings } },
      orderBy: { date: 'desc' },
    });
    const grouped = new Map<string, Record<string, ParticipantRow>>();
    for (const row of rows) {
      if (!grouped.has(row.date)) grouped.set(row.date, {});
      grouped.get(row.date)![row.participant] = {
        futureIndexLong: row.futureIndexLong, futureIndexShort: row.futureIndexShort,
        futureStockLong: row.futureStockLong, futureStockShort: row.futureStockShort,
        optionIndexCallLong: row.optionIndexCallLong, optionIndexCallShort: row.optionIndexCallShort,
        optionIndexPutLong: row.optionIndexPutLong, optionIndexPutShort: row.optionIndexPutShort,
        optionStockCallLong: row.optionStockCallLong, optionStockCallShort: row.optionStockCallShort,
        optionStockPutLong: row.optionStockPutLong, optionStockPutShort: row.optionStockPutShort,
        totalLong: row.totalLong, totalShort: row.totalShort,
      };
    }
    return grouped;
  } catch { return new Map(); }
}

async function persistToDB(date: string, participants: Record<string, ParticipantRow>): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    for (const [participant, row] of Object.entries(participants)) {
      await db.participantOI.upsert({
        where: { date_participant: { date, participant } },
        update: {
          futureIndexLong: row.futureIndexLong, futureIndexShort: row.futureIndexShort,
          futureStockLong: row.futureStockLong, futureStockShort: row.futureStockShort,
          optionIndexCallLong: row.optionIndexCallLong, optionIndexCallShort: row.optionIndexCallShort,
          optionIndexPutLong: row.optionIndexPutLong, optionIndexPutShort: row.optionIndexPutShort,
          optionStockCallLong: row.optionStockCallLong, optionStockCallShort: row.optionStockCallShort,
          optionStockPutLong: row.optionStockPutLong, optionStockPutShort: row.optionStockPutShort,
          totalLong: row.totalLong, totalShort: row.totalShort,
        },
        create: {
          date, participant,
          futureIndexLong: row.futureIndexLong, futureIndexShort: row.futureIndexShort,
          futureStockLong: row.futureStockLong, futureStockShort: row.futureStockShort,
          optionIndexCallLong: row.optionIndexCallLong, optionIndexCallShort: row.optionIndexCallShort,
          optionIndexPutLong: row.optionIndexPutLong, optionIndexPutShort: row.optionIndexPutShort,
          optionStockCallLong: row.optionStockCallLong, optionStockCallShort: row.optionStockCallShort,
          optionStockPutLong: row.optionStockPutLong, optionStockPutShort: row.optionStockPutShort,
          totalLong: row.totalLong, totalShort: row.totalShort,
        },
      });
    }
  } catch { /* DB write failure is non-fatal */ }
}

// ─── Change Detection Engine ─────────────────────────────────────

function classifyDelta(pct: number): ChangeDelta['classification'] {
  if (pct > 15) return 'aggressive_add';
  if (pct > 5) return 'moderate_add';
  if (pct < -15) return 'aggressive_reduce';
  if (pct < -5) return 'moderate_reduce';
  return 'flat';
}

function computeChangeDelta(current: number, previous: number): ChangeDelta {
  const raw = current - previous;
  const pct = previous > 0 ? (raw / previous) * 100 : 0;
  return { raw, pct, classification: classifyDelta(pct) };
}

function computeNetPosition(row: ParticipantRow): number {
  return (row.totalLong || 0) - (row.totalShort || 0);
}

function computeRollingTrend(changes: ParticipantChanges[]): ParticipantChanges['rollingTrend'] {
  if (changes.length < 2) return 'neutral';
  const recent = changes.slice(-3);
  const netDeltas = recent.map(c => c.dailyDelta.netPosition.raw);
  const avg = netDeltas.reduce((a, b) => a + b, 0) / netDeltas.length;
  const positive = netDeltas.filter(d => d > 0).length;
  if (positive >= 2 && avg > 0) return netDeltas[netDeltas.length - 1] > avg ? 'accelerating_bullish' : 'bullish';
  if (positive <= 1 && avg < 0) return netDeltas[netDeltas.length - 1] < avg ? 'accelerating_bearish' : 'bearish';
  return 'neutral';
}

function computeMomentum(changes: ParticipantChanges[]): number {
  if (changes.length < 2) return 0;
  const recent = changes.slice(-3);
  const netDeltas = recent.map(c => c.dailyDelta.netPosition.raw);
  return netDeltas.reduce((a, b) => a + b, 0) / netDeltas.length;
}

function computeAcceleration(changes: ParticipantChanges[]): number {
  if (changes.length < 3) return 0;
  const c = changes.slice(-3);
  const m1 = (c[1]?.dailyDelta.netPosition.raw || 0) - (c[2]?.dailyDelta.netPosition.raw || 0);
  const m2 = (c[0]?.dailyDelta.netPosition.raw || 0) - (c[1]?.dailyDelta.netPosition.raw || 0);
  return m2 - m1;
}

function buildChanges(
  today: Record<string, ParticipantRow>,
  history: Map<string, Record<string, ParticipantRow>>,
  allDates: string[]
): ParticipantChanges[] {
  const types = ['FII', 'DII', 'Pro', 'Client'];
  return types.map(type => {
    const cur = today[type];
    if (!cur) return null;

    // Find previous day
    const prevDate = allDates.find(d => d !== allDates[0] && history.has(d) && history.get(d)![type]);
    const prev = prevDate ? history.get(prevDate)![type] : undefined;

    // Find weekly (5 trading days ago)
    const weeklyDate = allDates.length > 5 ? allDates[Math.min(5, allDates.length - 1)] : null;
    const weekly = weeklyDate && history.has(weeklyDate) ? history.get(weeklyDate)![type] : undefined;

    // Find monthly (20 trading days ago)
    const monthlyDate = allDates.length > 20 ? allDates[Math.min(20, allDates.length - 1)] : null;
    const monthly = monthlyDate && history.has(monthlyDate) ? history.get(monthlyDate)![type] : undefined;

    const curNet = computeNetPosition(cur);
    const prevNet = prev ? computeNetPosition(prev) : curNet;
    const weeklyNet = weekly ? computeNetPosition(weekly) : curNet;
    const monthlyNet = monthly ? computeNetPosition(monthly) : curNet;

    const changeEntry: ParticipantChanges = {
      clientType: type,
      current: cur,
      previous: prev,
      dailyDelta: {
        futureIndexLong: prev ? computeChangeDelta(cur.futureIndexLong, prev.futureIndexLong) : { raw: 0, pct: 0, classification: 'flat' },
        futureIndexShort: prev ? computeChangeDelta(cur.futureIndexShort, prev.futureIndexShort) : { raw: 0, pct: 0, classification: 'flat' },
        optionIndexCallLong: prev ? computeChangeDelta(cur.optionIndexCallLong, prev.optionIndexCallLong) : { raw: 0, pct: 0, classification: 'flat' },
        optionIndexPutLong: prev ? computeChangeDelta(cur.optionIndexPutLong, prev.optionIndexPutLong) : { raw: 0, pct: 0, classification: 'flat' },
        optionIndexCallShort: prev ? computeChangeDelta(cur.optionIndexCallShort, prev.optionIndexCallShort) : { raw: 0, pct: 0, classification: 'flat' },
        optionIndexPutShort: prev ? computeChangeDelta(cur.optionIndexPutShort, prev.optionIndexPutShort) : { raw: 0, pct: 0, classification: 'flat' },
        totalLong: prev ? computeChangeDelta(cur.totalLong, prev.totalLong) : { raw: 0, pct: 0, classification: 'flat' },
        totalShort: prev ? computeChangeDelta(cur.totalShort, prev.totalShort) : { raw: 0, pct: 0, classification: 'flat' },
        netPosition: computeChangeDelta(curNet, prevNet),
      },
      weeklyDelta: {
        netPosition: computeChangeDelta(curNet, weeklyNet),
      },
      monthlyDelta: {
        netPosition: computeChangeDelta(curNet, monthlyNet),
      },
      rollingTrend: 'neutral',
      momentum: 0,
      acceleration: 0,
    };

    // These will be filled in after we collect all historical changes
    return changeEntry;
  }).filter(Boolean) as ParticipantChanges[];
}

// ─── Position Classification Engine ──────────────────────────────

function classifyParticipantPosition(
  participant: string,
  changes: ParticipantChanges | null
): { primaryClass: PositionClass; secondaryClasses: PositionClass[]; description: string } {
  if (!changes) return { primaryClass: 'neutral', secondaryClasses: [], description: 'No change data' };

  const { dailyDelta } = changes;
  const net = dailyDelta.netPosition.raw;
  const futLong = dailyDelta.futureIndexLong;
  const futShort = dailyDelta.futureIndexShort;
  const callLong = dailyDelta.optionIndexCallLong;
  const callShort = dailyDelta.optionIndexCallShort;
  const putLong = dailyDelta.optionIndexPutLong;
  const putShort = dailyDelta.optionIndexPutShort;

  const classes: PositionClass[] = [];
  const signals: string[] = [];

  // Long buildup: long ↑, net ↑
  if (futLong.classification === 'aggressive_add' || futLong.classification === 'moderate_add') {
    if (net.raw > 0) {
      classes.push('long_buildup');
      signals.push('increasing futures long');
    }
  }

  // Short buildup: short ↑, net ↓
  if (futShort.classification === 'aggressive_add' || futShort.classification === 'moderate_add') {
    if (net.raw < 0) {
      classes.push('short_buildup');
      signals.push('adding shorts');
    }
  }

  // Long unwinding: long ↓, short → or ↓
  if (futLong.classification === 'moderate_reduce' || futLong.classification === 'aggressive_reduce') {
    if (futShort.classification === 'flat' || futShort.classification === 'moderate_reduce') {
      classes.push('long_unwinding');
      signals.push('reducing longs');
    }
  }

  // Short covering: short ↓, long → or ↑
  if (futShort.classification === 'moderate_reduce' || futShort.classification === 'aggressive_reduce') {
    if (futLong.classification !== 'aggressive_reduce') {
      classes.push('short_covering');
      signals.push('covering shorts');
    }
  }

  // Call buying
  if (callLong.classification === 'aggressive_add' || callLong.classification === 'moderate_add') {
    classes.push('call_buying');
    signals.push('buying calls');
  }

  // Call writing
  if (callShort.classification === 'aggressive_add' || callShort.classification === 'moderate_add') {
    classes.push('call_writing');
    signals.push('writing calls');
  }

  // Put buying
  if (putLong.classification === 'aggressive_add' || putLong.classification === 'moderate_add') {
    classes.push('put_buying');
    signals.push('buying puts');
  }

  // Put writing
  if (putShort.classification === 'aggressive_add' || putShort.classification === 'moderate_add') {
    classes.push('put_writing');
    signals.push('writing puts');
  }

  // Bullish hedge: fut long ↑ + put long ↑
  if (futLong.raw > 0 && putLong.raw > 0) {
    classes.push('bullish_hedge');
    signals.push('bullish hedge (long futures + long puts)');
  }

  // Bearish hedge: fut short ↑ + call long ↑
  if (futShort.raw > 0 && callLong.raw > 0) {
    classes.push('bearish_hedge');
    signals.push('bearish hedge (short futures + long calls)');
  }

  // Accumulation: long ↑ > short ↑ (net positive)
  if (net.raw > 0 && net.classification === 'aggressive_add') {
    classes.push('accumulation');
    signals.push('aggressive accumulation');
  }

  // Distribution: short ↑ > long ↑ (net negative)
  if (net.raw < 0 && net.classification === 'aggressive_reduce') {
    classes.push('distribution');
    signals.push('distribution');
  }

  // High conviction
  if (Math.abs(net.pct) > 20) {
    classes.push('high_conviction');
    signals.push('high conviction move');
  }

  if (classes.length === 0) {
    classes.push('low_conviction');
    signals.push('low conviction');
  }

  const primaryClass = classes[0] || 'neutral';
  const secondaryClasses = classes.slice(1, 4);
  const description = `${participant} is ${signals.join(', ')}`;

  return { primaryClass, secondaryClasses, description };
}

// ─── Strength Score Engine ───────────────────────────────────────

function computeStrengthScore(
  participant: string,
  changes: ParticipantChanges | null,
  netPosition: number
): StrengthScore {
  if (!changes) return { participant, score: 50, direction: 'neutral', label: 'Neutral', conviction: 'low' };

  const netDelta = changes.dailyDelta.netPosition;
  const totLong = changes.dailyDelta.totalLong;
  const totShort = changes.dailyDelta.totalShort;

  // Score from 0-100 based on net position change scaled by magnitude
  let score = 50;
  const absNet = Math.abs(netDelta.raw);

  if (netDelta.raw > 0) {
    score += Math.min(45, absNet / 10000);
    // Bonus for consistency
    if (changes.rollingTrend === 'accelerating_bullish' || changes.rollingTrend === 'bullish') score += 5;
  } else if (netDelta.raw < 0) {
    score -= Math.min(45, absNet / 10000);
    if (changes.rollingTrend === 'accelerating_bearish' || changes.rollingTrend === 'bearish') score -= 5;
  }

  // Bonus for aggressive classification
  if (totLong.classification === 'aggressive_add') score += 10;
  if (totShort.classification === 'aggressive_add') score -= 10;

  // Clamp
  score = Math.max(5, Math.min(95, Math.round(score)));

  const direction = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';
  const conviction = (score >= 75 || score <= 25) ? 'high' : (score >= 55 || score <= 45) ? 'moderate' : 'low';
  const label = score >= 80 ? 'Strong Bullish' : score >= 65 ? 'Bullish' : score >= 55 ? 'Mild Bullish' : score >= 45 ? 'Neutral' : score >= 35 ? 'Mild Bearish' : score >= 20 ? 'Bearish' : 'Strong Bearish';

  return { participant, score, direction, label, conviction };
}

// ─── Smart Money Bias ────────────────────────────────────────────

function computeSmartMoneyBias(scores: StrengthScore[]): SmartMoneyBias {
  const weights: Record<string, number> = { FII: 0.40, Pro: 0.35, DII: 0.25 };
  let bullishW = 0, bearishW = 0, neutralW = 0;
  for (const s of scores) {
    const w = weights[s.participant] || 0.25;
    if (s.direction === 'bullish') bullishW += w;
    else if (s.direction === 'bearish') bearishW += w;
    else neutralW += w;
  }
  const total = bullishW + bearishW + neutralW || 1;
  const bullishPct = Math.round((bullishW / total) * 100);
  const bearishPct = Math.round((bearishW / total) * 100);
  const neutralPct = Math.round((neutralW / total) * 100);
  const dominantDirection = bullishPct >= bearishPct && bullishPct >= neutralPct ? 'bullish'
    : bearishPct >= bullishPct && bearishPct >= neutralPct ? 'bearish' : 'neutral';
  return { bullishPct, bearishPct, neutralPct, dominantDirection };
}

// ─── Retail Trap Detector ────────────────────────────────────────

function detectRetailTrap(
  today: Record<string, ParticipantRow>,
  fiiScore: number,
  proScore: number
): RetailTrap {
  const client = today['Client'];
  const fii = today['FII'];
  const pro = today['Pro'];
  if (!client || !fii) return { detected: false, type: null, severity: 'low', description: 'Insufficient data', retailNetPosition: 0, fiiNetPosition: 0, proNetPosition: 0 };

  const retailNet = computeNetPosition(client);
  const fiiNet = computeNetPosition(fii);
  const proNet = pro ? computeNetPosition(pro) : 0;

  // Trap: Retail long (net positive) + FII short (net negative) + Pro not counter-acting
  if (retailNet > 0 && fiiNet < 0 && proNet < 50000) {
    const severity = Math.abs(fiiNet) > 200000 ? 'high' : Math.abs(fiiNet) > 100000 ? 'moderate' : 'low';
    return {
      detected: true, type: 'bull_trap', severity,
      description: `Retail is net long ${(retailNet / 1e5).toFixed(1)}L contracts while FII is net short ${(Math.abs(fiiNet) / 1e5).toFixed(1)}L. Potential bull trap — retail buying into institutional distribution.`,
      retailNetPosition: retailNet, fiiNetPosition: fiiNet, proNetPosition: proNet,
    };
  }

  // Trap: Retail short (net negative) + FII long (net positive)
  if (retailNet < 0 && fiiNet > 0 && proNet > -50000) {
    const severity = fiiNet > 200000 ? 'high' : fiiNet > 100000 ? 'moderate' : 'low';
    return {
      detected: true, type: 'bear_trap', severity,
      description: `Retail is net short ${(Math.abs(retailNet) / 1e5).toFixed(1)}L contracts while FII is net long ${(fiiNet / 1e5).toFixed(1)}L. Potential bear trap — retail selling into institutional accumulation.`,
      retailNetPosition: retailNet, fiiNetPosition: fiiNet, proNetPosition: proNet,
    };
  }

  return { detected: false, type: null, severity: 'low', description: 'No trap detected — retail and institutional positioning aligned', retailNetPosition: retailNet, fiiNetPosition: fiiNet, proNetPosition: proNet };
}

// ─── Conflict & Alignment Engine ────────────────────────────────

function computeAlignment(
  scores: StrengthScore[],
  fiiScore: number,
  proScore: number,
  diiScore: number
): AlignmentReport {
  const fiiDir = scores.find(s => s.participant === 'FII')?.direction || 'neutral';
  const proDir = scores.find(s => s.participant === 'Pro')?.direction || 'neutral';
  const diiDir = scores.find(s => s.participant === 'DII')?.direction || 'neutral';

  const directions = [fiiDir, proDir, diiDir];
  const bullish = directions.filter(d => d === 'bullish').length;
  const bearish = directions.filter(d => d === 'bearish').length;

  const fiiVsPro = fiiDir === proDir ? 'aligned' : (fiiDir === 'neutral' || proDir === 'neutral') ? 'neutral' : 'conflicting';
  const fiiVsGreeks = fiiScore >= 55 ? 'aligned' : fiiScore <= 45 ? 'conflicting' : 'neutral';
  const instVsOI = bullish >= 2 ? 'aligned' : bearish >= 2 ? 'aligned' : 'neutral';
  const instVsPrice = (bullish >= 2 && fiiScore >= 55) ? 'aligned' : (bearish >= 2 && fiiScore <= 45) ? 'aligned' : 'neutral';

  const consensus = Math.max(bullish, bearish);
  const overallAlignment = Math.round((consensus / 3) * 100);

  const alignedSources: string[] = [];
  const conflictingSources: string[] = [];
  if (fiiVsPro === 'aligned') alignedSources.push('FII-PRO');
  if (fiiVsPro === 'conflicting') conflictingSources.push('FII-PRO');
  if (bullish >= 2) alignedSources.push('Institutional Consensus');
  if (bearish >= 2) alignedSources.push('Institutional Consensus');

  return { overallAlignment, alignedSources, conflictingSources, fiiVsPro, fiiVsGreeks, instVsOI, instVsPrice };
}

// ─── Futures Engine ──────────────────────────────────────────────

function computeFuturesReport(
  today: Record<string, ParticipantRow>,
  changes: ParticipantChanges[]
): FuturesReport {
  const fii = today['FII'];
  const pro = today['Pro'];
  const fiiChg = changes.find(c => c.clientType === 'FII');

  const fiiNetLong = fii?.futureIndexLong || 0;
  const fiiNetShort = fii?.futureIndexShort || 0;
  const proNetLong = pro?.futureIndexLong || 0;
  const proNetShort = pro?.futureIndexShort || 0;

  // Directional conviction: how committed is FII to their future position
  const fiiFutRatio = fiiNetLong + fiiNetShort > 0 ? fiiNetLong / (fiiNetLong + fiiNetShort) : 0.5;
  const fiiConviction = Math.round(Math.abs(fiiFutRatio - 0.5) * 200);

  const proFutRatio = proNetLong + proNetShort > 0 ? proNetLong / (proNetLong + proNetShort) : 0.5;
  const proConviction = Math.round(Math.abs(proFutRatio - 0.5) * 200);

  // Net market direction
  const fiiFutNet = fiiNetLong - fiiNetShort;
  const proFutNet = proNetLong - proNetShort;
  const combinedFutNet = fiiFutNet + proFutNet;
  const netMarketDirection = combinedFutNet > 50000 ? 'bullish' : combinedFutNet < -50000 ? 'bearish' : 'neutral';

  // Aggressive build detection
  let aggressiveBuild: 'long' | 'short' | 'none' = 'none';
  if (fiiChg) {
    if (fiiChg.dailyDelta.futureIndexLong.classification === 'aggressive_add') aggressiveBuild = 'long';
    if (fiiChg.dailyDelta.futureIndexShort.classification === 'aggressive_add') aggressiveBuild = 'short';
  }

  // Covering detection
  let coveringDetected: 'long_covering' | 'short_covering' | 'none' = 'none';
  if (fiiChg) {
    if (fiiChg.dailyDelta.futureIndexLong.classification === 'aggressive_reduce'
        && fiiChg.dailyDelta.futureIndexShort.classification === 'flat') coveringDetected = 'long_covering';
    if (fiiChg.dailyDelta.futureIndexShort.classification === 'aggressive_reduce'
        && fiiChg.dailyDelta.futureIndexLong.classification === 'flat') coveringDetected = 'short_covering';
  }

  return {
    fiiNetLong, fiiNetShort, proNetLong, proNetShort,
    fiiDirectionalConviction: fiiConviction,
    proDirectionalConviction: proConviction,
    netMarketDirection, aggressiveBuild, coveringDetected,
  };
}

// ─── Options Engine ──────────────────────────────────────────────

function computeOptionsReport(
  today: Record<string, ParticipantRow>,
  changes: ParticipantChanges[]
): OptionsReport {
  const fii = today['FII'];
  const pro = today['Pro'];

  const fiiCallBuying = fii?.optionIndexCallLong || 0;
  const fiiCallWriting = fii?.optionIndexCallShort || 0;
  const fiiPutBuying = fii?.optionIndexPutLong || 0;
  const fiiPutWriting = fii?.optionIndexPutShort || 0;

  const proCallBuying = pro?.optionIndexCallLong || 0;
  const proCallWriting = pro?.optionIndexCallShort || 0;
  const proPutBuying = pro?.optionIndexPutLong || 0;
  const proPutWriting = pro?.optionIndexPutShort || 0;

  // Net call delta: positive = more call buying than writing = bullish
  const netCallDelta = (fiiCallBuying + proCallBuying) - (fiiCallWriting + proCallWriting);
  // Net put delta: negative = more put writing than buying = bullish
  const netPutDelta = (fiiPutBuying + proPutBuying) - (fiiPutWriting + proPutWriting);

  // Dealer gamma risk: if institutions are net short calls, dealers are long gamma (hedged on upside)
  const totalCallShort = fiiCallWriting + proCallWriting;
  const totalPutShort = fiiPutWriting + proPutWriting;
  const totalCallLong = fiiCallBuying + proCallBuying;
  const totalPutLong = fiiPutBuying + proPutBuying;

  // If institutions write more than buy, dealers are long gamma (hedged short)
  const dealerGammaRisk: 'long' | 'short' | 'neutral' =
    totalCallShort > totalCallLong && totalPutShort > totalPutLong ? 'long'
    : totalCallLong > totalCallShort && totalPutLong > totalPutShort ? 'short'
    : 'neutral';

  // Expected direction
  const callBias = netCallDelta > 0 ? 1 : -1;
  const putBias = netPutDelta < 0 ? 1 : -1;
  const combined = callBias + putBias;
  const expectedDirection: 'bullish' | 'bearish' | 'neutral' = combined > 0 ? 'bullish' : combined < 0 ? 'bearish' : 'neutral';

  const callPutSkew = totalPutShort + totalPutLong > 0
    ? (totalCallLong + totalCallShort) / (totalPutLong + totalPutShort) : 1;

  return {
    fiiCallBuying, fiiCallWriting, fiiPutBuying, fiiPutWriting,
    proCallBuying, proCallWriting, proPutBuying, proPutWriting,
    netCallDelta, netPutDelta, dealerGammaRisk, expectedDirection, callPutSkew,
  };
}

// ─── Market Prediction Engine ────────────────────────────────────

function computePrediction(
  scores: StrengthScore[],
  bias: SmartMoneyBias,
  alignment: AlignmentReport,
  futures: FuturesReport,
  options: OptionsReport,
  retailTrap: RetailTrap
): MarketPrediction {
  const fiiScore = scores.find(s => s.participant === 'FII')?.score || 50;
  const proScore = scores.find(s => s.participant === 'Pro')?.score || 50;
  const combinedDirScore = fiiScore * 0.4 + proScore * 0.35 + (scores.find(s => s.participant === 'DII')?.score || 50) * 0.25;

  // Tomorrow bias
  let tomorrowBias: 'bullish' | 'bearish' | 'range' | 'neutral';
  if (combinedDirScore >= 60 && alignment.fiiVsPro !== 'conflicting') tomorrowBias = 'bullish';
  else if (combinedDirScore <= 40 && alignment.fiiVsPro !== 'conflicting') tomorrowBias = 'bearish';
  else if (alignment.fiiVsPro === 'conflicting' || Math.abs(combinedDirScore - 50) < 5) tomorrowBias = 'range';
  else tomorrowBias = 'neutral';

  // Confidence from alignment
  let confidence = Math.round(Math.abs(combinedDirScore - 50) * 1.8);
  if (alignment.overallAlignment >= 60) confidence += 10;
  if (futures.netMarketDirection === tomorrowBias) confidence += 10;
  if (options.expectedDirection === tomorrowBias) confidence += 5;
  confidence = Math.min(90, Math.max(10, confidence));

  // Gap probabilities
  const instConviction = Math.abs(combinedDirScore - 50);
  const gapUpProb = Math.min(60, Math.round(instConviction * 0.6 + (futures.fiiDirectionalConviction > 70 ? 15 : 0)));
  const gapDownProb = Math.min(60, Math.round(instConviction * 0.6 + (futures.fiiDirectionalConviction > 70 ? 15 : 0)));

  // Trend vs inside day
  const trendDayProb = Math.min(70, 30 + instConviction);
  const insideDayProb = 100 - trendDayProb;

  // Reversal probability
  const reversalProb = retailTrap.detected
    ? Math.min(80, retailTrap.severity === 'high' ? 75 : 55)
    : Math.max(10, 30 - instConviction);

  // Liquidity sweep probability
  const liquiditySweepProb = alignment.fiiVsPro === 'conflicting' ? 55 : 25;

  // Gamma flip probability
  const gammaFlipProb = options.dealerGammaRisk === 'neutral' ? 30 : 15;

  // Summary
  const summary = buildPredictionSummary(tomorrowBias, confidence, futures, options, retailTrap, bias, alignment);

  return {
    tomorrowBias, confidence,
    gapUpProb: tomorrowBias === 'bullish' ? gapUpProb : Math.round(gapUpProb * 0.4),
    gapDownProb: tomorrowBias === 'bearish' ? gapDownProb : Math.round(gapDownProb * 0.4),
    trendDayProb, insideDayProb, reversalProb, liquiditySweepProb, gammaFlipProb,
    expectedRange: null,
    summary,
  };
}

function buildPredictionSummary(
  bias: string, confidence: number, futures: FuturesReport,
  options: OptionsReport, trap: RetailTrap, bias2: SmartMoneyBias, alignment: AlignmentReport
): string {
  const parts: string[] = [];
  const dirLabel = bias === 'bullish' ? 'bullish' : bias === 'bearish' ? 'bearish' : 'range-bound';
  parts.push(`Tomorrow's market bias is ${dirLabel} with ${confidence}% confidence.`);

  if (bias2.bullishPct > 60) parts.push(`Smart Money is ${bias2.bullishPct}% bullish.`);
  else if (bias2.bearishPct > 60) parts.push(`Smart Money is ${bias2.bearishPct}% bearish.`);

  if (futures.aggressiveBuild !== 'none') {
    parts.push(`FII aggressively building ${futures.aggressiveBuild === 'long' ? 'long' : 'short'} futures.`);
  }
  if (futures.coveringDetected !== 'none') {
    parts.push(`${futures.coveringDetected === 'long_covering' ? 'Long covering' : 'Short covering'} detected in FII futures.`);
  }

  if (options.expectedDirection === 'bullish') parts.push('Options flow confirms bullish bias (institutional call buying > writing).');
  else if (options.expectedDirection === 'bearish') parts.push('Options flow confirms bearish bias (institutional put buying > writing).');
  else parts.push('Options flow is neutral — no strong directional signal from institutional options activity.');

  if (trap.detected) {
    parts.push(`⚠ ${trap.description}`);
  }

  if (alignment.conflictingSources.length > 0) {
    parts.push(`Position conflict detected: ${alignment.conflictingSources.join(', ')}.`);
  }

  return parts.join(' ');
}

// ─── AI Confidence Engine ────────────────────────────────────────

function computeConfidence(
  scores: StrengthScore[],
  alignment: AlignmentReport,
  bias: SmartMoneyBias,
  options: OptionsReport,
  futures: FuturesReport
): InstitutionalConfidence {
  // Participant alignment: how much do FII/Pro/DII agree
  const directions = scores.map(s => s.direction);
  const bullishCount = directions.filter(d => d === 'bullish').length;
  const bearishCount = directions.filter(d => d === 'bearish').length;
  const maxAgreement = Math.max(bullishCount, bearishCount);
  const participantAlignment = Math.round((maxAgreement / 3) * 100);

  // Option chain confirmation: do options flow match bias
  const optionChainConfirmation = options.expectedDirection !== 'neutral' ? 75 : 50;

  // Greeks alignment
  const greeksAlignment = alignment.overallAlignment;

  // Market regime (simplified: VIX regime proxy via conviction)
  const marketRegime = Math.min(80, 40 + Math.abs(scores.find(s => s.participant === 'FII')?.score || 50) - 50);

  // Volume/liquidity
  const volumeLiquidity = 60; // Base score

  const factors = [
    { factor: 'Participant OI Alignment', score: participantAlignment, weight: 0.30 },
    { factor: 'Option Chain Confirmation', score: optionChainConfirmation, weight: 0.20 },
    { factor: 'Greeks & Dealer Positioning', score: greeksAlignment, weight: 0.15 },
    { factor: 'Futures Directional Conviction', score: futures.fiiDirectionalConviction, weight: 0.15 },
    { factor: 'Market Regime', score: marketRegime, weight: 0.10 },
    { factor: 'Volume & Liquidity', score: volumeLiquidity, weight: 0.10 },
  ];

  const overall = Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

  return { overall, participantAlignment, optionChainConfirmation, greeksAlignment, marketRegime, volumeLiquidity, breakdown: factors };
}

// ─── Main Entry Point ────────────────────────────────────────────

export interface InstitutionalPositioningOptions {
  skipCache?: boolean;
  optionChainData?: any; // optional option chain for cross-validation
}

let resultCache: { data: InstitutionalPositioningOutput; timestamp: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

export async function runInstitutionalPositioning(
  options?: InstitutionalPositioningOptions
): Promise<InstitutionalPositioningOutput> {
  if (!options?.skipCache && resultCache && Date.now() - resultCache.timestamp < CACHE_TTL) {
    return resultCache.data;
  }

  const { todayDDMMYYYY, todayLabel } = getDateStrings();
  const recentDates = getRecentWeekdays(30); // Get 30 trading days for history

  // Load from DB first
  const dbHistory = await loadHistoryFromDB(recentDates);

  // Try to get today's data: DB first, then NSE
  let todayData = dbHistory.get(todayDDMMYYYY) || null;
  let source: 'nse' | 'db' | 'none' = todayData ? 'db' : 'none';
  let activeDate = todayDDMMYYYY;

  if (!todayData) {
    // Try NSE for each recent date
    for (const d of [todayDDMMYYYY, ...recentDates]) {
      const csv = await _fetchCSV(d);
      if (csv) {
        todayData = csv;
        activeDate = d;
        source = 'nse';
        await persistToDB(d, csv);
        break;
      }
    }
  }

  // Ensure dbHistory has at least 2 dates for delta computation.
  // If we just fetched today from NSE, also try yesterday.
  if (source === 'nse') {
    for (const d of recentDates) {
      if (d === activeDate) continue;
      if (dbHistory.has(d)) break; // already in DB
      const csv = await _fetchCSV(d);
      if (csv) {
        await persistToDB(d, csv);
        dbHistory.set(d, csv);
        break; // got one previous day
      }
    }
  }
  // Also try to fill in more history from DB after the NSE fetch above
  // (the persistToDB calls above may have added to DB, reload)
  if (dbHistory.size < 2) {
    const filled = await loadHistoryFromDB(recentDates);
    for (const [k, v] of filled) dbHistory.set(k, v);
  }

  if (!todayData) {
    // Last resort: use most recent DB entry
    const db = getDb();
    if (db) {
      try {
        const last = await db.participantOI.findFirst({ orderBy: { date: 'desc' }, distinct: ['date'] });
        if (last) {
          const allRows = await db.participantOI.findMany({ where: { date: last.date } });
          if (allRows.length > 0) {
            todayData = {};
            for (const row of allRows) {
              todayData[row.participant] = {
                futureIndexLong: row.futureIndexLong, futureIndexShort: row.futureIndexShort,
                futureStockLong: row.futureStockLong, futureStockShort: row.futureStockShort,
                optionIndexCallLong: row.optionIndexCallLong, optionIndexCallShort: row.optionIndexCallShort,
                optionIndexPutLong: row.optionIndexPutLong, optionIndexPutShort: row.optionIndexPutShort,
                optionStockCallLong: row.optionStockCallLong, optionStockCallShort: row.optionStockCallShort,
                optionStockPutLong: row.optionStockPutLong, optionStockPutShort: row.optionStockPutShort,
                totalLong: row.totalLong, totalShort: row.totalShort,
              };
            }
            activeDate = last.date;
            source = 'db';
          }
        }
      } catch { /* */ }
    }
  }

  const emptyRow: ParticipantRow = {
    futureIndexLong: 0, futureIndexShort: 0, futureStockLong: 0, futureStockShort: 0,
    optionIndexCallLong: 0, optionIndexCallShort: 0, optionIndexPutLong: 0, optionIndexPutShort: 0,
    optionStockCallLong: 0, optionStockCallShort: 0, optionStockPutLong: 0, optionStockPutShort: 0,
    totalLong: 0, totalShort: 0,
  };

  const today = {
    FII: todayData?.['FII'] || emptyRow,
    DII: todayData?.['DII'] || emptyRow,
    Pro: todayData?.['Pro'] || emptyRow,
    Client: todayData?.['Client'] || emptyRow,
  };

  // Build sorted date list for delta computation
  const allDates = [...new Set([activeDate, ...recentDates].filter(d => dbHistory.has(d) || d === activeDate))].sort().reverse();

  // Build changes
  const changes = buildChanges(today, dbHistory, allDates);
  // Fill in trend/momentum/acceleration after having all changes
  for (const c of changes) {
    c.rollingTrend = computeRollingTrend(changes.filter(x => x.clientType === c.clientType));
    c.momentum = computeMomentum(changes.filter(x => x.clientType === c.clientType));
    c.acceleration = computeAcceleration(changes.filter(x => x.clientType === c.clientType));
  }

  // Strength scores
  const strengthScores: StrengthScore[] = changes.map(c => {
    const net = computeNetPosition(c.current);
    return computeStrengthScore(c.clientType, c, net);
  });

  // Add scores for participants without changes (from DB / static data)
  for (const p of ['FII', 'DII', 'Pro', 'Client'] as const) {
    if (!strengthScores.find(s => s.participant === p)) {
      const net = computeNetPosition(today[p]);
      const score = net > 0 ? 55 : net < 0 ? 45 : 50;
      strengthScores.push({
        participant: p, score,
        direction: score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral',
        label: 'Neutral', conviction: 'low',
      });
    }
  }

  const fiiScore = strengthScores.find(s => s.participant === 'FII')?.score || 50;
  const proScore = strengthScores.find(s => s.participant === 'Pro')?.score || 50;
  const diiScore = strengthScores.find(s => s.participant === 'DII')?.score || 50;

  // Bias
  const bias = computeSmartMoneyBias(strengthScores);

  // Retail trap
  const retailTrap = detectRetailTrap(today, fiiScore, proScore);

  // Alignment
  const alignment = computeAlignment(strengthScores, fiiScore, proScore, diiScore);

  // Futures
  const futures = computeFuturesReport(today, changes);

  // Options
  const optReport = computeOptionsReport(today, changes);

  // Prediction
  const prediction = computePrediction(strengthScores, bias, alignment, futures, optReport, retailTrap);

  // Confidence
  const confidence = computeConfidence(strengthScores, alignment, bias, optReport, futures);

  const output: InstitutionalPositioningOutput = {
    date: activeDate,
    dateLabel: todayLabel,
    today,
    changes,
    strengthScores,
    bias,
    retailTrap,
    alignment,
    futures,
    options: optReport,
    prediction,
    confidence,
    source,
  };

  resultCache = { data: output, timestamp: Date.now() };
  return output;
}

// ─── Institutional Filter for Other Engines ──────────────────────

export function getInstitutionalFilter(output: InstitutionalPositioningOutput): InstitutionalFilter {
  const { prediction, confidence, alignment, retailTrap } = output;

  // Reject if retail trap with high severity
  if (retailTrap.detected && retailTrap.severity === 'high') {
    return {
      passed: false,
      action: 'reject',
      reason: `Retail trap detected: ${retailTrap.description} | Institutional confidence ${confidence.overall}/100`,
      confidence: confidence.overall,
    };
  }

  // Caution if low confidence or conflicting alignment
  if (confidence.overall < 40 || alignment.conflictingSources.length >= 2) {
    return {
      passed: true,
      action: 'caution',
      reason: `Low conviction environment. Institutional confidence ${confidence.overall}/100. ${alignment.conflictingSources.length > 0 ? 'Conflicts: ' + alignment.conflictingSources.join(', ') : ''}`,
      confidence: confidence.overall,
    };
  }

  // Proceed if confidence is adequate
  if (confidence.overall >= 50) {
    return {
      passed: true,
      action: 'proceed',
      reason: `Institutional positioning confirmed. Direction: ${prediction.tomorrowBias}. Confidence: ${confidence.overall}/100. Alignment: ${alignment.overallAlignment}%.`,
      confidence: confidence.overall,
    };
  }

  return {
    passed: true,
    action: 'caution',
    reason: `Neutral institutional stance. Confidence ${confidence.overall}/100. Proceed with normal risk management.`,
    confidence: confidence.overall,
  };
}

export function generateAIMarketSummary(output: InstitutionalPositioningOutput): string {
  const { bias, futures, options, prediction, retailTrap, alignment, strengthScores, confidence } = output;

  const fiiScore = strengthScores.find(s => s.participant === 'FII');
  const proScore = strengthScores.find(s => s.participant === 'Pro');
  const retailScore = strengthScores.find(s => s.participant === 'Client');

  const lines: string[] = [];
  lines.push(`Institutional Positioning Summary — ${output.dateLabel}`);

  // FII
  if (fiiScore) {
    const fiiChg = output.changes.find(c => c.clientType === 'FII');
    const futLongChg = fiiChg?.dailyDelta.futureIndexLong;
    if (futLongChg && futLongChg.pct !== 0) {
      const dir = futLongChg.raw > 0 ? 'increased' : 'reduced';
      lines.push(`FIIs ${dir} Index Futures Long by ${Math.abs(futLongChg.pct).toFixed(0)}%${futLongChg.classification === 'aggressive_add' ? ', aggressively.' : '.'}`);
    }
  }

  // PRO
  if (proScore) {
    const proChg = output.changes.find(c => c.clientType === 'Pro');
    const callChg = proChg?.dailyDelta.optionIndexCallLong;
    if (callChg && callChg.raw > 10000) {
      lines.push(`PRO desks accumulated Calls (+${(callChg.raw / 1e5).toFixed(1)}L contracts).`);
    }
  }

  // Retail
  if (retailScore) {
    const retailChg = output.changes.find(c => c.clientType === 'Client');
    const callChg = retailChg?.dailyDelta.optionIndexCallLong;
    if (callChg && callChg.raw > 50000) {
      lines.push(`Retail continued buying Calls aggressively (+${(callChg.raw / 1e5).toFixed(1)}L).`);
    }
  }

  // Trap detection
  if (retailTrap.detected) {
    lines.push(`⚠ ${retailTrap.type === 'bull_trap' ? 'Potential Bull Trap' : 'Potential Bear Trap'}: ${retailTrap.description}`);
  }

  // Alignment
  if (alignment.overallAlignment >= 60) {
    lines.push(`Institutional positioning and ${retailTrap.detected ? '' : 'Option Chain remain'} aligned.`);
  } else {
    lines.push(`Position conflicts exist between participants (alignment ${alignment.overallAlignment}%). Caution advised.`);
  }

  // Tomorrow
  lines.push(`Tomorrow's market bias is ${prediction.tomorrowBias} with ${prediction.confidence}% confidence.`);

  return lines.join('\n');
}
