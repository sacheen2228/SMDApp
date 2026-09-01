// ─── Main Expiry Liquidity Engine ───────────────────────────────────────
// Orchestrates all sub-engines to produce the final Expiry Liquidity Signal

import { getCurrentSession, getSessionConfig } from './market-session-config';
import { getCASReferenceEngine } from './cas-reference-engine';
import { getCASDislocationEngine } from './cas-dislocation-engine';
import { getFuturesDislocationEngine } from './futures-dislocation-engine';
import { getOptionChainFlowEngine } from './option-chain-flow-engine';
import { getOIClassificationEngine } from './oi-classification-engine';
import { getPremiumVelocityEngine } from './premium-velocity-engine';
import { getIVVelocityEngine } from './iv-velocity-engine';
import { getVolumeVelocityEngine } from './volume-velocity-engine';
import { getGammaPressureEngine } from './gamma-pressure-engine';
import { getOIConcentrationEngine } from './oi-concentration-engine';
import { getSupportResistanceEngine } from './support-resistance-engine';
import { getAuctionTheoryEngine } from './auction-theory-engine';
import { getMarketBreadthEngine } from './market-breadth-engine';
import { getHeatmapConfirmationEngine } from './heatmap-confirmation-engine';
import {
  ExpiryLiquidityEngineOutput,
  ExpiryLiquidityConfig,
  DEFAULT_EXPIRY_LIQUIDITY_CONFIG,
  TradeSignal,
  TradeSignalType,
  CASExpiryModeState,
  MarginRiskAnalysis,
  LiquidityEventAnalysis,
  ExhaustionAnalysis,
  ReversalAnalysis,
  SignalExplanation,
} from './types';

interface EngineContext {
  symbol: string;
  spot: number;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  optionChain: any; // OptionChainSnapshot
  futures: any; // FuturesSnapshot
  marketBreadth: any;
  sectorHeatmap: any;
  regime: any;
  vix: number;
  timestamp: number;
}

class ExpiryLiquidityEngine {
  private config: typeof DEFAULT_EXPIRY_LIQUIDITY_CONFIG;
  private casRefEngine = getCASReferenceEngine();
  private casDislocationEngine = getCASDislocationEngine();
  private futuresDislocationEngine = getFuturesDislocationEngine();
  private optionChainFlowEngine = getOptionChainFlowEngine();
  private oiClassificationEngine = getOIClassificationEngine();
  private premiumVelocityEngine = getPremiumVelocityEngine();
  private ivVelocityEngine = getIVVelocityEngine();
  private volumeVelocityEngine = getVolumeVelocityEngine();
  private gammaPressureEngine = getGammaPressureEngine();
  private oiConcentrationEngine = getOIConcentrationEngine();
  private supportResistanceEngine = getSupportResistanceEngine();
  private auctionTheoryEngine = getAuctionTheoryEngine();
  private marketBreadthEngine = getMarketBreadthEngine();
  private heatmapConfirmationEngine = getHeatmapConfirmationEngine();

  private sessionConfig = getSessionConfig();
  private signalHistory: Array<{ timestamp: number; signal: any }> = [];

  constructor(config?: Partial<typeof DEFAULT_EXPIRY_LIQUIDITY_CONFIG>) {
    this.config = { ...DEFAULT_EXPIRY_LIQUIDITY_CONFIG, ...config };
    this.initializeCrossEngineReferences();
  }

  private initializeCrossEngineReferences(): void {
    this.futuresDislocationEngine.setCASDislocationEngine(getCASDislocationEngine());
  }

  // ─── Main Engine Entry Point ─────────────────────────────────────────
  async process(context: EngineContext): Promise<ExpiryLiquidityEngineOutput> {
    const { symbol, spot, candles, optionChain, futures, marketBreadth, sectorHeatmap, regime, vix, timestamp } = context;

    // 1. Check if expiry day
    const isExpiryDay = this.isExpiryDay(symbol);
    const minutesToExpiry = this.getMinutesToExpiry(symbol);

    // 2. Get CAS Reference
    const casRef = this.casRefEngine.getReference();

    // 3. Process CAS Dislocation (if CAS active)
    const session = getCurrentSession('FNO_STOCK');
    const casActive = session.isCasActive;
    let casDislocationPct = 0;
    let currentPrice = spot;

    if (casActive) {
      // Get indicative price from option chain or futures
      currentPrice = this.getIndicativePrice(optionChain, futures, spot);
      this.casDislocationEngine.processIndicativePrice(currentPrice, timestamp);
      const dislocation = this.casDislocationEngine.getDislocation();
      casDislocationPct = dislocation.dislocationPct;
    }

    // 2. Process Futures
    if (futures) {
      this.futuresDislocationEngine.processFuturesUpdate(
        futures.futures,
        spot,
        futures.oi,
        futures.oiChange,
        futures.volume,
        futures.futures - futures.basis, // approximate prevClose
        timestamp
      );
    }

    // 3. Process Option Chain Flow
    if (optionChain) {
      this.optionChainFlowEngine.processOptionChain(optionChain);
    }

    // 3. Get all engine outputs
    const casRefPrice = this.casRefEngine.getReference().referencePrice;
    const casDislocation = this.casDislocationEngine.getDislocation();
    const futuresSnap = this.futuresDislocationEngine.getFuturesSnapshot();
    const optionFlow = this.optionChainFlowEngine.getAggregateFlow();
    const marketBreadthAnalysis = this.marketBreadthEngine.calculate([]);
    const heatmapConfirm = this.heatmapConfirmationEngine.analyze({ sectors: [], niftyChangePct: 0, bankNiftyChangePct: 0 });

    // 4. Calculate Scores
    const expiryScore = this.calculateExpiryScore({
      casDislocationPct: Math.abs(casDislocationPct),
      futuresConfirmed: this.futuresDislocationEngine.isConfirmed(),
      optionFlow: optionFlow,
      marketBreadth: marketBreadthAnalysis,
      heatmapConfirm: heatmapConfirm,
      gammaPressure: this.gammaPressureEngine.calculateAggregate({ strikes: [] } as any),
      vix,
      session: getCurrentSession('FNO_STOCK'),
    });

    // 5. Direction Engine
    const direction = this.calculateDirection({
      casDislocationPct,
      futuresSnap,
      optionFlow,
      marketBreadthAnalysis,
      heatmapConfirm,
    });

    // 6. Generate Signal
    const signal = this.generateSignal({
      symbol,
      expiryScore,
      direction,
      casDislocationPct,
      futuresSnap,
      optionChain,
      candles,
      spot,
      atmStrike: optionChain?.atmStrike,
      vix,
      sessionMinutes: getCurrentSession('FNO_STOCK').minutesRemaining,
    });

    // 7. CAS Expiry Mode
    const casExpiryMode = this.getCASExpiryModeState();

    // 8. Margin Risk
    const marginRisk = this.calculateMarginRisk({
      optionChain,
      futures: futuresSnap,
      candles: [],
    });

    // 9. Liquidity Event State Machine
    const liquidityEvent = this.updateLiquidityEventState({
      casDislocationPct,
      expiryScore,
      signal: signal?.type,
    });

    // 10. Exhaustion & Reversal Detection
    const exhaustion = this.detectExhaustion({
      casDislocationPct,
      expiryScore,
      signal: signal?.type,
    });

    const reversal = this.detectReversal({
      casDislocationPct,
      expiryScore,
      signal: signal?.type,
    });

    // 11. Build Output
    const output: ExpiryLiquidityEngineOutput = {
      symbol: context.symbol,
      timestamp,
      isExpiryDay: false,
      casActive: getCurrentSession('FNO_STOCK').isCasActive,
      casReferencePrice: casRefPrice,
      currentPrice,
      casDislocationPct,
      futuresPrice: futuresSnap.futures,
      futuresConfirmed: this.futuresDislocationEngine.isConfirmed(),
      atmStrike: optionChain?.atmStrike || 0,
      bullishScore: 0,
      bearishScore: 0,
      expiryScore,
      direction: direction.direction,
      optionFlow: 'NEUTRAL',
      volumeRatio: 1,
      ivState: 'NORMAL',
      auctionState: 'BALANCE',
      volumeProfileState: 'NEUTRAL',
      liquidityState: 'NORMAL',
      signal: signal?.type || 'NO_TRADE',
      entry: signal?.entry || 0,
      stop: signal?.stop || 0,
      target1: signal?.target1 || 0,
      target2: signal?.target2 || 0,
      target3: signal?.target3 || 0,
      riskReward: signal?.riskReward || 0,
      dataQuality: 100,
      status: signal?.status || 'WAITING',
      explainability: { signal: 'NO_TRADE', why: [], risks: [], dataQuality: 100, missingData: [], assumptions: [] },
      casExpiryMode: this.getCASExpiryModeState(),
      marginRisk: { score: 0, level: 'LOW', factors: [], calendarSpreadExposure: false, rapidPositionReduction: false, oiConcentrationRisk: 0, futuresOptionsDislocation: 0 },
      liquidityEvent: { state: 'NORMAL', previousState: 'NORMAL', stateDuration: 0, transitionReason: '', confidence: 0, nextExpectedState: null },
      exhaustion: { isExhausted: false, type: 'COMPOSITE', signals: [], exhaustionScore: 0, timeToExhaustion: 0 },
      reversal: { reversalRisk: 'NONE', type: 'NONE', signals: [], reversalScore: 0, invalidationLevel: 0 },
    };

    // Store in history
    this.signalHistory.push({ timestamp, signal: output.signal });
    if (this.signalHistory.length > 1000) this.signalHistory.shift();

    return output;
  }

  // ─── Calculate Expiry Score ──────────────────────────────────────────
  private calculateExpiryScore(params: {
    casDislocationPct: number;
    futuresConfirmed: boolean;
    optionFlow: any;
    marketBreadthAnalysis: any;
    heatmapConfirm: any;
    gammaPressure: any;
    vix: number;
    session: any;
  }): number {
    const { casDislocationPct, futuresConfirmed, optionFlow, marketBreadthAnalysis, heatmapConfirm, gammaPressure, vix, session } = params;
    const w = this.config.weights;

    let score = 0;

    // CAS Dislocation (15%)
    const casScore = Math.min(100, casDislocationPct * 100);
    score += casScore * w.casDislocation / 100;

    // Futures Confirmation (15%)
    const futuresScore = futuresConfirmed ? 100 : 0;
    score += futuresScore * w.futuresConfirmation / 100;

    // OI Flow (15%)
    const oiFlowScore = Math.min(100, Math.abs(optionFlow?.netOIFlow || 0) / 10000 * 100);
    score += oiFlowScore * w.oiFlow / 100;

    // Premium Velocity (10%)
    // Would need premium velocity data
    const premiumVelScore = 50;
    score += premiumVelScore * w.premiumVelocity / 100;

    // Volume Acceleration (10%)
    const volAccelScore = 50;
    score += volAccelScore * w.volumeAcceleration / 100;

    // IV Behaviour (5%)
    const ivScore = 50;
    score += ivScore * w.ivBehaviour / 100;

    // Gamma/Expiry Pressure (10%)
    const gammaScore = 50;
    score += gammaScore * w.gammaExpiryPressure / 100;

    // Volume Profile (5%)
    const vpScore = 50;
    score += vpScore * w.volumeProfile / 100;

    // Auction Theory (5%)
    const auctionScore = 50;
    score += auctionScore * w.auctionTheory / 100;

    // Market Breadth (5%)
    const breadthScore = marketBreadthAnalysis?.breadthScore || 50;
    score += breadthScore * w.marketBreadth / 100;

    // Heatmap (5%)
    const heatmapScore = heatmapConfirm?.heatmapAlignment === 'BULLISH' ? 80 :
      heatmapConfirm?.heatmapAlignment === 'BEARISH' ? 80 : 50;
    score += heatmapScore * w.heatmap / 100;

    return Math.round(Math.min(100, Math.max(0, score)));
  }

  // ─── Calculate Direction ─────────────────────────────────────────────
  private calculateDirection(params: {
    casDislocationPct: number;
    futuresSnap: any;
    optionFlow: any;
    marketBreadthAnalysis: any;
    heatmapConfirm: any;
  }): { direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION'; bullishScore: number; bearishScore: number } {
    const { casDislocationPct, futuresSnap, optionFlow, marketBreadthAnalysis, heatmapConfirm } = params;

    let bullishScore = 0;
    let bearishScore = 0;

    // CAS Dislocation direction
    if (casDislocationPct > 0.2) bullishScore += 30;
    else if (casDislocationPct < -0.2) bearishScore += 30;

    // Futures basis direction
    if (futuresSnap.currentBasisPct > 0.1) bullishScore += 25;
    else if (futuresSnap.currentBasisPct < -0.1) bearishScore += 25;

    // OI Flow
    if (optionFlow.netOIFlow > 0) bullishScore += 20;
    else if (optionFlow.netOIFlow < 0) bearishScore += 20;

    // Market breadth
    if (marketBreadthAnalysis.breadthScore > 60) bullishScore += 15;
    else if (marketBreadthAnalysis.breadthScore < 40) bearishScore += 15;

    // Heatmap alignment
    if (heatmapConfirm.heatmapAlignment === 'BULLISH') bullishScore += 10;
    else if (heatmapConfirm.heatmapAlignment === 'BEARISH') bearishScore += 10;

    let direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION';
    if (bullishScore > bearishScore + 20) direction = 'BULLISH';
    else if (bearishScore > bullishScore + 20) direction = 'BEARISH';
    else direction = 'NO_DIRECTION';

    return { direction, bullishScore: Math.min(100, bullishScore), bearishScore: Math.min(100, bearishScore) };
  }

  // ─── Get Indicative Price ────────────────────────────────────────────
  private getIndicativePrice(optionChain: any, futures: any, spot: number): number {
    // Priority: Futures price > Option chain synthetic > Spot
    if (futures && futures.futures > 0) return futures.futures;
    if (optionChain && optionChain.spot > 0) return optionChain.spot;
    return spot;
  }

  // ─── Generate Trade Signal ──────────────────────────────────────────
  private generateSignal(params: {
    symbol: string;
    expiryScore: number;
    direction: any;
    casDislocationPct: number;
    futuresSnap: any;
    optionChain: any;
    candles: any[];
    spot: number;
    atmStrike: number;
    vix: number;
    sessionMinutes: number;
  }): TradeSignal | null {
    const { symbol, expiryScore, direction, casDislocationPct, futuresSnap, optionChain, spot, atmStrike, vix, sessionMinutes } = params;

    // Minimum score threshold
    if (expiryScore < this.config.thresholds.minimumExpiryScore) {
      return null;
    }

    // Determine signal type
    let signalType: TradeSignalType = 'NO_TRADE';
    let optionType: 'CE' | 'PE' = 'CE';
    let strike = params.atmStrike;

    if (direction.direction === 'BULLISH') {
      signalType = 'LONG_CALL';
      optionType = 'CE';
    } else if (direction.direction === 'BEARISH') {
      signalType = 'LONG_PUT';
      optionType = 'PE';
    } else {
      return null;
    }

    // Find ATM option
    if (optionChain && optionChain.strikes) {
      const atmOption = optionChain.strikes.find((s: any) => s.strike === atmStrike);
      if (atmOption) {
        const leg = optionType === 'CE' ? atmOption.ce : atmOption.pe;
        if (leg && leg.ltp > 0) {
          strike = atmStrike;
        }
      }
    }

    // Calculate entry, stop, targets
    const ltp = optionChain?.strikes?.find((s: any) => s.strike === strike)?.[optionType]?.ltp || spot * 0.02;
    const atr = spot * 0.015; // approximate

    const entry = ltp;
    const sl = entry - atr * 1.5;
    const tp1 = entry + atr * 2;
    const tp2 = entry + atr * 3;
    const risk = entry - sl;
    const reward = tp1 - entry;
    const rr = risk > 0 ? reward / risk : 0;

    // Check R:R threshold
    if (rr < this.config.thresholds.minimumRiskReward) {
      return null;
    }

    // Entry state
    let entryState: 'WAITING' | 'CONFIRMING' | 'CONFIRMED' | 'TRIGGERED' | 'ACTIVE' | 'EXHAUSTED' | 'INVALIDATED' | 'WAITING' = 'WAITING';
    if (expiryScore >= 80) entryState = 'CONFIRMED';
    else if (expiryScore >= 60) entryState = 'CONFIRMING';

    return {
      type: signalType,
      symbol,
      expiry: 'CURRENT',
      strike,
      optionType,
      direction: direction.direction,
      score: expiryScore,
      confidence: expiryScore >= 80 ? 'VERY_HIGH' : expiryScore >= 65 ? 'HIGH' : 'MEDIUM',
      entryTrigger: { condition: 'CAS confirmation + Futures + OI flow', waitingFor: [], confirmed: false, triggerPrice: null },
      entry: { preferred: entry, range: { low: entry * 0.995, high: entry * 1.005 }, maxSlippage: 0.5, chaseRisk: false, chaseRiskReason: null },
      stopLoss: { price: sl, type: 'ATR', reason: 'ATR-based stop', atrBased: sl, structureBased: 0, selected: sl, buffer: atr * 0.3 },
      targets: [
        { price: tp1, type: 'ATR', rr: 2, probability: 70, description: 'First target at 2 ATR' },
        { price: tp2, type: 'ATR', rr: 3, probability: 50, description: 'Second target at 3 ATR' },
      ],
      riskReward: Math.round(rr * 10) / 10,
      reason: ['CAS dislocation', 'Futures confirmation', 'OI flow alignment'].slice(0, 3),
      risks: ['Premium decay', 'IV contraction', 'False breakout risk'].slice(0, 3),
      invalidation: { condition: 'Price back below CAS reference', price: spot - spot * 0.005, reason: 'CAS dislocation reversed' },
      status: entryState,
      timestamp: Date.now(),
      dataQuality: 90,
    };
  }

  // ─── CAS Expiry Mode State ───────────────────────────────────────────
  private getCASExpiryModeState(): CASExpiryModeState {
    const session = getCurrentSession('FNO_STOCK');
    const now = Date.now();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = ist.getHours();
    const mins = ist.getMinutes();
    const timeNum = hours * 100 + mins;

    let phase: CASExpiryModeState['phase'] = 'INACTIVE';
    let timeRemainingCas = 0;
    let timeRemainingFo = 0;

    if (timeNum >= 1500 && timeNum < 1515) {
      phase = 'REFERENCE';
      timeRemainingCas = 15 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1515 && timeNum < 1520) {
      phase = 'TRANSITION';
      timeRemainingCas = 20 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1520 && timeNum < 1525) {
      phase = 'ORDER_ENTRY';
      timeRemainingCas = 25 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1525 && timeNum < 1530) {
      phase = 'LIMIT_ONLY';
      timeRemainingCas = 30 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1530 && timeNum < 1535) {
      phase = 'MATCHING';
      timeRemainingCas = 35 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1535 && timeNum < 1540) {
      phase = 'DERIVATIVES_ONLY';
      timeRemainingFo = 40 * 60 - (hours * 3600 + mins * 60);
    } else if (timeNum >= 1540) {
      phase = 'INACTIVE';
    }

    return {
      isActive: phase !== 'INACTIVE',
      casStartTime: 15 * 3600 + 15 * 60,
      casEndTime: 15 * 3600 + 35 * 60,
      foEndTime: 15 * 3600 + 40 * 60,
      timeRemainingCas: Math.max(0, Math.floor(timeRemainingCas / 60)),
      timeRemainingFo: Math.max(0, Math.floor(timeRemainingFo / 60)),
      phase,
      countdownLabel: phase !== 'INACTIVE' ? `${phase}: ${Math.floor(timeRemainingCas / 60)}m` : 'CAS INACTIVE',
    };
  }

  // ─── Margin Risk ─────────────────────────────────────────────────────
  private calculateMarginRisk(params: { optionChain: any; futures: any; candles: any[] }): MarginRiskAnalysis {
    return {
      score: 0,
      level: 'LOW',
      factors: [],
      calendarSpreadExposure: false,
      rapidPositionReduction: false,
      oiConcentrationRisk: 0,
      futuresOptionsDislocation: 0,
    };
  }

  // ─── Liquidity Event State Machine ───────────────────────────────────
  private updateLiquidityEventState(params: {
    casDislocationPct: number;
    expiryScore: number;
    signal: TradeSignalType | null;
  }): LiquidityEventAnalysis {
    return {
      state: 'NORMAL',
      previousState: 'NORMAL',
      stateDuration: 0,
      transitionReason: '',
      confidence: 0,
      nextExpectedState: null,
    };
  }

  // ─── Exhaustion Detector ─────────────────────────────────────────────
  private detectExhaustion(params: {
    casDislocationPct: number;
    expiryScore: number;
    signal: TradeSignalType | null;
  }): ExhaustionAnalysis {
    return {
      isExhausted: false,
      type: 'COMPOSITE',
      signals: [],
      exhaustionScore: 0,
      timeToExhaustion: 0,
    };
  }

  // ─── Reversal Detector ──────────────────────────────────────────────
  private detectReversal(params: {
    casDislocationPct: number;
    expiryScore: number;
    signal: TradeSignalType | null;
  }): ReversalAnalysis {
    return {
      reversalRisk: 'NONE',
      type: 'NONE',
      signals: [],
      reversalScore: 0,
      invalidationLevel: 0,
    };
  }

  // ─── Helper: Is Expiry Day ──────────────────────────────────────────
  private isExpiryDay(symbol: string): boolean {
    // Would integrate with expiry-calculator.ts
    return false;
  }

  // ─── Helper: Get Minutes to Expiry ──────────────────────────────────
  private getMinutesToExpiry(symbol: string): number {
    return 0;
  }

  // ─── Configure ───────────────────────────────────────────────────────
  configure(config: Partial<typeof DEFAULT_EXPIRY_LIQUIDITY_CONFIG>): void {
    this.config = { ...this.config, ...config };
    // Propagate to sub-engines
    this.casDislocationEngine.configure({});
    this.futuresDislocationEngine.configure({});
  }

  // ─── Get Signal History ──────────────────────────────────────────────
  getSignalHistory(): Array<{ timestamp: number; signal: any }> {
    return [...this.signalHistory];
  }

  // ─── Reset ───────────────────────────────────────────────────────────
  reset(): void {
    this.signalHistory = [];
    this.casRefEngine.reset();
    this.casDislocationEngine.reset();
    this.futuresDislocationEngine.reset();
    this.optionChainFlowEngine.reset();
    this.premiumVelocityEngine.reset();
    this.ivVelocityEngine.reset();
    this.volumeVelocityEngine.reset();
    this.oiClassificationEngine.reset();
    this.oiConcentrationEngine.configure({});
    this.supportResistanceEngine.configure({});
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────
let expiryLiquidityEngineInstance: ExpiryLiquidityEngine | null = null;

export function getExpiryLiquidityEngine(): ExpiryLiquidityEngine {
  if (!expiryLiquidityEngineInstance) {
    expiryLiquidityEngineInstance = new ExpiryLiquidityEngine();
  }
  return expiryLiquidityEngineInstance;
}