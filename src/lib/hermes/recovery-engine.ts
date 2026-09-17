// NOUS HERMES — Recovery Engine
// Detects offline gaps, recovers state, reconstructs market intelligence
// NEVER claims to have monitored markets while PC was off

import { NousMode } from './persistence';
import { nousPersistence, type SnapshotData } from './persistence';
import { getCurrentSession } from './scheduler';

// ── Recovery Result ──
export interface RecoveryResult {
  success: boolean;
  gapSeconds: number;
  gapFormatted: string;
  previousMode: NousMode;
  recoveredItems: string[];
  unrecoverableItems: string[];
  dataHealthScore: number;
  morningBrief: MorningBrief | null;
  errors: string[];
}

// ── Morning Brief ──
export interface MorningBrief {
  timestamp: string;
  offlineGap: string;
  recoveryStatus: string;
  globalContext: string;
  indices: Record<string, { bias: string; price: number | null; change: number | null }>;
  vix: number | null;
  fiiDii: { fiiNet: number | null; diiNet: number | null; date: string | null };
  breadth: { advance: number; decline: number; ratio: number };
  sectorRotation: string;
  mcx: Record<string, { bias: string; price: number | null }>;
  newsCount: number;
  criticalNews: string[];
  topEquityWatchlist: string[];
  topOptionWatchlist: string[];
  topMcxWatchlist: string[];
  status: 'WAIT' | 'TRADE' | 'RESEARCH';
}

// ── Format gap duration ──
function formatGap(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ── Recovery Engine ──
class RecoveryEngine {
  private static instance: RecoveryEngine;

  static getInstance(): RecoveryEngine {
    if (!RecoveryEngine.instance) {
      RecoveryEngine.instance = new RecoveryEngine();
    }
    return RecoveryEngine.instance;
  }

  // ── Main Recovery Entry Point ──
  async recover(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      success: false,
      gapSeconds: 0,
      gapFormatted: '0s',
      previousMode: 'BOOT',
      recoveredItems: [],
      unrecoverableItems: [],
      dataHealthScore: 0,
      morningBrief: null,
      errors: [],
    };

    try {
      // Step 1: Detect offline gap
      const gap = await nousPersistence.detectOfflineGap();
      result.gapSeconds = gap.gapSeconds;
      result.gapFormatted = formatGap(gap.gapSeconds);
      result.previousMode = gap.previousMode;

      if (!gap.isRecovery) {
        // No recovery needed — clean start
        result.success = true;
        result.dataHealthScore = 100;
        return result;
      }

      console.log(`[NOUS-RECOVERY] Offline gap detected: ${result.gapFormatted} (since ${gap.lastHeartbeat?.toISOString() || 'unknown'})`);

      // Step 2: Start recovery tracking
      await nousPersistence.startRecovery(gap.gapSeconds);

      // Step 3: Recover available data
      const recoveryData = await this.recoverData(gap.gapSeconds, gap.previousMode);
      result.recoveredItems = recoveryData.recovered;
      result.unrecoverableItems = recoveryData.unrecoverable;
      result.dataHealthScore = recoveryData.healthScore;
      result.errors = recoveryData.errors;

      // Step 4: Build morning brief
      result.morningBrief = await this.buildMorningBrief(gap.gapSeconds, recoveryData);

      // Step 5: Complete recovery
      await nousPersistence.completeRecovery({
        recoveredItems: result.recoveredItems,
        unrecoverableItems: result.unrecoverableItems,
        dataHealthScore: result.dataHealthScore,
      });

      result.success = true;
      console.log(`[NOUS-RECOVERY] Recovery complete. Health: ${result.dataHealthScore}%, Recovered: ${result.recoveredItems.length}, Unrecoverable: ${result.unrecoverableItems.length}`);

    } catch (err: any) {
      result.errors.push(`Recovery failed: ${err.message?.substring(0, 200)}`);
      console.error('[NOUS-RECOVERY] Recovery error:', err.message?.substring(0, 200));
    }

    return result;
  }

  // ── Recover Available Data ──
  private async recoverData(gapSeconds: number, previousMode: NousMode): Promise<{
    recovered: string[];
    unrecoverable: string[];
    healthScore: number;
    errors: string[];
    lastSnapshot: SnapshotData | null;
    news: any[];
  }> {
    const recovered: string[] = [];
    const unrecoverable: string[] = [];
    const errors: string[] = [];
    let healthScore = 0;
    let totalChecks = 0;
    let passedChecks = 0;

    // 1. Previous market snapshot
    totalChecks++;
    const lastSnapshot = await nousPersistence.getLatestSnapshot();
    if (lastSnapshot) {
      recovered.push('MARKET_SNAPSHOT');
      passedChecks++;
    } else {
      unrecoverable.push('MARKET_SNAPSHOT');
    }

    // 2. Pending tasks from last session
    totalChecks++;
    const pendingTasks = await nousPersistence.getPendingTasks();
    if (pendingTasks.length > 0) {
      recovered.push(`PENDING_TASKS (${pendingTasks.length})`);
      passedChecks++;
    } else {
      recovered.push('PENDING_TASKS (none pending)');
      passedChecks++;
    }

    // 3. News recovery (RSS feeds are always available)
    totalChecks++;
    try {
      const { fetchMarketNews } = await import('@/lib/news-engine');
      const news = await fetchMarketNews();
      const articles = news.articles || [];
      if (articles.length > 0) {
        recovered.push(`NEWS (${articles.length} articles)`);
        passedChecks++;
      } else {
        recovered.push('NEWS (no articles available)');
        passedChecks++;
      }
    } catch (err: any) {
      unrecoverable.push('NEWS');
      errors.push(`News recovery failed: ${err.message?.substring(0, 100)}`);
    }

    // 4. FII/DII latest available
    totalChecks++;
    try {
      const { fetchFiiDiiData } = await import('@/lib/fii-dii');
      const fiiDii = await fetchFiiDiiData();
      if (fiiDii.latest?.date) {
        recovered.push(`FII/DII (latest: ${fiiDii.latest.date})`);
        passedChecks++;
      } else {
        unrecoverable.push('FII/DII');
      }
    } catch (err: any) {
      unrecoverable.push('FII/DII');
      errors.push(`FII/DII recovery failed: ${err.message?.substring(0, 100)}`);
    }

    // 5. Provider health (in-memory, resets on restart)
    totalChecks++;
    recovered.push('PROVIDER_HEALTH (reset on restart)');
    passedChecks++;

    // 6. Paper trade state (persisted in Prisma)
    totalChecks++;
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      const openTrades = await prisma.hermesPaperTrade.count({ where: { status: 'OPEN' } });
      const account = await prisma.hermesPaperAccount.findFirst();
      if (account) {
        recovered.push(`PAPER_ACCOUNT (₹${account.currentCapital.toFixed(0)}, ${openTrades} open trades)`);
        passedChecks++;
      } else {
        unrecoverable.push('PAPER_ACCOUNT');
      }
    } catch (err: any) {
      unrecoverable.push('PAPER_ACCOUNT');
      errors.push(`Paper state recovery failed: ${err.message?.substring(0, 100)}`);
    }

    // 7. Event bus (persisted in Prisma)
    totalChecks++;
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      const undelivered = await prisma.hermesEvent.count({ where: { delivered: false } });
      recovered.push(`EVENT_BUS (${undelivered} undelivered events)`);
      passedChecks++;
    } catch (err: any) {
      unrecoverable.push('EVENT_BUS');
      errors.push(`Event bus recovery failed: ${err.message?.substring(0, 100)}`);
    }

    // 8. Telegram queue (in-memory, restores dedup from Prisma)
    totalChecks++;
    recovered.push('TELEGRAM_QUEUE (dedup restored from events)');
    passedChecks++;

    // Calculate health score
    healthScore = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

    // Mark unrecoverable intraday data
    unrecoverable.push('NSE_INTRADAY_DATA (not available while PC was off)');
    unrecoverable.push('LIVE_OPTION_CHAIN_SNAPSHOTS (must fetch fresh)');

    return { recovered, unrecoverable, healthScore, errors, lastSnapshot, news: [] };
  }

  // ── Build Morning Brief ──
  private async buildMorningBrief(gapSeconds: number, recoveryData: any): Promise<MorningBrief> {
    const brief: MorningBrief = {
      timestamp: new Date().toISOString(),
      offlineGap: formatGap(gapSeconds),
      recoveryStatus: recoveryData.healthScore >= 80 ? 'GOOD' : recoveryData.healthScore >= 50 ? 'PARTIAL' : 'POOR',
      globalContext: 'ANALYZING...',
      indices: {},
      vix: null,
      fiiDii: { fiiNet: null, diiNet: null, date: null },
      breadth: { advance: 0, decline: 0, ratio: 0 },
      sectorRotation: 'ANALYZING...',
      mcx: {},
      newsCount: 0,
      criticalNews: [],
      topEquityWatchlist: [],
      topOptionWatchlist: ['NIFTY', 'BANKNIFTY', 'SENSEX'],
      topMcxWatchlist: ['CRUDEOIL', 'GOLD', 'SILVER'],
      status: 'RESEARCH',
    };

    try {
      // VIX
      try {
        const { fetchIndiaVIX } = await import('@/lib/yahoo-finance-api');
        const vix = await fetchIndiaVIX().catch(() => null);
        brief.vix = vix?.value ?? null;
      } catch {}

      // FII/DII
      try {
        const { fetchFiiDiiData } = await import('@/lib/fii-dii');
        const fiiDii = await fetchFiiDiiData();
        brief.fiiDii = {
          fiiNet: fiiDii.latest?.fiiNet ?? null,
          diiNet: fiiDii.latest?.diiNet ?? null,
          date: fiiDii.latest?.date ?? null,
        };
      } catch {}

      // News summary
      try {
        const { fetchMarketNews } = await import('@/lib/news-engine');
        const news = await fetchMarketNews();
        const articles = news.articles || [];
        brief.newsCount = articles.length;
        brief.criticalNews = articles
          .filter((a: any) => a.sentiment && Math.abs(a.sentiment) > 0.5)
          .slice(0, 5)
          .map((a: any) => `${a.title?.substring(0, 80)} (${a.source})`);
      } catch {}

      // Determine status based on session
      const session = getCurrentSession();
      if (session.session === 'WEEKEND' || session.session === 'HOLIDAY') {
        brief.status = 'RESEARCH';
      } else if (session.session === 'MARKET_ACTIVE' || session.session === 'MARKET_OPEN') {
        brief.status = 'WAIT'; // Wait for fresh data confirmation
      } else {
        brief.status = 'RESEARCH';
      }

    } catch (err: any) {
      console.error('[NOUS-RECOVERY] Morning brief build error:', err.message?.substring(0, 100));
    }

    return brief;
  }
}

// ── Singleton ──
export const recoveryEngine = RecoveryEngine.getInstance();

// ── Convenience ──
export const recover = () => recoveryEngine.recover();
