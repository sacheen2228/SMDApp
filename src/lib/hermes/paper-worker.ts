// Hermes Paper Trading — Persistent Singleton Worker
// Survives API request termination. Only ONE worker per process.
// Uses Prisma for persistence. Uses market-data-manager for live data.

import { PrismaClient } from "@prisma/client";
import { hermesPro } from "./agent";
import { validateTrade, isTradeValid } from "./trade-validator";
import { getStandardizedExpiry, isExpiryDay } from "../expiry-calculator";
import { getInstrumentConfig, isMCXInstrument } from "../instrument-config";
import { marketDataManager } from "../market-data-manager";
import { classifyFreshness } from "./freshness";
import { sendPaperTradeSignal, sendPaperTradeExit } from "./paper-telegram";
import { PaperPerformanceEngine } from "./paper-performance";
import { getEventBus, emitTradeCreated, emitTP1Hit, emitTP2Hit, emitSLHit, emitTradeClosed, emitTrailingSL, emitThesisInvalidated, emitTimeExit, emitExpiryExit } from "./event-bus";
import { randomBytes } from "crypto";
import { releaseTradeLock } from "../active-trade-lock";
import { recordSignalOutcome } from "@/lib/agents/reputation";

// ── Singleton State ─────────────────────────────────────────────────────

export type WorkerStatus = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

interface WorkerState {
  status: WorkerStatus;
  lastSignalEvaluation: Date | null;
  lastTradeMonitor: Date | null;
  lastNoTradeCheck: Date | null;
  signalsToday: number;
  noTradeToday: number;
  errorCount: number;
  lastError: string | null;
  startedAt: Date | null;
}

let worker: PaperWorkerSingleton | null = null;

// ── Configuration ───────────────────────────────────────────────────────

export interface PaperWorkerConfig {
  enabled: boolean;
  signalEvaluationIntervalMs: number;  // default 30s
  tradeMonitoringIntervalMs: number;   // default 5s
  minimumScore: number;                // default 60
  signalCooldownMinutes: number;       // default 10
  maxOpenPaperTrades: number;          // default 5
  maxHoldingMinutes: number;           // default 390
  paperSlippageBps: number;            // default 5
  startingCapital: number;             // default 100000
  noTradeObservationWindowMs: number;  // default 60min
  instruments: string[];               // default NSE indices
  sendTelegram: boolean;               // default true
}

const DEFAULT_CONFIG: PaperWorkerConfig = {
  enabled: true,
  signalEvaluationIntervalMs: 30_000,
  tradeMonitoringIntervalMs: 5_000,
  minimumScore: 60,
  signalCooldownMinutes: 10,
  maxOpenPaperTrades: 5,
  maxHoldingMinutes: 390,
  paperSlippageBps: 5,
  startingCapital: 100_000,
  noTradeObservationWindowMs: 60 * 60_000,
  instruments: ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"],
  sendTelegram: true,
};

// ── Signal Deduplication ────────────────────────────────────────────────

const recentSignals = new Map<string, number>();

function isDuplicate(key: string, cooldownMs: number): boolean {
  const last = recentSignals.get(key);
  if (last && Date.now() - last < cooldownMs) return true;
  recentSignals.set(key, Date.now());
  // Cleanup old entries
  if (recentSignals.size > 500) {
    const cutoff = Date.now() - 3600_000;
    for (const [k, v] of recentSignals) {
      if (v < cutoff) recentSignals.delete(k);
    }
  }
  return false;
}

// ── Prisma Helpers ──────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function loadOpenTrades(): Promise<any[]> {
  return prisma.hermesPaperTrade.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
}

async function loadPendingNoTradeObs(): Promise<any[]> {
  return prisma.hermesNoTradeObservation.findMany({
    where: { classification: null },
    orderBy: { createdAt: "desc" },
  });
}

async function saveTrade(trade: any): Promise<void> {
  await prisma.hermesPaperTrade.upsert({
    where: { signalId: trade.signalId },
    create: trade,
    update: trade,
  });
}

async function saveNoTradeObs(obs: any): Promise<void> {
  await prisma.hermesNoTradeObservation.upsert({
    where: { id: obs.id },
    create: obs,
    update: obs,
  });
}

async function upsertAccount(data: {
  totalSignals?: number;
  totalTrades?: number;
  totalWins?: number;
  totalLosses?: number;
  totalNoTrade?: number;
  currentCapital?: number;
  realizedPnL?: number;
  dailyPnL?: number;
  maxDrawdown?: number;
  maxDrawdownPct?: number;
  openTrades?: number;
  isActive?: boolean;
}): Promise<void> {
  const existing = await prisma.hermesPaperAccount.findFirst();
  if (existing) {
    await prisma.hermesPaperAccount.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await prisma.hermesPaperAccount.create({
      data: {
        startingCapital: DEFAULT_CONFIG.startingCapital,
        currentCapital: DEFAULT_CONFIG.startingCapital,
        availableCapital: DEFAULT_CONFIG.startingCapital,
        ...data,
      },
    });
  }
}

// ── Singleton Worker ────────────────────────────────────────────────────

class PaperWorkerSingleton {
  private config: PaperWorkerConfig;
  private state: WorkerState;
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private noTradeTimer: ReturnType<typeof setInterval> | null = null;
  private openTrades: any[] = [];
  private pendingNoTrade: any[] = [];
  private performance = new PaperPerformanceEngine();

  constructor(config: Partial<PaperWorkerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      status: "STOPPED",
      lastSignalEvaluation: null,
      lastTradeMonitor: null,
      lastNoTradeCheck: null,
      signalsToday: 0,
      noTradeToday: 0,
      errorCount: 0,
      lastError: null,
      startedAt: null,
    };
  }

  async start(): Promise<WorkerState> {
    if (this.state.status === "RUNNING" || this.state.status === "STARTING") {
      return this.state;
    }

    this.state.status = "STARTING";
    this.state.lastError = null;

    try {
      // Load open trades from database
      this.openTrades = await loadOpenTrades();
      this.pendingNoTrade = await loadPendingNoTradeObs();

      console.log(`[PaperWorker] Loaded ${this.openTrades.length} open trades, ${this.pendingNoTrade.length} pending NO_TRADE observations`);

      // Update account
      await upsertAccount({
        isActive: true,
        openTrades: this.openTrades.length,
      });

      // Start signal evaluation timer
      this.signalTimer = setInterval(
        () => this.evaluateSignals(),
        this.config.signalEvaluationIntervalMs
      );

      // Start trade monitoring timer
      this.monitorTimer = setInterval(
        () => this.monitorOpenTrades(),
        this.config.tradeMonitoringIntervalMs
      );

      // Start NO_TRADE observation check timer
      this.noTradeTimer = setInterval(
        () => this.checkNoTradeObservations(),
        60_000 // check every minute
      );

      this.state.status = "RUNNING";
      this.state.startedAt = new Date();
      this.state.lastSignalEvaluation = new Date();
      this.state.lastTradeMonitor = new Date();

      console.log("[PaperWorker] Started — signal evaluation every " +
        `${this.config.signalEvaluationIntervalMs / 1000}s, monitoring every ` +
        `${this.config.tradeMonitoringIntervalMs / 1000}s`);

      return this.state;
    } catch (err: any) {
      this.state.status = "ERROR";
      this.state.lastError = err.message;
      this.state.errorCount++;
      console.error("[PaperWorker] Start failed:", err.message);
      return this.state;
    }
  }

  async stop(): Promise<WorkerState> {
    if (this.state.status === "STOPPED" || this.state.status === "STOPPING") {
      return this.state;
    }

    this.state.status = "STOPPING";

    if (this.signalTimer) {
      clearInterval(this.signalTimer);
      this.signalTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.noTradeTimer) {
      clearInterval(this.noTradeTimer);
      this.noTradeTimer = null;
    }

    await upsertAccount({ isActive: false });

    this.state.status = "STOPPED";
    console.log("[PaperWorker] Stopped");
    return this.state;
  }

  getState(): WorkerState {
    return { ...this.state };
  }

  getConfig(): PaperWorkerConfig {
    return { ...this.config };
  }

  // ── Signal Evaluation ────────────────────────────────────────────

  private async evaluateSignals(): Promise<void> {
    if (this.state.status !== "RUNNING") return;

    try {
      // Check max open trades
      if (this.openTrades.length >= this.config.maxOpenPaperTrades) return;

      // Evaluate each instrument
      for (const symbol of this.config.instruments) {
        try {
          await this.evaluateInstrument(symbol);
        } catch (err: any) {
          console.error(`[PaperWorker] Error evaluating ${symbol}: ${err.message}`);
        }
      }

      this.state.lastSignalEvaluation = new Date();
    } catch (err: any) {
      this.state.errorCount++;
      this.state.lastError = err.message;
    }
  }

  private async evaluateInstrument(symbol: string): Promise<void> {
    // Run Hermes analysis
    const result = await hermesPro(`Analyze ${symbol} for option buying`, {
      symbol,
    });

    this.state.signalsToday++;

    // NO_TRADE or RESEARCH_ONLY
    if (result.decision === "NO_TRADE" || result.decision === "RESEARCH_ONLY") {
      await this.recordNoTrade(symbol, result);
      return;
    }

    // Must be BUY_CE or BUY_PE
    if (result.decision !== "BUY_CE" && result.decision !== "BUY_PE") return;
    if (!result.candidate) return;
    if (result.score < this.config.minimumScore) return;

    const candidate = result.candidate;

    // Check cooldown
    const cooldownMs = this.config.signalCooldownMinutes * 60_000;
    const sigKey = `${symbol}:${candidate.strike}:${result.decision === "BUY_CE" ? "CE" : "PE"}`;
    if (isDuplicate(sigKey, cooldownMs)) return;

    // Validate trade
    if (result.validation && !result.validation.passed) return;

    // Get instrument config
    const instrumentConfig = getInstrumentConfig(symbol);

    // Build trade record
    const signalId = `ps-${randomBytes(8).toString("hex")}`;
    const entry = candidate.entry;
    const slippage = entry * (this.config.paperSlippageBps / 10_000);
    const actualEntry = entry + slippage; // BUY at ASK (higher)

    const trade = {
      signalId,
      createdAt: new Date(),
      mode: "PAPER",
      decision: result.decision,
      exchange: candidate.exchange || "NSE",
      instrument: candidate.instrument || "index",
      underlying: symbol,
      spotAtSignal: result.context?.spot?.value?.price || 0,
      expiry: candidate.expiry || "",
      strike: candidate.strike,
      optionType: result.decision === "BUY_CE" ? "CE" : "PE",
      moneyness: candidate.position || "ATM",
      optionLtpAtSignal: entry,
      bidAtSignal: candidate.entryRange?.min,
      askAtSignal: actualEntry,
      entrySource: "ASK",
      entryPrice: actualEntry,
      stopLoss: candidate.stopLoss,
      target1: candidate.tp1,
      target2: candidate.tp2,
      target3: candidate.tp3,
      quantity: candidate.quantity || 1,
      lotSize: candidate.lotSize || instrumentConfig?.lotSize || 65,
      score: result.score,
      grade: result.grade,
      confidence: result.confidence,
      regime: result.marketRegime || "UNKNOWN",
      provider: result.dataQuality?.provider || "unknown",
      freshness: result.dataQuality?.freshness || "UNKNOWN",
      dataTimestamp: new Date(result.timestamp),
      gamma: candidate.greeks?.gamma,
      delta: candidate.greeks?.delta,
      theta: candidate.greeks?.theta,
      vega: candidate.greeks?.vega,
      iv: candidate.iv,
      pcr: result.context?.optionChain?.value?.pcrOI,
      maxPain: result.context?.optionChain?.value?.maxPain,
      gammaWall: result.context?.optionChain?.value?.gammaWall,
      gammaFlip: result.context?.optionChain?.value?.gammaFlip,
      expectedMove: result.context?.optionChain?.value?.expectedMove,
      vix: result.context?.vix?.value,
      fiiNet: result.context?.fiiDii?.value?.fiiNet,
      diiNet: result.context?.fiiDii?.value?.diiNet,
      marketStructure: result.context?.marketStructure?.value?.trend,
      status: "OPEN",
      highestPremium: entry,
      lowestPremium: entry,
      premiumHistory: JSON.stringify([{
        timestamp: new Date().toISOString(),
        premium: entry,
        spot: result.context?.spot?.value?.price || 0,
      }]),
      validation: JSON.stringify(result.validation),
      reasons: JSON.stringify(result.explanation?.why || []),
      riskAmount: candidate.riskAmount,
      riskReward: candidate.riskReward,
      charges: 0,
      slippageBps: this.config.paperSlippageBps,
      createdBy: "HERMES",
    };

    // Save to database
    await saveTrade(trade);
    this.openTrades.push(trade);

    // Update account
    await upsertAccount({
      totalTrades: this.openTrades.length,
      openTrades: this.openTrades.length,
    });

    // Send Telegram notification
    if (this.config.sendTelegram) {
      try {
        await sendPaperTradeSignal(trade);
      } catch {
        // Telegram failure is non-critical
      }
    }

    // Emit event to bus
    await emitTradeCreated(trade.signalId, trade.underlying, {
      direction: trade.decision,
      strike: trade.strike,
      expiry: trade.expiry,
      entry: trade.entryPrice,
      sl: trade.stopLoss,
      tp1: trade.target1,
      tp2: trade.target2,
      extendedTarget: trade.target3,
      actualRR: candidate.riskReward,
      tradeQuality: candidate.tradeQuality,
      score: candidate.totalScore,
      grade: candidate.grade,
    });

    console.log(`[PaperWorker] NEW PAPER TRADE: ${trade.decision} ${trade.underlying} ${trade.strike} ${trade.optionType} @ ₹${trade.entryPrice}`);
  }

  // ── Open Trade Monitoring ────────────────────────────────────────

  private async monitorOpenTrades(): Promise<void> {
    if (this.state.status !== "RUNNING") return;
    if (this.openTrades.length === 0) return;

    try {
      for (let i = this.openTrades.length - 1; i >= 0; i--) {
        const trade = this.openTrades[i];
        await this.monitorSingleTrade(trade, i);
      }
      this.state.lastTradeMonitor = new Date();
    } catch (err: any) {
      this.state.errorCount++;
      this.state.lastError = err.message;
    }
  }

  private async monitorSingleTrade(trade: any, index: number): Promise<void> {
    const now = new Date();
    const holdingMs = now.getTime() - new Date(trade.createdAt).getTime();

    // 1. Check time exit
    if (holdingMs > this.config.maxHoldingMinutes * 60_000) {
      await emitTimeExit(trade.signalId, trade.underlying, {
        direction: trade.decision,
        entry: trade.entryPrice,
        exit: trade.highestPremium || trade.entryPrice,
        holdingTime: `${(holdingMs / 3600_000).toFixed(1)}h`,
      });
      await this.closeTrade(trade, "TIME_EXIT");
      return;
    }

    // 2. Check expiry
    const expiryInfo = getStandardizedExpiry(trade.underlying);
    if (expiryInfo && expiryInfo.is_expiry_today) {
      const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      // Close at 15:30 (930 minutes) if still open on expiry day
      if (minutes >= 930) {
        await emitExpiryExit(trade.signalId, trade.underlying, {
          direction: trade.decision,
          entry: trade.entryPrice,
          exit: trade.highestPremium || trade.entryPrice,
          expiry: trade.expiry,
        });
        await this.closeTrade(trade, "EXPIRED");
        return;
      }
    }

    // 3. Get current option price from market data
    const currentPrice = await this.getOptionPrice(trade);
    if (currentPrice === null) {
      // No valid price available — do not fabricate
      return;
    }

    // 4. Update MFE/MAE
    const highest = Math.max(trade.highestPremium || 0, currentPrice);
    const lowest = Math.min(trade.lowestPremium || Infinity, currentPrice);

    trade.highestPremium = highest;
    trade.lowestPremium = lowest;

    const mfe = highest - trade.entryPrice;
    const mae = lowest - trade.entryPrice;
    const mfePct = (mfe / trade.entryPrice) * 100;
    const maePct = (mae / trade.entryPrice) * 100;

    // 5. Add to premium history
    let history = [];
    try { history = JSON.parse(trade.premiumHistory || "[]"); } catch { history = []; }
    history.push({
      timestamp: now.toISOString(),
      premium: currentPrice,
      spot: 0,
    });
    // Keep last 500 entries
    if (history.length > 500) history = history.slice(-500);

    // 6. Check SL
    if (currentPrice <= trade.stopLoss) {
      await emitSLHit(trade.signalId, trade.underlying, {
        direction: trade.decision,
        entry: trade.entryPrice,
        sl: trade.stopLoss,
        exit: currentPrice,
        exitReason: 'INITIAL_SL',
      });
      await this.closeTrade(trade, "SL_HIT");
      return;
    }

    // 7. Check TP1
    if (trade.target1 && currentPrice >= trade.target1 && trade.status === "OPEN") {
      trade.status = "TP1_HIT";
      trade.stopLoss = trade.entryPrice; // Move SL to breakeven
      await emitTP1Hit(trade.signalId, trade.underlying, {
        direction: trade.decision,
        entry: trade.entryPrice,
        tp1: trade.target1,
        current: currentPrice,
        pnl: ((currentPrice - trade.entryPrice) * trade.quantity).toFixed(2),
      });
      await emitTrailingSL(trade.signalId, trade.underlying, {
        direction: trade.decision,
        oldSL: trade.stopLoss,
        newSL: trade.entryPrice,
        current: currentPrice,
        reason: 'TP1 hit — SL moved to breakeven',
      });
    }

    // 8. Check TP2
    if (trade.target2 && currentPrice >= trade.target2 && trade.status === "TP1_HIT") {
      trade.status = "TP2_HIT";
      await emitTP2Hit(trade.signalId, trade.underlying, {
        direction: trade.decision,
        entry: trade.entryPrice,
        tp2: trade.target2,
        current: currentPrice,
        pnl: ((currentPrice - trade.entryPrice) * trade.quantity).toFixed(2),
      });
    }

    // 9. Check TP3
    if (trade.target3 && currentPrice >= trade.target3 && trade.status === "TP2_HIT") {
      await this.closeTrade(trade, "TP3_HIT");
      return;
    }

    // 10. Persist updated state
    await saveTrade({
      ...trade,
      highestPremium: highest,
      lowestPremium: lowest,
      maxFavorableExcursion: mfe,
      maxFavorableExcursionPct: mfePct,
      maxAdverseExcursion: mae,
      maxAdverseExcursionPct: maePct,
      premiumHistory: JSON.stringify(history),
    });
  }

  // ── Option Price Source ──────────────────────────────────────────

  private async getOptionPrice(trade: any): Promise<number | null> {
    try {
      // Use market data manager to get current option price
      const chainResult = await marketDataManager.fetchOptionChain(
        trade.underlying,
        undefined,
        { mode: "paper" }
      );

      if (!chainResult?.data) return null;

      const chain = chainResult.data;
      const strikes = chain.strikes || chain.records || [];

      // Find the matching strike
      for (const strike of strikes) {
        const strikePrice = strike.strike || strike.strikePrice;
        if (Math.abs(strikePrice - trade.strike) < 0.01) {
          const option = trade.optionType === "CE"
            ? (strike.CE || strike.call || strike.callOption)
            : (strike.PE || strike.put || strike.putOption);

          if (option) {
            const ltp = option.lastPrice || option.ltp || option.ltpPrice;
            if (ltp && ltp > 0 && isFinite(ltp)) {
              return ltp;
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Close Trade ─────────────────────────────────────────────────

  private async closeTrade(trade: any, exitSource: string): Promise<void> {
    const now = new Date();
    const exitPrice = trade.highestPremium || trade.entryPrice;

    // Apply slippage
    const slippage = exitPrice * (this.config.paperSlippageBps / 10_000);
    const actualExit = exitSource === "SL_HIT"
      ? exitPrice - slippage
      : exitPrice + slippage;

    // Calculate P&L
    const pnl = (actualExit - trade.entryPrice) * trade.quantity;
    const pnlPercent = ((actualExit - trade.entryPrice) / trade.entryPrice) * 100;
    const charges = this.calculateCharges(trade);
    const netPnl = pnl - charges;

    // MFE/MAE
    const mfe = (trade.highestPremium || trade.entryPrice) - trade.entryPrice;
    const mae = (trade.lowestPremium || trade.entryPrice) - trade.entryPrice;

    const updated = {
      ...trade,
      status: exitSource,
      exitPrice: actualExit,
      exitTime: now,
      exitSource: exitSource === "SL_HIT" ? "SL" :
                 exitSource === "TP1_HIT" ? "TP1" :
                 exitSource === "TP2_HIT" ? "TP2" :
                 exitSource === "TP3_HIT" ? "TP3" :
                 exitSource === "TIME_EXIT" ? "TIME" :
                 exitSource === "EXPIRED" ? "EXPIRY" : "UNKNOWN",
      realizedPnL: netPnl,
      realizedPnLPercent: pnlPercent,
      maxFavorableExcursion: mfe,
      maxFavorableExcursionPct: (mfe / trade.entryPrice) * 100,
      maxAdverseExcursion: mae,
      maxAdverseExcursionPct: (mae / trade.entryPrice) * 100,
      holdingTimeMs: now.getTime() - new Date(trade.createdAt).getTime(),
      charges,
      slippageBps: this.config.paperSlippageBps,
    };

    // Save to database
    await saveTrade(updated);

    // Remove from open trades
    const idx = this.openTrades.findIndex((t: any) => t.signalId === trade.signalId);
    if (idx >= 0) this.openTrades.splice(idx, 1);

    // SAFETY: Release active trade lock on terminal events
    const terminalEvents = ['SL_HIT', 'TP2_HIT', 'TP3_HIT', 'TIME_EXIT', 'EXPIRED'];
    if (terminalEvents.includes(exitSource)) {
      releaseTradeLock(trade.underlying, trade.exchange || 'NFO');
    }

    // Update account
    const capital = 100_000; // TODO: load from account
    await upsertAccount({
      currentCapital: capital + netPnl,
      realizedPnL: netPnl,
      openTrades: this.openTrades.length,
    });

    // Send Telegram
    if (this.config.sendTelegram) {
      try {
        await sendPaperTradeExit(updated);
      } catch {
        // non-critical
      }
    }

    // Emit TRADE_CLOSED event
    await emitTradeClosed(trade.signalId, trade.underlying, {
      direction: trade.decision,
      entry: trade.entryPrice,
      exit: actualExit,
      pnl: netPnl.toFixed(2),
      netPnL: netPnl.toFixed(2),
      mfe: mfe.toFixed(2),
      mae: mae.toFixed(2),
      exitReason: updated.exitSource,
      holdingTime: `${((now.getTime() - new Date(trade.createdAt).getTime()) / 3600_000).toFixed(1)}h`,
    });

    // ── Record to Agent Reputation ────────────────────────────────────
    try {
      const rMultiple = trade.entryPrice > 0 ? netPnl / trade.entryPrice : 0;
      const isWin = netPnl > 0;
      recordSignalOutcome(trade.signalId || trade.underlying, {
        valid: true,
        tradeResult: isWin ? 'WIN' : netPnl === 0 ? 'BREAKEVEN' : 'LOSS',
        rMultiple,
      });
    } catch {
      // Non-critical
    }

    console.log(`[PaperWorker] CLOSED: ${trade.underlying} ${trade.strike} ${trade.optionType} | ${exitSource} | P&L: ₹${netPnl.toFixed(2)}`);
  }

  private calculateCharges(trade: any): number {
    const premium = trade.entryPrice * trade.quantity;
    const brokerage = 20; // flat per trade
    const stt = premium * 0.0005;
    const exchange = premium * 0.0000345;
    const gst = (brokerage + exchange) * 0.18;
    const stamp = premium * 0.00003;
    return brokerage + stt + exchange + gst + stamp;
  }

  // ── NO_TRADE Observation Recording ──────────────────────────────

  private async recordNoTrade(symbol: string, result: any): Promise<void> {
    const obs = {
      id: `nt-${randomBytes(8).toString("hex")}`,
      createdAt: new Date(),
      underlying: symbol,
      spotAtObservation: result.context?.spot?.value?.price || 0,
      decision: "NO_TRADE",
      score: result.score || 0,
      grade: result.grade,
      regime: result.marketRegime || "UNKNOWN",
      blockingConditions: JSON.stringify(result.explanation?.why || []),
      provider: result.dataQuality?.provider || "unknown",
      freshness: result.dataQuality?.freshness || "UNKNOWN",
      dataTimestamp: new Date(result.timestamp),
      optionLtpAtObservation: null,
      vix: result.context?.vix?.value,
      pcr: result.context?.optionChain?.value?.pcrOI,
      marketStructure: result.context?.marketStructure?.value?.trend,
      createdBy: "HERMES",
    };

    await saveNoTradeObs(obs);
    this.pendingNoTrade.push(obs);
    this.state.noTradeToday++;

    await upsertAccount({
      totalNoTrade: (await prisma.hermesNoTradeObservation.count()) + 1,
    });

    console.log(`[PaperWorker] NO_TRADE: ${symbol} | Score: ${obs.score} | Regime: ${obs.regime}`);
  }

  // ── NO_TRADE Observation Tracking ───────────────────────────────

  private async checkNoTradeObservations(): Promise<void> {
    if (this.state.status !== "RUNNING") return;

    const now = Date.now();

    for (let i = this.pendingNoTrade.length - 1; i >= 0; i--) {
      const obs = this.pendingNoTrade[i];
      const obsTime = new Date(obs.createdAt).getTime();
      const elapsed = now - obsTime;

      // 30-minute check
      if (elapsed >= 30 * 60_000 && !obs.optionLtpAfter30Min) {
        const price = await this.getHypotheticalOptionPrice(obs);
        if (price !== null) {
          obs.optionLtpAfter30Min = price;
          // Classify
          obs.classification = this.classifyNoTrade(obs, price);
        }
      }

      // 60-minute check
      if (elapsed >= 60 * 60_000 && !obs.optionLtpAfter60Min) {
        const price = await this.getHypotheticalOptionPrice(obs);
        if (price !== null) {
          obs.optionLtpAfter60Min = price;
          // Final classification if not already classified
          if (!obs.classification || obs.classification === "NEUTRAL") {
            obs.classification = this.classifyNoTrade(obs, price);
          }
        } else {
          obs.classification = "INSUFFICIENT_DATA";
        }

        // Remove from pending after 60 minutes
        this.pendingNoTrade.splice(i, 1);
      }

      // Save updated observation
      await saveNoTradeObs(obs);
    }
  }

  private async getHypotheticalOptionPrice(obs: any): Promise<number | null> {
    try {
      const chainResult = await marketDataManager.fetchOptionChain(
        obs.underlying,
        undefined,
        { mode: "paper" }
      );

      if (!chainResult?.data) return null;

      const chain = chainResult.data;
      const strikes = chain.strikes || chain.records || [];
      const spot = obs.spotAtObservation;

      // Find ATM strike
      let closestStrike = null;
      let minDist = Infinity;
      for (const strike of strikes) {
        const sp = strike.strike || strike.strikePrice;
        const dist = Math.abs(sp - spot);
        if (dist < minDist) {
          minDist = dist;
          closestStrike = strike;
        }
      }

      if (!closestStrike) return null;

      // Try both CE and PE
      const ceOption = closestStrike.CE || closestStrike.call || closestStrike.callOption;
      const peOption = closestStrike.PE || closestStrike.put || closestStrike.putOption;
      const ceLtp = ceOption?.lastPrice || ceOption?.ltp;
      const peLtp = peOption?.lastPrice || peOption?.ltp;

      // Return average of both as hypothetical
      if (ceLtp && peLtp) return (ceLtp + peLtp) / 2;
      if (ceLtp) return ceLtp;
      if (peLtp) return peLtp;
      return null;
    } catch {
      return null;
    }
  }

  private classifyNoTrade(obs: any, currentPrice: number): string {
    const initialPrice = obs.optionLtpAtObservation || 0;
    if (initialPrice <= 0) return "INSUFFICIENT_DATA";

    const movePct = ((currentPrice - initialPrice) / initialPrice) * 100;

    // Configurable thresholds
    const ADVERSE_THRESHOLD = -15; // 15% drop = good avoidance (we avoided a loss)
    const FAVORABLE_THRESHOLD = 15; // 15% rise = missed opportunity

    if (movePct <= ADVERSE_THRESHOLD) return "GOOD_AVOIDANCE";
    if (movePct >= FAVORABLE_THRESHOLD) return "MISSED_OPPORTUNITY";
    return "NEUTRAL";
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export async function startPaperEngine(
  config?: Partial<PaperWorkerConfig>
): Promise<WorkerState> {
  if (!worker) {
    worker = new PaperWorkerSingleton(config);
  }
  return worker.start();
}

export async function stopPaperEngine(): Promise<WorkerState> {
  if (!worker) {
    return { status: "STOPPED", lastSignalEvaluation: null, lastTradeMonitor: null, lastNoTradeCheck: null, signalsToday: 0, noTradeToday: 0, errorCount: 0, lastError: null, startedAt: null };
  }
  return worker.stop();
}

export function getPaperEngineStatus(): WorkerState & { config?: PaperWorkerConfig } {
  if (!worker) {
    return {
      status: "STOPPED",
      lastSignalEvaluation: null,
      lastTradeMonitor: null,
      lastNoTradeCheck: null,
      signalsToday: 0,
      noTradeToday: 0,
      errorCount: 0,
      lastError: null,
      startedAt: null,
    };
  }
  return { ...worker.getState(), config: worker.getConfig() };
}

export async function getPaperEngineData() {
  const openTrades = await prisma.hermesPaperTrade.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });

  const closedTrades = await prisma.hermesPaperTrade.findMany({
    where: { status: { not: "OPEN" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const noTradeObs = await prisma.hermesNoTradeObservation.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const account = await prisma.hermesPaperAccount.findFirst();

  return {
    openTrades,
    closedTrades,
    noTradeObservations: noTradeObs,
    account: account || {
      startingCapital: DEFAULT_CONFIG.startingCapital,
      currentCapital: DEFAULT_CONFIG.startingCapital,
      realizedPnL: 0,
      totalSignals: 0,
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      totalNoTrade: 0,
      openTrades: 0,
    },
  };
}
