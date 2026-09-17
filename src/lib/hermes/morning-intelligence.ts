// NOUS HERMES — Morning Intelligence
// Pre-market analysis, overnight reconstruction, morning brief generation
// Uses existing modules: news-engine, fii-dii, scheduler, context

import { getCurrentSession } from './scheduler';
import { newsIntelligence, type NewsIntelligenceResult } from './news-intelligence';
import { fetchFiiDiiData } from '@/lib/fii-dii';

// ── Morning Brief ──
export interface MorningIntelligenceBrief {
  timestamp: string;
  session: string;
  offlineGap: string | null;
  recoveryStatus: string | null;

  // Global Context
  globalContext: {
    usMarkets: string;
    asianMarkets: string;
    crudeOil: number | null;
    gold: number | null;
    usdInr: number | null;
    yields: string;
    summary: string;
  };

  // Indices
  indices: Record<string, {
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MIXED';
    price: number | null;
    change: number | null;
    changePct: number | null;
    notes: string[];
  }>;

  // Market Internals
  vix: { value: number | null; interpretation: string };
  fiiDii: {
    fiiNet: number | null;
    diiNet: number | null;
    fiiTrend: string;
    diiTrend: string;
    date: string | null;
    source: string;
  };
  breadth: {
    advance: number;
    decline: number;
    ratio: number;
    interpretation: string;
  };
  sectorRotation: {
    leaders: string[];
    laggards: string[];
    rotationDirection: string;
  };

  // MCX
  mcx: Record<string, {
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    price: number | null;
    dataSource: string;
    freshness: string;
  }>;

  // News Intelligence
  news: NewsIntelligenceResult;

  // Watchlists
  topEquityWatchlist: Array<{ symbol: string; reason: string; score: number }>;
  topOptionWatchlist: Array<{ symbol: string; reason: string }>;
  topMcxWatchlist: Array<{ symbol: string; reason: string }>;

  // Decision
  morningBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MIXED';
  status: 'WAIT' | 'TRADE' | 'RESEARCH' | 'RECOVERY';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  notes: string[];
}

// ── Morning Intelligence Engine ──
class MorningIntelligence {
  private static instance: MorningIntelligence;
  private lastBrief: MorningIntelligenceBrief | null = null;

  static getInstance(): MorningIntelligence {
    if (!MorningIntelligence.instance) {
      MorningIntelligence.instance = new MorningIntelligence();
    }
    return MorningIntelligence.instance;
  }

  // ── Generate Morning Brief ──
  async generate(offlineGap?: { seconds: number; formatted: string }): Promise<MorningIntelligenceBrief> {
    const session = getCurrentSession();
    const now = new Date().toISOString();

    const brief: MorningIntelligenceBrief = {
      timestamp: now,
      session: session.session,
      offlineGap: offlineGap?.formatted || null,
      recoveryStatus: offlineGap ? 'RECOVERING' : null,

      globalContext: { usMarkets: 'PENDING', asianMarkets: 'PENDING', crudeOil: null, gold: null, usdInr: null, yields: 'PENDING', summary: 'Analyzing...' },
      indices: {},
      vix: { value: null, interpretation: 'PENDING' },
      fiiDii: { fiiNet: null, diiNet: null, fiiTrend: 'PENDING', diiTrend: 'PENDING', date: null, source: '' },
      breadth: { advance: 0, decline: 0, ratio: 0, interpretation: 'PENDING' },
      sectorRotation: { leaders: [], laggards: [], rotationDirection: 'PENDING' },
      mcx: {},
      news: { totalScanned: 0, relevant: 0, critical: 0, overnight: 0, events: [], sectorSummary: {}, timestamp: now },
      topEquityWatchlist: [],
      topOptionWatchlist: [{ symbol: 'NIFTY', reason: 'Primary index' }, { symbol: 'BANKNIFTY', reason: 'High volatility index' }, { symbol: 'SENSEX', reason: 'BSE index' }],
      topMcxWatchlist: [{ symbol: 'CRUDEOIL', reason: 'Energy commodity' }, { symbol: 'GOLD', reason: 'Safe haven' }, { symbol: 'SILVER', reason: 'Industrial metal' }],
      morningBias: 'NEUTRAL',
      status: 'RESEARCH',
      confidence: 'LOW',
      notes: [],
    };

    // Parallel data collection
    const [vixResult, fiiDiiResult, newsResult] = await Promise.allSettled([
      this.fetchVIX(),
      this.fetchFII_DII(),
      newsIntelligence.scan(undefined, 50),
    ]);

    // VIX
    if (vixResult.status === 'fulfilled') {
      brief.vix = vixResult.value;
    }

    // FII/DII
    if (fiiDiiResult.status === 'fulfilled') {
      brief.fiiDii = fiiDiiResult.value;
    }

    // News
    if (newsResult.status === 'fulfilled') {
      brief.news = newsResult.value;
    }

    // MCX
    try {
      brief.mcx = await this.fetchMCXOverview();
    } catch {}

    // Determine morning bias
    brief.morningBias = this.determineBias(brief);
    brief.status = this.determineStatus(session.session, brief);
    brief.confidence = this.determineConfidence(brief);

    // Add notes
    if (offlineGap) {
      brief.notes.push(`Recovering from offline gap: ${offlineGap.formatted}`);
    }
    if (brief.news.critical > 0) {
      brief.notes.push(`${brief.news.critical} critical news events detected`);
    }
    if (brief.vix.value && brief.vix.value > 20) {
      brief.notes.push(`VIX elevated at ${brief.vix.value.toFixed(1)}`);
    }

    this.lastBrief = brief;
    return brief;
  }

  // ── Fetch VIX ──
  private async fetchVIX(): Promise<{ value: number | null; interpretation: string }> {
    try {
      const { fetchIndiaVIX } = await import('@/lib/yahoo-finance-api');
      const vix = await fetchIndiaVIX().catch(() => null);
      const value = vix?.value ?? null;

      if (!value) return { value: null, interpretation: 'Unavailable' };

      let interpretation = 'NORMAL';
      if (value > 25) interpretation = 'HIGH — elevated fear';
      else if (value > 20) interpretation = 'ABOVE NORMAL — cautious';
      else if (value < 12) interpretation = 'LOW — complacency';
      else if (value < 15) interpretation = 'LOW — calm markets';

      return { value, interpretation };
    } catch {
      return { value: null, interpretation: 'Error fetching VIX' };
    }
  }

  // ── Fetch FII/DII ──
  private async fetchFII_DII(): Promise<MorningIntelligenceBrief['fiiDii']> {
    try {
      const data = await fetchFiiDiiData();
      const latest = data.latest;
      const history = data.history || [];

      // Trend analysis (last 5 days)
      const recentDays = history.slice(-5);
      const fiiAvg = recentDays.reduce((s: number, d: any) => s + (d.fiiNet || 0), 0) / Math.max(recentDays.length, 1);
      const diiAvg = recentDays.reduce((s: number, d: any) => s + (d.diiNet || 0), 0) / Math.max(recentDays.length, 1);

      return {
        fiiNet: latest?.fiiNet ?? null,
        diiNet: latest?.diiNet ?? null,
        fiiTrend: fiiAvg > 500 ? 'STRONG BUYING' : fiiAvg > 0 ? 'BUYING' : fiiAvg > -500 ? 'SELLING' : 'HEAVY SELLING',
        diiTrend: diiAvg > 500 ? 'STRONG BUYING' : diiAvg > 0 ? 'BUYING' : diiAvg > -500 ? 'SELLING' : 'HEAVY SELLING',
        date: latest?.date ?? null,
        source: latest?.source ?? 'unknown',
      };
    } catch {
      return { fiiNet: null, diiNet: null, fiiTrend: 'Unavailable', diiTrend: 'Unavailable', date: null, source: '' };
    }
  }

  // ── Fetch MCX Overview ──
  private async fetchMCXOverview(): Promise<Record<string, any>> {
    try {
      const res = await fetch('http://localhost:3000/api/mcx', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return {};
      const data = await res.json();
      if (!data.success) return {};

      const mcx: Record<string, any> = {};
      const allQuotes = [...(data.data?.energy || []), ...(data.data?.preciousMetals || [])];
      for (const q of allQuotes) {
        mcx[q.symbol] = {
          bias: (q.change || 0) > 0 ? 'BULLISH' : (q.change || 0) < 0 ? 'BEARISH' : 'NEUTRAL',
          price: q.ltp,
          dataSource: q.dataSource,
          freshness: q.dataStatus,
        };
      }
      return mcx;
    } catch {
      return {};
    }
  }

  // ── Determine Morning Bias ──
  private determineBias(brief: MorningIntelligenceBrief): 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MIXED' {
    let bullishScore = 0;
    let bearishScore = 0;

    // VIX
    if (brief.vix.value) {
      if (brief.vix.value < 15) bullishScore += 1;
      else if (brief.vix.value > 20) bearishScore += 1;
    }

    // FII/DII
    if (brief.fiiDii.fiiNet) {
      if (brief.fiiDii.fiiNet > 0) bullishScore += 1;
      else bearishScore += 1;
    }
    if (brief.fiiDii.diiNet) {
      if (brief.fiiDii.diiNet > 0) bullishScore += 1;
      else bearishScore += 1;
    }

    // News
    if (brief.news.critical > 0) {
      const criticalEvents = brief.news.events.filter(e => e.impact === 'CRITICAL');
      const negativeCritical = criticalEvents.filter(e => e.bias === 'NEGATIVE');
      const positiveCritical = criticalEvents.filter(e => e.bias === 'POSITIVE');
      if (negativeCritical.length > positiveCritical.length) bearishScore += 2;
      else if (positiveCritical.length > negativeCritical.length) bullishScore += 2;
    }

    // MCX (crude/gold as indicators)
    const crude = brief.mcx['CRUDEOIL'];
    if (crude?.bias === 'BEARISH') bullishScore += 1; // Falling crude = positive for India
    else if (crude?.bias === 'BULLISH') bearishScore += 1;

    if (bullishScore > bearishScore + 1) return 'BULLISH';
    if (bearishScore > bullishScore + 1) return 'BEARISH';
    if (bullishScore > 0 && bearishScore > 0) return 'MIXED';
    return 'NEUTRAL';
  }

  // ── Determine Status ──
  private determineStatus(session: string, brief: MorningIntelligenceBrief): 'WAIT' | 'TRADE' | 'RESEARCH' | 'RECOVERY' {
    if (brief.offlineGap) return 'RECOVERY';
    if (session === 'WEEKEND' || session === 'HOLIDAY') return 'RESEARCH';
    if (session === 'MARKET_ACTIVE') return 'WAIT'; // Wait for fresh confirmation
    return 'RESEARCH';
  }

  // ── Determine Confidence ──
  private determineConfidence(brief: MorningIntelligenceBrief): 'LOW' | 'MEDIUM' | 'HIGH' {
    let confidence = 0;

    if (brief.vix.value) confidence++;
    if (brief.fiiDii.fiiNet !== null) confidence++;
    if (brief.news.totalScanned > 10) confidence++;
    if (brief.news.critical > 0) confidence++;

    if (confidence >= 4) return 'HIGH';
    if (confidence >= 2) return 'MEDIUM';
    return 'LOW';
  }

  // ── Get Last Brief ──
  getLastBrief(): MorningIntelligenceBrief | null {
    return this.lastBrief;
  }
}

// ── Singleton ──
export const morningIntelligence = MorningIntelligence.getInstance();

// ── Convenience ──
export const generateMorningBrief = (offlineGap?: { seconds: number; formatted: string }) =>
  morningIntelligence.generate(offlineGap);

export const getLastMorningBrief = () =>
  morningIntelligence.getLastBrief();
