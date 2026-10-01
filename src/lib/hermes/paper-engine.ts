// Hermes Paper Trading Engine — core signal generation + simulated execution
// Uses existing Hermes decision engine. Never places real orders.

import { randomBytes } from "crypto";
import type { HermesContext, Decision, TradeCandidate } from "./types";
import { hermesPro } from "./agent";
import { validateTrade, isTradeValid } from "./trade-validator";
import { evaluateNoTrade, shouldRejectTrade } from "./no-trade-engine";
import { isDataUsable } from "./freshness";
import { getInstrumentConfig, isMCXInstrument } from "../instrument-config";

// ── Types ─────────────────────────────────────────────────────────────

export interface PaperConfig {
  enabled: boolean;
  evaluationIntervalMs: number;
  minimumScore: number;
  minimumConfidence: number;
  signalCooldownMinutes: number;
  maxOpenPaperTrades: number;
  maxHoldingMinutes: number;
  paperSlippageBps: number;
  startingCapital: number;
  brokeragePerTrade: number;
  sttPercent: number;
  exchangeChargesPercent: number;
  gstPercent: number;
  stampDutyPercent: number;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  enabled: false,
  evaluationIntervalMs: 30_000,
  minimumScore: 60,
  minimumConfidence: 0,
  signalCooldownMinutes: 10,
  maxOpenPaperTrades: 5,
  maxHoldingMinutes: 390, // 6.5 hours = full day
  paperSlippageBps: 5, // 0.05%
  startingCapital: 100_000,
  brokeragePerTrade: 20, // flat per trade
  sttPercent: 0.05, // on sell side for options
  exchangeChargesPercent: 0.00345,
  gstPercent: 0.18,
  stampDutyPercent: 0.003,
};

export interface PaperSignal {
  id: string;
  createdAt: Date;
  decision: "BUY_CE" | "BUY_PE";
  exchange: string;
  instrument: string;
  underlying: string;
  spotAtSignal: number;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  moneyness: "ITM" | "ATM" | "OTM";
  optionLtpAtSignal: number;
  bidAtSignal?: number;
  askAtSignal?: number;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  target3?: number;
  quantity: number;
  lotSize: number;
  score: number;
  grade?: string;
  confidence?: number;
  regime: string;
  provider: string;
  freshness: string;
  dataTimestamp: Date;
  gamma?: number;
  delta?: number;
  theta?: number;
  vega?: number;
  iv?: number;
  pcr?: number;
  maxPain?: number;
  gammaWall?: number;
  gammaFlip?: number;
  expectedMove?: number;
  vix?: number;
  fiiNet?: number;
  diiNet?: number;
  marketStructure?: string;
  validation?: any;
  reasons?: string[];
  invalidation?: string;
  riskAmount?: number;
  riskReward?: number;
}

export interface PaperTrade extends PaperSignal {
  status: "OPEN" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT" | "TIME_EXIT" | "EXPIRED" | "CANCELLED";
  exitPrice?: number;
  exitTime?: Date;
  exitSource?: string;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  maxFavorableExcursion?: number;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursion?: number;
  maxAdverseExcursionPct?: number;
  highestPremium?: number;
  lowestPremium?: number;
  spotAtExit?: number;
  spotMove?: number;
  optionMove?: number;
  holdingTimeMs?: number;
  premiumHistory?: Array<{ timestamp: string; premium: number; spot: number }>;
  charges?: number;
  slippageBps?: number;
}

export interface NoTradeObservation {
  id: string;
  createdAt: Date;
  underlying: string;
  spotAtObservation: number;
  decision: "NO_TRADE";
  score: number;
  grade?: string;
  regime: string;
  blockingConditions: string[];
  provider: string;
  freshness: string;
  dataTimestamp: Date;
  optionLtpAtObservation?: number;
  optionLtpAfter30Min?: number;
  optionLtpAfter60Min?: number;
  spotAfter30Min?: number;
  spotAfter60Min?: number;
  classification?: "GOOD_AVOIDANCE" | "MISSED_OPPORTUNITY" | "NEUTRAL";
  avoidedLossPct?: number;
  missedGainPct?: number;
  vix?: number;
  pcr?: number;
  marketStructure?: string;
}

export interface PaperAccount {
  id: string;
  startingCapital: number;
  currentCapital: number;
  availableCapital: number;
  realizedPnL: number;
  unrealizedPnL: number;
  dailyPnL: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  totalSignals: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalNoTrade: number;
  openTrades: number;
  isActive: boolean;
}

// ── Signal Deduplication ──────────────────────────────────────────────

const recentSignals = new Map<string, number>(); // key -> timestamp

function signalKey(underlying: string, strike: number, optionType: string): string {
  return `${underlying}:${strike}:${optionType}`;
}

function isDuplicateSignal(signal: PaperSignal, cooldownMs: number): boolean {
  const key = signalKey(signal.underlying, signal.strike, signal.optionType);
  const lastTime = recentSignals.get(key);
  if (lastTime && Date.now() - lastTime < cooldownMs) {
    return true;
  }
  recentSignals.set(key, Date.now());
  return false;
}

// ── Core Paper Trading Engine ─────────────────────────────────────────

export class HermesPaperEngine {
  private config: PaperConfig;
  private openTrades: PaperTrade[] = [];
  private closedTrades: PaperTrade[] = [];
  private noTradeObservations: NoTradeObservation[] = [];
  private account: PaperAccount;
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private monitoringTimer: ReturnType<typeof setInterval> | null = null;
  private lastEvaluation = 0;

  constructor(config: Partial<PaperConfig> = {}) {
    this.config = { ...DEFAULT_PAPER_CONFIG, ...config };
    this.account = {
      id: "paper-main",
      startingCapital: this.config.startingCapital,
      currentCapital: this.config.startingCapital,
      availableCapital: this.config.startingCapital,
      realizedPnL: 0,
      unrealizedPnL: 0,
      dailyPnL: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      totalSignals: 0,
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      totalNoTrade: 0,
      openTrades: 0,
      isActive: false,
    };
  }

  // ── Start/Stop ──────────────────────────────────────────────────

  start(): void {
    if (this.evaluationTimer) return; // already running
    this.account.isActive = true;
    this.evaluationTimer = setInterval(() => this.evaluate(), this.config.evaluationIntervalMs);
    this.monitoringTimer = setInterval(() => this.monitorOpenTrades(), 5_000); // monitor every 5s
    console.log("[HermesPaper] Paper trading started");
  }

  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    this.account.isActive = false;
    console.log("[HermesPaper] Paper trading stopped");
  }

  // ── Evaluation Cycle ────────────────────────────────────────────

  async evaluate(): Promise<void> {
    if (!this.config.enabled || !this.account.isActive) return;
    if (Date.now() - this.lastEvaluation < this.config.evaluationIntervalMs) return;
    this.lastEvaluation = Date.now();

    // Check max open trades
    if (this.openTrades.length >= this.config.maxOpenPaperTrades) {
      return;
    }

    // Evaluate each supported instrument
    const instruments = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
    for (const symbol of instruments) {
      try {
        await this.evaluateInstrument(symbol);
      } catch (err: any) {
        console.error(`[HermesPaper] Error evaluating ${symbol}: ${err.message}`);
      }
    }
  }

  private async evaluateInstrument(symbol: string): Promise<void> {
    // Run Hermes analysis
    const result = await hermesPro(`Give me a live trade recommendation for ${symbol} with CE or PE`, {
      symbol,
      mode: "TRADE",
      intent: "LIVE_TRADE",
      apiBase: process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000",
    });

    // Record the decision
    this.account.totalSignals++;

    if (result.decision === "NO_TRADE" || result.decision === "RESEARCH_ONLY") {
      // Record NO_TRADE observation
      const observation: NoTradeObservation = {
        id: `nt-${randomBytes(8).toString("hex")}`,
        createdAt: new Date(),
        underlying: symbol,
        spotAtObservation: result.context?.spot?.value?.price || 0,
        decision: "NO_TRADE",
        score: result.score || 0,
        grade: result.grade,
        regime: result.regime || "UNKNOWN",
        blockingConditions: result.explanation?.why || [],
        provider: result.dataQuality?.provider || "unknown",
        freshness: result.dataQuality?.freshness || "UNKNOWN",
        dataTimestamp: new Date(),
        vix: result.context?.vix?.value,
        pcr: result.context?.optionChain?.value?.pcrOI,
        marketStructure: result.context?.marketStructure?.value?.trend,
      };
      this.noTradeObservations.push(observation);
      this.account.totalNoTrade++;
      return;
    }

    // BUY_CE or BUY_PE — create paper trade
    if (result.decision !== "BUY_CE" && result.decision !== "BUY_PE") return;
    if (!result.candidate) return;
    if (result.score < this.config.minimumScore) return;

    // Check cooldown
    const cooldownMs = this.config.signalCooldownMinutes * 60_000;
    const candidate = result.candidate;
    const tempSignal: PaperSignal = {
      id: "",
      createdAt: new Date(),
      decision: result.decision,
      exchange: candidate.exchange || "NSE",
      instrument: candidate.instrument || "index",
      underlying: symbol,
      spotAtSignal: result.context?.spot?.value?.price || 0,
      expiry: candidate.expiry || "",
      strike: candidate.strike,
      optionType: result.decision === "BUY_CE" ? "CE" : "PE",
      moneyness: candidate.position || "ATM",
      optionLtpAtSignal: candidate.entry,
      entryPrice: candidate.entry,
      stopLoss: candidate.stopLoss,
      target1: candidate.tp1,
      target2: candidate.tp2,
      target3: candidate.tp3,
      quantity: candidate.quantity,
      lotSize: candidate.lotSize,
      score: result.score,
      grade: result.grade,
      confidence: result.confidence,
      regime: result.regime || "UNKNOWN",
      provider: result.dataQuality?.provider || "unknown",
      freshness: result.dataQuality?.freshness || "UNKNOWN",
      dataTimestamp: new Date(),
      gamma: candidate.greeks?.gamma,
      delta: candidate.greeks?.delta,
      theta: candidate.greeks?.theta,
      vega: candidate.greeks?.vega,
      iv: candidate.iv,
      pcr: result.context?.optionChain?.value?.pcrOI,
      maxPain: result.context?.optionChain?.value?.maxPain,
      expectedMove: result.context?.optionChain?.value?.expectedMove,
      vix: result.context?.vix?.value,
      marketStructure: result.context?.marketStructure?.value?.trend,
      validation: result.validation,
      reasons: result.explanation?.why,
      invalidation: result.explanation?.invalidation?.join(", "),
      riskAmount: candidate.riskAmount,
      riskReward: candidate.riskReward,
    };

    if (isDuplicateSignal(tempSignal, cooldownMs)) return;

    // Validate trade
    if (result.context) {
      const validationResults = validateTrade(result.context, candidate);
      const { valid } = isTradeValid(validationResults);
      if (!valid) return;
    }

    // Create paper trade
    const signal: PaperSignal = {
      ...tempSignal,
      id: `ps-${randomBytes(8).toString("hex")}`,
    };

    const trade: PaperTrade = {
      ...signal,
      status: "OPEN",
      highestPremium: signal.optionLtpAtSignal,
      lowestPremium: signal.optionLtpAtSignal,
      premiumHistory: [{
        timestamp: new Date().toISOString(),
        premium: signal.optionLtpAtSignal,
        spot: signal.spotAtSignal,
      }],
    };

    this.openTrades.push(trade);
    this.account.totalTrades++;
    this.account.openTrades = this.openTrades.length;
    this.account.availableCapital -= signal.riskAmount || 0;

    console.log(`[HermesPaper] NEW PAPER TRADE: ${signal.decision} ${signal.underlying} ${signal.strike} ${signal.optionType} @ ₹${signal.entryPrice}`);
  }

  // ── Monitoring ──────────────────────────────────────────────────

  private monitorOpenTrades(): void {
    const now = Date.now();

    for (let i = this.openTrades.length - 1; i >= 0; i--) {
      const trade = this.openTrades[i];

      // Check time exit
      const holdingMs = now - trade.createdAt.getTime();
      if (holdingMs > this.config.maxHoldingMinutes * 60_000) {
        this.closeTrade(trade, trade.optionLtpAtSignal, "TIME");
        continue;
      }

      // Check expiry
      // (simplified — in production would check actual expiry date)
    }
  }

  // ── Premium Update (called externally with live data) ───────────

  updatePremium(underlying: string, currentPremium: number, currentSpot: number): void {
    for (const trade of this.openTrades) {
      if (trade.underlying !== underlying) continue;

      // Update tracking
      trade.highestPremium = Math.max(trade.highestPremium || 0, currentPremium);
      trade.lowestPremium = Math.min(trade.lowestPremium || Infinity, currentPremium);

      // Add to history
      trade.premiumHistory = trade.premiumHistory || [];
      trade.premiumHistory.push({
        timestamp: new Date().toISOString(),
        premium: currentPremium,
        spot: currentSpot,
      });

      // Check SL
      if (currentPremium <= trade.stopLoss) {
        this.closeTrade(trade, currentPremium, "SL");
        continue;
      }

      // Check TP1
      if (trade.target1 && currentPremium >= trade.target1 && trade.status === "OPEN") {
        trade.status = "TP1_HIT";
        // Move SL to breakeven after TP1
        trade.stopLoss = trade.entryPrice;
      }

      // Check TP2
      if (trade.target2 && currentPremium >= trade.target2 && (trade.status === "TP1_HIT" || trade.status === "OPEN")) {
        trade.status = "TP2_HIT";
      }

      // Check TP3
      if (trade.target3 && currentPremium >= trade.target3 && (trade.status === "TP2_HIT" || trade.status === "TP1_HIT" || trade.status === "OPEN")) {
        this.closeTrade(trade, currentPremium, "TP3");
        continue;
      }
    }
  }

  // ── Close Trade ─────────────────────────────────────────────────

  private closeTrade(trade: PaperTrade, exitPremium: number, source: string): void {
    const now = new Date();
    trade.exitPrice = exitPremium;
    trade.exitTime = now;
    trade.exitSource = source;
    trade.status = source === "SL" ? "SL_HIT" :
                   source === "TP1" ? "TP1_HIT" :
                   source === "TP2" ? "TP2_HIT" :
                   source === "TP3" ? "TP3_HIT" :
                   source === "TIME" ? "TIME_EXIT" :
                   source === "EXPIRY" ? "EXPIRED" : "CANCELLED";

    // Apply slippage
    const slippage = exitPremium * (this.config.paperSlippageBps / 10_000);
    const actualExit = source === "SL" ? exitPremium - slippage : exitPremium + slippage;

    // Calculate P&L
    const pnl = (actualExit - trade.entryPrice) * trade.quantity;
    const pnlPercent = ((actualExit - trade.entryPrice) / trade.entryPrice) * 100;

    // Calculate charges
    const charges = this.calculateCharges(trade);

    trade.exitPrice = actualExit;
    trade.realizedPnL = pnl - charges;
    trade.realizedPnLPercent = pnlPercent;
    trade.charges = charges;
    trade.slippageBps = this.config.paperSlippageBps;
    trade.holdingTimeMs = now.getTime() - trade.createdAt.getTime();
    trade.spotMove = (trade.spotAtExit || trade.spotAtSignal) - trade.spotAtSignal;
    trade.optionMove = actualExit - trade.entryPrice;

    // Calculate MFE/MAE
    if (trade.highestPremium) {
      trade.maxFavorableExcursion = trade.highestPremium - trade.entryPrice;
      trade.maxFavorableExcursionPct = ((trade.highestPremium - trade.entryPrice) / trade.entryPrice) * 100;
    }
    if (trade.lowestPremium) {
      trade.maxAdverseExcursion = trade.lowestPremium - trade.entryPrice;
      trade.maxAdverseExcursionPct = ((trade.lowestPremium - trade.entryPrice) / trade.entryPrice) * 100;
    }

    // Update account
    this.account.currentCapital += trade.realizedPnL;
    this.account.realizedPnL += trade.realizedPnL;
    this.account.availableCapital += (trade.riskAmount || 0) + trade.realizedPnL;

    if (trade.realizedPnL > 0) {
      this.account.totalWins++;
    } else {
      this.account.totalLosses++;
    }

    // Update drawdown
    const peak = Math.max(this.account.startingCapital, this.account.currentCapital);
    const dd = peak - this.account.currentCapital;
    const ddPct = (dd / peak) * 100;
    if (dd > this.account.maxDrawdown) {
      this.account.maxDrawdown = dd;
      this.account.maxDrawdownPct = ddPct;
    }

    // Move to closed
    this.openTrades.splice(this.openTrades.indexOf(trade), 1);
    this.closedTrades.push(trade);
    this.account.openTrades = this.openTrades.length;

    console.log(`[HermesPaper] CLOSED: ${trade.underlying} ${trade.strike} ${trade.optionType} | ${trade.status} | P&L: ₹${trade.realizedPnL?.toFixed(2)}`);
  }

  // ── Charges Calculation ─────────────────────────────────────────

  private calculateCharges(trade: PaperTrade): number {
    const premium = trade.entryPrice * trade.quantity;
    const brokerage = this.config.brokeragePerTrade;
    const stt = premium * (this.config.sttPercent / 100);
    const exchange = premium * (this.config.exchangeChargesPercent / 100);
    const gst = (brokerage + exchange) * this.config.gstPercent;
    const stamp = premium * (this.config.stampDutyPercent / 100);
    return brokerage + stt + exchange + gst + stamp;
  }

  // ── Getters ─────────────────────────────────────────────────────

  getOpenTrades(): PaperTrade[] { return [...this.openTrades]; }
  getClosedTrades(): PaperTrade[] { return [...this.closedTrades]; }
  getNoTradeObservations(): NoTradeObservation[] { return [...this.noTradeObservations]; }
  getAccount(): PaperAccount { return { ...this.account }; }
  getConfig(): PaperConfig { return { ...this.config }; }
  isRunning(): boolean { return this.account.isActive; }
}
