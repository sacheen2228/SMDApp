// Nous Orchestrator — 24/7 background worker
// Monitoring, orchestration, research, scheduling, Challenge #1
// SMDApp Hermes Pro remains the FINAL TRADING AUTHORITY.

import { PrismaClient } from '@prisma/client';
import { getEventBus, type HermesEvent, type HermesEventType } from './event-bus';
import { getTelegramQueue } from './telegram-queue';
import {
  getCurrentSession,
  getPollInterval,
  shouldMonitorSignals,
  shouldMonitorTrades,
  shouldRunResearch,
  formatSessionLabel,
  type MarketSession,
} from './scheduler';
import { nousPersistence, type NousMode, writeHeartbeat, transitionMode, persistShutdown, detectOfflineGap } from './persistence';
import { recoveryEngine, type RecoveryResult } from './recovery-engine';
import { newsIntelligence, type NewsIntelligenceResult } from './news-intelligence';
import { morningIntelligence, type MorningIntelligenceBrief } from './morning-intelligence';

// ─── Challenge #1 Config ──────────────────────────────────────────
interface ChallengeConfig {
  id: string;
  startCapital: number;
  targetCapital: number;
  startDate: string;
  monthlyTargetPct: number; // Not guaranteed — just an objective
}

interface ChallengeState {
  config: ChallengeConfig;
  currentCapital: number;
  peakCapital: number;
  totalPnL: number;
  totalPnLPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  monthlyPnL: number;
  monthlyPnLPct: number;
  monthStartCapital: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  progressPct: number;
  isActive: boolean;
  lastUpdated: string;
}

const DEFAULT_CHALLENGE: ChallengeConfig = {
  id: 'CHALLENGE_001',
  startCapital: 15_000,
  targetCapital: 100_000,
  startDate: new Date().toISOString().split('T')[0],
  monthlyTargetPct: 15, // Objective, NOT guaranteed
};

// ─── Orchestrator State ───────────────────────────────────────────
interface OrchestratorState {
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
  startedAt: Date | null;
  lastHeartbeat: Date | null;
  currentMode: NousMode;
  currentSession: MarketSession;
  sessionInfo: ReturnType<typeof getCurrentSession>;
  challengeState: ChallengeState;
  providerHealth: Record<string, any>;
  dataHealth: string;
  recentEvents: HermesEvent[];
  errorCount: number;
  lastError: string | null;
  monitorsActive: string[];
  recovery: RecoveryResult | null;
  morningBrief: MorningIntelligenceBrief | null;
  newsScan: NewsIntelligenceResult | null;
  lastNewsScanAt: Date | null;
  lastMorningBriefAt: Date | null;
}

// ─── Singleton ────────────────────────────────────────────────────
let orchestratorInstance: NousOrchestrator | null = null;

class NousOrchestrator {
  private prisma: PrismaClient;
  private state: OrchestratorState;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionCheckInterval: ReturnType<typeof setInterval> | null = null;
  private challengeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private lastKnownSession: MarketSession = 'OVERNIGHT_RESEARCH';

  constructor() {
    this.prisma = new PrismaClient();
    this.state = {
      status: 'STOPPED',
      startedAt: null,
      lastHeartbeat: null,
      currentMode: 'BOOT',
      currentSession: 'OVERNIGHT_RESEARCH',
      sessionInfo: getCurrentSession(),
      challengeState: this.initChallengeState(),
      providerHealth: {},
      dataHealth: 'UNKNOWN',
      recentEvents: [],
      errorCount: 0,
      lastError: null,
      monitorsActive: [],
      recovery: null,
      morningBrief: null,
      newsScan: null,
      lastNewsScanAt: null,
      lastMorningBriefAt: null,
    };
  }

  private initChallengeState(): ChallengeState {
    return {
      config: { ...DEFAULT_CHALLENGE },
      currentCapital: DEFAULT_CHALLENGE.startCapital,
      peakCapital: DEFAULT_CHALLENGE.startCapital,
      totalPnL: 0,
      totalPnLPct: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      monthlyPnL: 0,
      monthlyPnLPct: 0,
      monthStartCapital: DEFAULT_CHALLENGE.startCapital,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      progressPct: 0,
      isActive: true,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ─── Start ─────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.state.status === 'RUNNING') return;
    this.state.status = 'STARTING';
    this.state.currentMode = 'BOOT';
    console.log('[NousOrchestrator] Starting...');

    // 1. Detect offline gap and recover
    const gap = await detectOfflineGap();
    if (gap.isRecovery) {
      this.state.currentMode = 'RECOVERY';
      console.log(`[NousOrchestrator] Offline gap detected: ${Math.floor(gap.gapSeconds / 60)}m ${gap.gapSeconds % 60}s`);
      this.state.recovery = await recoveryEngine.recover();
      if (this.state.recovery.morningBrief) {
        this.state.morningBrief = this.state.recovery.morningBrief as any;
        this.state.lastMorningBriefAt = new Date();
      }
    }

    // 2. Rebuild state from Prisma
    await this.rebuildState();

    // 3. Start event bus
    const bus = getEventBus();
    await bus.start();

    // 4. Start telegram queue
    const { sendTelegramMessage } = await import('@/lib/telegram');
    const queue = getTelegramQueue();
    await queue.start(sendTelegramMessage);

    // 5. Subscribe to events
    this.subscribeToEvents(bus);

    // 6. Write persistent heartbeat
    await writeHeartbeat(this.state.currentMode, { processId: process.pid });

    // 7. Start heartbeat (every 30s) — writes to Prisma NousState
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 30_000);

    // 8. Start session checker (every 60s)
    this.sessionCheckInterval = setInterval(() => this.checkSession(), 60_000);

    // 9. Start challenge monitor (every 5 minutes)
    this.challengeCheckInterval = setInterval(() => this.monitorChallenge(), 300_000);

    // 10. Cleanup old events (every 30 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupOldEvents(), 30 * 60_000);

    // 11. Process any undelivered events from restart
    await this.processRecoveryEvents();

    // 12. Determine initial mode
    const session = getCurrentSession();
    this.state.currentSession = session.session;
    if (!gap.isRecovery) {
      this.state.currentMode = this.sessionToMode(session.session);
    }
    await transitionMode(this.state.currentMode, gap.isRecovery ? 'Recovery complete' : 'Clean startup');

    // 13. Run initial news scan
    this.scanNews().catch(() => {});

    // 14. Generate morning brief if not done during recovery
    if (!this.state.morningBrief) {
      this.generateMorningBrief().catch(() => {});
    }

    this.state.status = 'RUNNING';
    this.state.startedAt = new Date();

    console.log(`[NousOrchestrator] Started — mode: ${this.state.currentMode}, session: ${formatSessionLabel(this.state.currentSession)}`);

    // Send startup Telegram
    await this.sendStartupSummary(gap.isRecovery);
  }

  // ─── Stop ──────────────────────────────────────────────────────
  async stop(): Promise<void> {
    if (this.state.status === 'STOPPED') return;
    this.state.status = 'STOPPING';
    this.state.currentMode = 'SHUTDOWN_PENDING';
    console.log('[NousOrchestrator] Stopping...');

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.sessionCheckInterval) clearInterval(this.sessionCheckInterval);
    if (this.challengeCheckInterval) clearInterval(this.challengeCheckInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    this.heartbeatInterval = null;
    this.sessionCheckInterval = null;
    this.challengeCheckInterval = null;
    this.cleanupInterval = null;

    // Persist shutdown state
    await persistShutdown();

    await getTelegramQueue().stop();
    await getEventBus().stop();

    this.state.status = 'STOPPED';
    this.state.monitorsActive = [];
    console.log('[NousOrchestrator] Stopped');
  }

  // ─── Rebuild State from Prisma (restart recovery) ──────────────
  private async rebuildState(): Promise<void> {
    try {
      // Restore challenge state from paper account
      const account = await this.prisma.hermesPaperAccount.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (account) {
        this.state.challengeState = {
          config: { ...DEFAULT_CHALLENGE },
          currentCapital: account.currentCapital,
          peakCapital: Math.max(account.currentCapital, this.state.challengeState.peakCapital),
          totalPnL: account.realizedPnL,
          totalPnLPct: ((account.realizedPnL / DEFAULT_CHALLENGE.startCapital) * 100),
          maxDrawdown: account.maxDrawdown,
          maxDrawdownPct: account.maxDrawdownPct,
          monthlyPnL: 0,
          monthlyPnLPct: 0,
          monthStartCapital: account.currentCapital,
          totalTrades: account.totalTrades,
          wins: account.totalWins,
          losses: account.totalLosses,
          winRate: account.totalTrades > 0 ? (account.totalWins / account.totalTrades) * 100 : 0,
          progressPct: ((account.currentCapital - DEFAULT_CHALLENGE.startCapital) / (DEFAULT_CHALLENGE.targetCapital - DEFAULT_CHALLENGE.startCapital)) * 100,
          isActive: account.isActive,
          lastUpdated: new Date().toISOString(),
        };
        console.log('[NousOrchestrator] Restored challenge state: ₹' + account.currentCapital.toLocaleString('en-IN'));
      }

      // Restore event bus state
      const recovery = await getEventBus().getRecoveryState();
      console.log('[NousOrchestrator] Event recovery:', recovery.undeliveredEvents.length, 'undelivered,', recovery.totalPersisted, 'total');
    } catch (err: any) {
      console.error('[NousOrchestrator] Rebuild error:', err.message);
    }
  }

  // ─── Process Recovery Events ───────────────────────────────────
  private async processRecoveryEvents(): Promise<void> {
    try {
      const events = await getEventBus().getUndeliveredEvents(50);
      for (const event of events) {
        const queue = getTelegramQueue();
        await queue.sendEvent(event);
        console.log('[NousOrchestrator] Queued recovery event:', event.eventType);
      }
    } catch (err: any) {
      console.error('[NousOrchestrator] Recovery processing error:', err.message);
    }
  }

  // ─── Subscribe to Events ───────────────────────────────────────
  private subscribeToEvents(bus: ReturnType<typeof getEventBus>): void {
    // Trade lifecycle events
    const tradeEvents: HermesEventType[] = [
      'TRADE_CREATED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT',
      'TRAILING_SL_UPDATED', 'THESIS_INVALIDATED', 'TIME_EXIT',
      'EXPIRY_EXIT', 'TRADE_CLOSED',
    ];
    for (const evt of tradeEvents) {
      bus.on(evt, (event: HermesEvent) => this.onTradeEvent(event));
    }

    // Provider events
    bus.on('PROVIDER_FAILURE', (event: HermesEvent) => this.onProviderEvent(event));
    bus.on('PROVIDER_RECOVERY', (event: HermesEvent) => this.onProviderEvent(event));

    // Market events
    bus.on('MARKET_REGIME_CHANGE', (event: HermesEvent) => this.onMarketEvent(event));
    bus.on('DATA_STALE', (event: HermesEvent) => this.onDataEvent(event));

    // Challenge events
    bus.on('CHALLENGE_MILESTONE', (event: HermesEvent) => this.onChallengeEvent(event));
    bus.on('CHALLENGE_DRAWDOWN', (event: HermesEvent) => this.onChallengeEvent(event));

    // Health events
    bus.on('HEALTH_DEGRADED', (event: HermesEvent) => this.onHealthEvent(event));
  }

  // ─── Event Handlers ────────────────────────────────────────────
  private async onTradeEvent(event: HermesEvent): Promise<void> {
    // Send Telegram for all trade events
    const queue = getTelegramQueue();
    await queue.sendEvent(event);
    console.log(`[NousOrchestrator] Trade event: ${event.eventType} — ${event.symbol}`);

    // Track in recent events
    this.state.recentEvents.unshift(event);
    if (this.state.recentEvents.length > 50) this.state.recentEvents = this.state.recentEvents.slice(0, 50);
  }

  private async onProviderEvent(event: HermesEvent): Promise<void> {
    this.state.providerHealth[event.payload.provider] = {
      status: event.eventType,
      error: event.payload.error,
      timestamp: event.timestamp,
    };
    console.log(`[NousOrchestrator] Provider event: ${event.eventType} — ${event.payload.provider}`);
  }

  private async onMarketEvent(event: HermesEvent): Promise<void> {
    console.log(`[NousOrchestrator] Market event: ${event.eventType} — ${event.symbol}`);
    // Only send Telegram for regime changes during market hours
    if (this.state.currentSession === 'MARKET_OPEN') {
      const queue = getTelegramQueue();
      await queue.sendEvent(event);
    }
  }

  private async onDataEvent(event: HermesEvent): Promise<void> {
    this.state.dataHealth = event.eventType === 'DATA_STALE' ? 'DEGRADED' : 'HEALTHY';
  }

  private async onChallengeEvent(event: HermesEvent): Promise<void> {
    const queue = getTelegramQueue();
    await queue.sendEvent(event);
    console.log(`[NousOrchestrator] Challenge event: ${event.eventType}`);
  }

  private async onHealthEvent(event: HermesEvent): Promise<void> {
    console.log(`[NousOrchestrator] Health event: ${event.eventType} — ${event.payload.component}`);
  }

  // ─── Heartbeat ─────────────────────────────────────────────────
  private async heartbeat(): Promise<void> {
    this.state.lastHeartbeat = new Date();

    // Check provider health
    try {
      const { providerHealth } = await import('@/lib/provider-health');
      const providers = providerHealth.getAllStatus();
      this.state.providerHealth = providers;
    } catch {}

    // Update session info
    this.state.sessionInfo = getCurrentSession();
    this.state.currentSession = this.state.sessionInfo.session;

    // Write heartbeat to Prisma NousState (persistent, survives restart)
    await writeHeartbeat(this.state.currentMode, { processId: process.pid, cycleAt: new Date() });

    // Also write to HermesEvent (for health endpoint cross-process check)
    try {
      await this.prisma.hermesEvent.upsert({
        where: { eventId: 'HEARTBEAT' },
        create: {
          eventId: 'HEARTBEAT',
          eventType: 'HEARTBEAT',
          symbol: 'SYSTEM',
          payload: JSON.stringify({
            mode: this.state.currentMode,
            session: this.state.currentSession,
            challenge: this.state.challengeState.currentCapital,
            monitors: this.state.monitorsActive,
            recovery: this.state.recovery?.success ?? null,
          }),
          delivered: true,
          deliveredAt: new Date(),
        },
        update: {
          payload: JSON.stringify({
            mode: this.state.currentMode,
            session: this.state.currentSession,
            challenge: this.state.challengeState.currentCapital,
            monitors: this.state.monitorsActive,
            recovery: this.state.recovery?.success ?? null,
          }),
          deliveredAt: new Date(),
        },
      });
    } catch {}
  }

  // ─── Session Check ─────────────────────────────────────────────
  private async checkSession(): Promise<void> {
    const session = getCurrentSession();
    this.state.sessionInfo = session;
    this.state.currentSession = session.session;

    // Detect session change
    if (session.session !== this.lastKnownSession) {
      console.log(`[NousOrchestrator] Session change: ${formatSessionLabel(this.lastKnownSession)} → ${formatSessionLabel(session.session)}`);
      this.lastKnownSession = session.session;

      // Update active monitors
      this.state.monitorsActive = [];
      if (shouldMonitorSignals(session.session)) this.state.monitorsActive.push('signals');
      if (shouldMonitorTrades(session.session)) this.state.monitorsActive.push('trades');
      if (shouldRunResearch(session.session)) this.state.monitorsActive.push('research');
      this.state.monitorsActive.push('health'); // Always run

      // Transition mode based on session
      const newMode = this.sessionToMode(session.session);
      if (newMode !== this.state.currentMode) {
        this.state.currentMode = newMode;
        await transitionMode(newMode, `Session changed to ${session.session}`);
      }

      // Emit session change event
      await getEventBus().emit('SESSION_CHANGE', {
        previous: this.lastKnownSession,
        current: session.session,
        activeMarkets: session.activeMarkets,
        isExpiry: session.isExpiry,
      });

      // Trigger intelligence based on session
      if (session.session === 'PRE_MARKET' || session.session === 'OVERNIGHT_RESEARCH') {
        this.generateMorningBrief().catch(() => {});
        this.scanNews().catch(() => {});
      }
    }
  }

  // ─── Map Session to Nous Mode ──
  private sessionToMode(session: MarketSession): NousMode {
    switch (session) {
      case 'OVERNIGHT_RESEARCH': return 'OVERNIGHT_RESEARCH';
      case 'PRE_MARKET': return 'PRE_MARKET';
      case 'MARKET_OPEN': return 'MARKET_OPEN';
      case 'MARKET_ACTIVE': return 'MARKET_ACTIVE';
      case 'POST_MARKET': return 'POST_MARKET';
      case 'MCX_SESSION': return 'MCX_SESSION';
      case 'WEEKEND': return 'WEEKEND';
      case 'HOLIDAY': return 'HOLIDAY';
      default: return 'OVERNIGHT_RESEARCH';
    }
  }

  // ─── News Scan ──
  private async scanNews(): Promise<void> {
    try {
      this.state.newsScan = await newsIntelligence.scan(undefined, 50);
      this.state.lastNewsScanAt = new Date();
      console.log(`[NousOrchestrator] News scan: ${this.state.newsScan.totalScanned} scanned, ${this.state.newsScan.critical} critical`);
    } catch (err: any) {
      console.error('[NousOrchestrator] News scan error:', err.message?.substring(0, 100));
    }
  }

  // ─── Morning Brief ──
  private async generateMorningBrief(): Promise<void> {
    try {
      this.state.morningBrief = await morningIntelligence.generate();
      this.state.lastMorningBriefAt = new Date();
      console.log(`[NousOrchestrator] Morning brief: bias=${this.state.morningBrief.morningBias}, status=${this.state.morningBrief.status}`);
    } catch (err: any) {
      console.error('[NousOrchestrator] Morning brief error:', err.message?.substring(0, 100));
    }
  }

  // ─── Send Startup Summary ──
  private async sendStartupSummary(isRecovery: boolean): Promise<void> {
    try {
      // Skip startup alert during non-trading hours (overnight, weekend, post-market)
      const session = this.state.currentSession;
      if (session === 'OVERNIGHT_RESEARCH' || session === 'WEEKEND' || session === 'POST_MARKET') {
        console.log(`[NousOrchestrator] Startup alert skipped — session: ${session}`);
        return;
      }

      const mode = this.state.currentMode;
      const sessionLabel = formatSessionLabel(session);
      const capital = this.state.challengeState.currentCapital;
      const progress = this.state.challengeState.progressPct.toFixed(1);

      let text = `<b>NOUS HERMES — STARTED</b>\n\n`;
      text += `Mode: <b>${mode}</b>\n`;
      text += `Session: ${sessionLabel}\n`;
      text += `Challenge: ₹${capital.toLocaleString('en-IN')} (${progress}%)\n`;

      if (isRecovery && this.state.recovery) {
        text += `\n<b>RECOVERY</b>\n`;
        text += `Offline gap: ${this.state.recovery.gapFormatted}\n`;
        text += `Health: ${this.state.recovery.dataHealthScore}%\n`;
        text += `Recovered: ${this.state.recovery.recoveredItems.length} items\n`;
        if (this.state.recovery.unrecoverableItems.length > 0) {
          text += `Unrecoverable: ${this.state.recovery.unrecoverableItems.length} items\n`;
        }
      }

      if (this.state.morningBrief) {
        text += `\n<b>MORNING BRIEF</b>\n`;
        text += `Bias: ${this.state.morningBrief.morningBias}\n`;
        if (this.state.morningBrief.vix.value) {
          text += `VIX: ${this.state.morningBrief.vix.value.toFixed(1)}\n`;
        }
        if (this.state.morningBrief.news) {
          text += `News: ${this.state.morningBrief.news.totalScanned} scanned, ${this.state.morningBrief.news.critical} critical\n`;
        }
      }

      // Telegram startup card disabled — restart notices have no trade
      // value. Recovery/startup detail stays in server logs only.
      console.log(`[NousOrchestrator] Startup summary (log-only, telegram disabled):\n${text.replace(/<[^>]+>/g, "")}`);
    } catch (err: any) {
      console.error('[NousOrchestrator] Startup summary error:', err.message?.substring(0, 100));
    }
  }

  // ─── Challenge Monitor ─────────────────────────────────────────
  private async monitorChallenge(): Promise<void> {
    if (!this.state.challengeState.isActive) return;

    try {
      const account = await this.prisma.hermesPaperAccount.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (!account) return;

      const cs = this.state.challengeState;
      const prevCapital = cs.currentCapital;
      cs.currentCapital = account.currentCapital;
      cs.peakCapital = Math.max(cs.peakCapital, account.currentCapital);
      cs.totalPnL = account.realizedPnL;
      cs.totalPnLPct = ((account.realizedPnL / DEFAULT_CHALLENGE.startCapital) * 100);
      cs.totalTrades = account.totalTrades;
      cs.wins = account.totalWins;
      cs.losses = account.totalLosses;
      cs.winRate = account.totalTrades > 0 ? (account.totalWins / account.totalTrades) * 100 : 0;
      cs.progressPct = ((account.currentCapital - DEFAULT_CHALLENGE.startCapital) / (DEFAULT_CHALLENGE.targetCapital - DEFAULT_CHALLENGE.startCapital)) * 100;

      // Drawdown tracking
      const drawdown = cs.peakCapital - cs.currentCapital;
      const drawdownPct = cs.peakCapital > 0 ? (drawdown / cs.peakCapital) * 100 : 0;
      if (drawdownPct > cs.maxDrawdownPct) {
        cs.maxDrawdown = drawdown;
        cs.maxDrawdownPct = drawdownPct;
      }

      // Monthly reset (check if new month)
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const prevMonth = `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
      if (cs.lastUpdated.split('-').slice(0, 2).join('-') !== monthKey) {
        cs.monthStartCapital = cs.currentCapital;
        cs.monthlyPnL = 0;
        cs.monthlyPnLPct = 0;
      }
      cs.monthlyPnL = cs.currentCapital - cs.monthStartCapital;
      cs.monthlyPnLPct = cs.monthStartCapital > 0 ? (cs.monthlyPnL / cs.monthStartCapital) * 100 : 0;

      cs.lastUpdated = now.toISOString();

      // Check milestones (every 10% progress)
      const prevMilestone = Math.floor(((prevCapital - DEFAULT_CHALLENGE.startCapital) / (DEFAULT_CHALLENGE.targetCapital - DEFAULT_CHALLENGE.startCapital)) * 10) * 10;
      const currentMilestone = Math.floor(cs.progressPct / 10) * 10;
      if (currentMilestone > prevMilestone && currentMilestone > 0) {
        await getEventBus().emitChallengeMilestone({
          challengeId: cs.config.id,
          currentCapital: cs.currentCapital,
          targetCapital: cs.config.targetCapital,
          progressPct: cs.progressPct,
          totalPnL: cs.totalPnL,
        });
      }

      // Check drawdown (>10%)
      if (cs.maxDrawdownPct > 10 && prevCapital === cs.currentCapital) {
        // Only alert once per capital level
      } else if (cs.maxDrawdownPct > 10) {
        await getEventBus().emitChallengeDrawdown({
          challengeId: cs.config.id,
          currentCapital: cs.currentCapital,
          drawdownPct: cs.maxDrawdownPct,
          maxDrawdownPct: cs.maxDrawdownPct,
        });
      }
    } catch (err: any) {
      console.error('[NousOrchestrator] Challenge monitor error:', err.message);
    }
  }

  // ─── Cleanup Old Events ────────────────────────────────────────
  private async cleanupOldEvents(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
      await this.prisma.hermesEvent.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          delivered: true,
        },
      });
    } catch {}
  }

  // ─── Status ────────────────────────────────────────────────────
  getState(): OrchestratorState {
    return { ...this.state };
  }

  isRunning(): boolean {
    return this.state.status === 'RUNNING';
  }

  getCurrentMode(): NousMode {
    return this.state.currentMode;
  }

  getRecovery(): RecoveryResult | null {
    return this.state.recovery;
  }

  getMorningBrief(): MorningIntelligenceBrief | null {
    return this.state.morningBrief;
  }

  getNewsScan(): NewsIntelligenceResult | null {
    return this.state.newsScan;
  }
}

// ─── Get Singleton ────────────────────────────────────────────────
export function getNousOrchestrator(): NousOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new NousOrchestrator();
  }
  return orchestratorInstance;
}

// ─── Convenience Exports ──────────────────────────────────────────
export type { OrchestratorState, ChallengeState, ChallengeConfig };

export async function startOrchestrator(): Promise<void> {
  return getNousOrchestrator().start();
}

export async function stopOrchestrator(): Promise<void> {
  return getNousOrchestrator().stop();
}

export function getOrchestratorState(): OrchestratorState {
  return getNousOrchestrator().getState();
}

export function isOrchestratorRunning(): boolean {
  return getNousOrchestrator().isRunning();
}

export function getNousMode(): NousMode {
  return getNousOrchestrator().getCurrentMode();
}

export function getNousRecovery(): RecoveryResult | null {
  return getNousOrchestrator().getRecovery();
}

export function getNousMorningBrief(): MorningIntelligenceBrief | null {
  return getNousOrchestrator().getMorningBrief();
}

export function getNousNewsScan(): NewsIntelligenceResult | null {
  return getNousOrchestrator().getNewsScan();
}
