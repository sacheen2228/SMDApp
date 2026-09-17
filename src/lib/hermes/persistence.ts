// NOUS HERMES — Persistence Layer
// Heartbeat, state snapshots, shutdown persistence, startup recovery
// All state survives restart via Prisma NousState + MarketSnapshot tables

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// In-memory mutex to serialize transitionMode calls (prevents race condition on startup)
let transitionMutex: Promise<void> = Promise.resolve();
function withTransitionMutex<T>(fn: () => Promise<T>): Promise<T> {
  const current = transitionMutex;
  let release: () => void;
  transitionMutex = new Promise<void>(resolve => { release = resolve; });
  return current.then(() => fn()).finally(() => release!());
};

// ── Nous Modes ──
export type NousMode =
  | 'BOOT'
  | 'RECOVERY'
  | 'PRE_MARKET'
  | 'MARKET_OPEN'
  | 'MARKET_ACTIVE'
  | 'POST_MARKET'
  | 'OVERNIGHT_RESEARCH'
  | 'MCX_SESSION'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'SHUTDOWN_PENDING'
  | 'OFFLINE_GAP'
  | 'ERROR_RECOVERY';

export type RecoveryStatus = 'NONE' | 'IN_PROGRESS' | 'COMPLETE' | 'PARTIAL';

// ── Session History Entry ──
export interface SessionTransition {
  from: NousMode;
  to: NousMode;
  timestamp: string;
  reason: string;
}

// ── Market Snapshot Data ──
export interface SnapshotData {
  session: string;
  mode: NousMode;
  indices: Record<string, any>;
  breadth: Record<string, any>;
  vix: number | null;
  fiiDii: Record<string, any>;
  sectors: any[];
  mcx: Record<string, any>;
  news: any[];
  providerHealth: Record<string, any>;
  candidates: any[];
  dataHealthScore: number;
}

// ── Core Persistence Manager ──
class NousPersistence {
  private static instance: NousPersistence;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

  static getInstance(): NousPersistence {
    if (!NousPersistence.instance) {
      NousPersistence.instance = new NousPersistence();
    }
    return NousPersistence.instance;
  }

  // ── Heartbeat ──

  async writeHeartbeat(mode: NousMode, extra?: { processId?: number; cycleAt?: Date }): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: {
          lastHeartbeat: new Date(),
          currentMode: mode,
          processId: extra?.processId ?? process.pid,
          lastCycleAt: extra?.cycleAt,
        },
        create: {
          id: 'nous-main',
          currentMode: mode,
          processId: extra?.processId ?? process.pid,
          lastHeartbeat: new Date(),
        },
      });
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Heartbeat write failed:', err.message?.substring(0, 100));
    }
  }

  async readHeartbeat(): Promise<{
    lastHeartbeat: Date | null;
    currentMode: NousMode;
    offlineGapSeconds: number;
    isRecovering: boolean;
  } | null> {
    try {
      const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
      if (!state) return null;

      const now = new Date();
      const lastHb = state.lastHeartbeat;
      const gapSeconds = lastHb ? Math.floor((now.getTime() - lastHb.getTime()) / 1000) : 0;

      return {
        lastHeartbeat: lastHb,
        currentMode: state.currentMode as NousMode,
        offlineGapSeconds: gapSeconds,
        isRecovering: state.isRecovering,
      };
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Heartbeat read failed:', err.message?.substring(0, 100));
      return null;
    }
  }

  // ── Mode Transitions ──

  async transitionMode(to: NousMode, reason: string): Promise<void> {
    return withTransitionMutex(async () => {
      try {
        // Re-read state after mutex to catch cross-process writes
        const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
        if (state?.currentMode === to) {
          console.log(`[NOUS-PERSIST] Already in target mode ${to}, skipping`);
          return;
        }
        const from = (state?.currentMode || 'BOOT') as NousMode;

        // Add to session history (keep last 50 transitions)
        let history: SessionTransition[] = [];
        try {
          history = JSON.parse(state?.sessionHistory || '[]');
        } catch {}

        const last = history[history.length - 1];
        // Idempotent: suppress duplicate if already in target mode (race condition safe)
        const alreadyInTargetMode = state?.currentMode === to;
        const isDuplicate = alreadyInTargetMode || (last && last.to === to && last.reason === reason);
        
        if (!isDuplicate) {
          history.push({ from, to, timestamp: new Date().toISOString(), reason });
          if (history.length > 50) history = history.slice(-50);
        } else {
          console.log(`[NOUS-PERSIST] Duplicate transition suppressed: ${from} → ${to} (${reason})`);
        }

        await prisma.nousState.upsert({
          where: { id: 'nous-main' },
          update: {
            previousMode: from,
            currentMode: to,
            sessionHistory: JSON.stringify(history),
          },
          create: {
            id: 'nous-main',
            currentMode: to,
            previousMode: from,
            sessionHistory: JSON.stringify(history),
          },
        });

        // Cross-process race cleanup: re-read and deduplicate if needed
        const verifyState = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
        if (verifyState?.sessionHistory) {
          const verifyHist = JSON.parse(verifyState.sessionHistory);
          if (verifyHist.length >= 2) {
            const last = verifyHist[verifyHist.length - 1];
            const prev = verifyHist[verifyHist.length - 2];
            if (last.to === prev.to && last.reason === prev.reason) {
              // Duplicate detected - remove the duplicate
              verifyHist.pop();
              await prisma.nousState.update({
                where: { id: 'nous-main' },
                data: { sessionHistory: JSON.stringify(verifyHist) },
              });
              console.log(`[NOUS-PERSIST] Cross-process duplicate removed: ${last.from} → ${last.to} (${last.reason})`);
            }
          }
        }

        if (!isDuplicate) {
          console.log(`[NOUS-PERSIST] Mode: ${from} → ${to} (${reason})`);
        }
      } catch (err: any) {
        console.error('[NOUS-PERSIST] Mode transition failed:', err.message?.substring(0, 100));
      }
    });
  }

  // ── Shutdown Persistence ──

  async persistShutdown(): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: {
          lastShutdownAt: new Date(),
          currentMode: 'SHUTDOWN_PENDING',
          isRecovering: false,
        },
        create: {
          id: 'nous-main',
          currentMode: 'SHUTDOWN_PENDING',
          lastShutdownAt: new Date(),
        },
      });
      console.log('[NOUS-PERSIST] Shutdown state persisted');
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Shutdown persist failed:', err.message?.substring(0, 100));
    }
  }

  // ── Recovery Detection ──

  async detectOfflineGap(): Promise<{
    isRecovery: boolean;
    gapSeconds: number;
    lastShutdown: Date | null;
    lastHeartbeat: Date | null;
    previousMode: NousMode;
  }> {
    try {
      const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
      if (!state) {
        return { isRecovery: false, gapSeconds: 0, lastShutdown: null, lastHeartbeat: null, previousMode: 'BOOT' };
      }

      const now = new Date();
      const lastHb = state.lastHeartbeat;
      const lastSd = state.lastShutdownAt;

      // Use the most recent timestamp (shutdown or heartbeat)
      const referenceTime = lastSd && lastHb
        ? (lastSd > lastHb ? lastSd : lastHb)
        : lastHb || lastSd;

      const gapSeconds = referenceTime
        ? Math.floor((now.getTime() - referenceTime.getTime()) / 1000)
        : 0;

      // Recovery threshold: 5 minutes (300 seconds)
      const isRecovery = gapSeconds > 300 && state.currentMode !== 'BOOT';

      return {
        isRecovery,
        gapSeconds,
        lastShutdown: lastSd,
        lastHeartbeat: lastHb,
        previousMode: state.currentMode as NousMode,
      };
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Offline gap detection failed:', err.message?.substring(0, 100));
      return { isRecovery: false, gapSeconds: 0, lastShutdown: null, lastHeartbeat: null, previousMode: 'BOOT' };
    }
  }

  // ── Recovery State ──

  async startRecovery(gapSeconds: number): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: {
          isRecovering: true,
          offlineGapSeconds: gapSeconds,
          recoveryStatus: 'IN_PROGRESS',
          lastRecoveryAt: new Date(),
        },
        create: {
          id: 'nous-main',
          currentMode: 'RECOVERY',
          isRecovering: true,
          offlineGapSeconds: gapSeconds,
          recoveryStatus: 'IN_PROGRESS',
          lastRecoveryAt: new Date(),
        },
      });
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Start recovery failed:', err.message?.substring(0, 100));
    }
  }

  async completeRecovery(data: {
    recoveredItems: string[];
    unrecoverableItems: string[];
    dataHealthScore: number;
  }): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: {
          isRecovering: false,
          recoveryStatus: data.unrecoverableItems.length > 0 ? 'PARTIAL' : 'COMPLETE',
          recoveryData: JSON.stringify(data),
          offlineGapSeconds: 0,
        },
        create: {
          id: 'nous-main',
          currentMode: 'RECOVERY',
          isRecovering: false,
          recoveryStatus: data.unrecoverableItems.length > 0 ? 'PARTIAL' : 'COMPLETE',
          recoveryData: JSON.stringify(data),
        },
      });
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Complete recovery failed:', err.message?.substring(0, 100));
    }
  }

  // ── Market Snapshots ──

  async saveSnapshot(data: SnapshotData): Promise<void> {
    try {
      await prisma.marketSnapshot.create({
        data: {
          session: data.session,
          mode: data.mode,
          indices: JSON.stringify(data.indices),
          breadth: JSON.stringify(data.breadth),
          vix: data.vix,
          fiiDii: JSON.stringify(data.fiiDii),
          sectors: JSON.stringify(data.sectors),
          mcx: JSON.stringify(data.mcx),
          news: JSON.stringify(data.news),
          providerHealth: JSON.stringify(data.providerHealth),
          candidates: JSON.stringify(data.candidates),
          dataHealthScore: data.dataHealthScore,
        },
      });

      // Keep only last 200 snapshots
      const count = await prisma.marketSnapshot.count();
      if (count > 200) {
        const cutoff = await prisma.marketSnapshot.findMany({
          orderBy: { timestamp: 'asc' },
          take: count - 200,
          select: { id: true },
        });
        await prisma.marketSnapshot.deleteMany({
          where: { id: { in: cutoff.map(s => s.id) } },
        });
      }
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Snapshot save failed:', err.message?.substring(0, 100));
    }
  }

  async getLatestSnapshot(): Promise<SnapshotData | null> {
    try {
      const snap = await prisma.marketSnapshot.findFirst({
        orderBy: { timestamp: 'desc' },
      });
      if (!snap) return null;

      return {
        session: snap.session,
        mode: snap.mode as NousMode,
        indices: JSON.parse(snap.indices),
        breadth: JSON.parse(snap.breadth),
        vix: snap.vix,
        fiiDii: JSON.parse(snap.fiiDii),
        sectors: JSON.parse(snap.sectors),
        mcx: JSON.parse(snap.mcx),
        news: JSON.parse(snap.news),
        providerHealth: JSON.parse(snap.providerHealth),
        candidates: JSON.parse(snap.candidates),
        dataHealthScore: snap.dataHealthScore,
      };
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Snapshot read failed:', err.message?.substring(0, 100));
      return null;
    }
  }

  async getSnapshotHistory(limit: number = 10): Promise<Array<{ timestamp: Date; session: string; mode: string; dataHealthScore: number }>> {
    try {
      const snaps = await prisma.marketSnapshot.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit,
        select: {
          timestamp: true,
          session: true,
          mode: true,
          dataHealthScore: true,
        },
      });
      return snaps;
    } catch {
      return [];
    }
  }

  // ── Pending Tasks ──

  async savePendingTasks(tasks: any[]): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: { pendingTasks: JSON.stringify(tasks) },
        create: { id: 'nous-main', currentMode: 'OFFLINE_GAP', pendingTasks: JSON.stringify(tasks) },
      });
    } catch {}
  }

  async getPendingTasks(): Promise<any[]> {
    try {
      const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
      return state ? JSON.parse(state.pendingTasks) : [];
    } catch {
      return [];
    }
  }

  // ── Market Snapshot (in NousState for quick access) ──

  async saveMarketSnapshotQuick(snapshot: Record<string, any>): Promise<void> {
    try {
      await prisma.nousState.upsert({
        where: { id: 'nous-main' },
        update: { marketSnapshot: JSON.stringify(snapshot) },
        create: { id: 'nous-main', currentMode: 'OFFLINE_GAP', marketSnapshot: JSON.stringify(snapshot) },
      });
    } catch {}
  }

  async getMarketSnapshotQuick(): Promise<Record<string, any> | null> {
    try {
      const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
      return state ? JSON.parse(state.marketSnapshot) : null;
    } catch {
      return null;
    }
  }

  // ── Cleanup ──

  async cleanupOldSnapshots(keepDays: number = 7): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - keepDays);
      await prisma.marketSnapshot.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
    } catch {}
  }

  // ── Full State Read (for recovery) ──

  async readFullState(): Promise<{
    mode: NousMode;
    heartbeat: Date | null;
    shutdown: Date | null;
    recovery: { status: RecoveryStatus | null; gap: number; lastAt: Date | null };
    snapshot: Record<string, any> | null;
    pendingTasks: any[];
    sessionHistory: SessionTransition[];
  } | null> {
    try {
      const state = await prisma.nousState.findUnique({ where: { id: 'nous-main' } });
      if (!state) return null;

      return {
        mode: state.currentMode as NousMode,
        heartbeat: state.lastHeartbeat,
        shutdown: state.lastShutdownAt,
        recovery: {
          status: state.recoveryStatus as RecoveryStatus | null,
          gap: state.offlineGapSeconds,
          lastAt: state.lastRecoveryAt,
        },
        snapshot: JSON.parse(state.marketSnapshot),
        pendingTasks: JSON.parse(state.pendingTasks),
        sessionHistory: JSON.parse(state.sessionHistory),
      };
    } catch (err: any) {
      console.error('[NOUS-PERSIST] Full state read failed:', err.message?.substring(0, 100));
      return null;
    }
  }
}

// ── Singleton ──
export const nousPersistence = NousPersistence.getInstance();

// ── Convenience Functions ──
export const writeHeartbeat = (mode: NousMode, extra?: { processId?: number; cycleAt?: Date }) =>
  nousPersistence.writeHeartbeat(mode, extra);

export const readHeartbeat = () => nousPersistence.readHeartbeat();

export const transitionMode = (to: NousMode, reason: string) =>
  nousPersistence.transitionMode(to, reason);

export const persistShutdown = () => nousPersistence.persistShutdown();

export const detectOfflineGap = () => nousPersistence.detectOfflineGap();

export const startRecovery = (gapSeconds: number) => nousPersistence.startRecovery(gapSeconds);

export const completeRecovery = (data: { recoveredItems: string[]; unrecoverableItems: string[]; dataHealthScore: number }) =>
  nousPersistence.completeRecovery(data);

export const saveSnapshot = (data: SnapshotData) => nousPersistence.saveSnapshot(data);

export const getLatestSnapshot = () => nousPersistence.getLatestSnapshot();

export const readFullState = () => nousPersistence.readFullState();
