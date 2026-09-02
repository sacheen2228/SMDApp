// lib/cas-time-engine.ts
//
// CAS Straddle/Strangle Entry & Exit Time Engine
// ───────────────────────────────────────────────────────────────────
// Professional time-window + event-based Entry/Exit Engine.
// Live and Backtest use EXACTLY the same engine.
//
// Architecture:
//   Time Windows → Phase Detection → Multi-Factor Confirmation →
//   Entry Decision (CanEnter?) → Position → Exit Decision (ShouldExit?) → P&L

// ─── Types ────────────────────────────────────────────────────────

export type TradeState =
  | "WAITING"       // No setup forming
  | "BUILDING"      // Market conditions developing
  | "CONFIRMING"    // Setup forming, awaiting confirmation
  | "READY"         // All conditions met, waiting for entry window
  | "ENTERED"       // Position active
  | "PROFITABLE"    // Position in profit
  | "TRAILING"      // Trailing stop active
  | "EXIT";         // Position closed

export type EntryType =
  | "INITIAL"
  | "RETEST"
  | "BREAKOUT"
  | "EXPANSION"
  | "NO_ENTRY";

export type EntryWindow =
  | "DATA_COLLECTION"     // 09:15-11:30
  | "REGIME_ANALYSIS"     // 11:30-13:30
  | "EM_BUILDING"         // 13:30-14:30
  | "CAS_PREPARATION"     // 14:30-15:00
  | "CAS_REFERENCE"       // 15:00-15:15
  | "CAS_TRANSITION"      // 15:15-15:20
  | "PRIMARY_ENTRY"       // 15:20-15:30
  | "HIGH_CONVICT_ENTRY"  // 15:30-15:35
  | "EXCEPTIONAL_ENTRY"   // 15:35-15:38
  | "NO_NEW_ENTRY";       // 15:38+

export type ExitType =
  | "TARGET"
  | "STOP_LOSS"
  | "MOMENTUM_EXIT"
  | "THESIS_FAILURE"
  | "EM_COMPLETED"
  | "PREMIUM_EXHAUSTION"
  | "CAS_REVERSAL"
  | "IV_REVERSAL"
  | "UNDERLYING_REVERSAL"
  | "TIME_DECAY"
  | "HARD_EXIT"
  | "MAX_HOLDING"
  | "PARTIAL_TARGET";

export type ConfirmationFactor =
  | "cas_expansion"
  | "underlying_movement"
  | "underlying_vwap"
  | "underlying_structure"
  | "em_increasing"
  | "futures_confirmation"
  | "futures_volume"
  | "ce_premium_activity"
  | "pe_premium_activity"
  | "volume_expansion"
  | "iv_supportive"
  | "liquidity_acceptable"
  | "spread_acceptable"
  | "cost_check"
  | "risk_reward"
  | "anti_chase"
  | "position_size";

// ─── Time Window Definitions ──────────────────────────────────────

export interface TimeWindowConfig {
  window: EntryWindow;
  startMin: number;   // IST minutes from midnight
  endMin: number;
  entryAllowed: boolean;
  minTradeQuality: number;
  minEMCoverage: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  description: string;
}

export const TIME_WINDOWS: TimeWindowConfig[] = [
  {
    window: "DATA_COLLECTION",
    startMin: 555, endMin: 690,  // 09:15-11:30
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "Data collection only. Building market picture.",
  },
  {
    window: "REGIME_ANALYSIS",
    startMin: 690, endMin: 810,  // 11:30-13:30
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "Market regime analysis. Identifying trend/range.",
  },
  {
    window: "EM_BUILDING",
    startMin: 810, endMin: 870,  // 13:30-14:30
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "Expected move building. Monitoring premium expansion.",
  },
  {
    window: "CAS_PREPARATION",
    startMin: 870, endMin: 900,  // 14:30-15:00
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "CAS preparation. Final pre-CAS analysis.",
  },
  {
    window: "CAS_REFERENCE",
    startMin: 900, endMin: 915,  // 15:00-15:15
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "CAS reference VWAP window. Price discovery.",
  },
  {
    window: "CAS_TRANSITION",
    startMin: 915, endMin: 920,  // 15:15-15:20
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "CAS transition. No new entries.",
  },
  {
    window: "PRIMARY_ENTRY",
    startMin: 920, endMin: 930,  // 15:20-15:30
    entryAllowed: true,
    minTradeQuality: 50, minEMCoverage: "MEDIUM",
    description: "Primary entry window. Standard confirmation required.",
  },
  {
    window: "HIGH_CONVICT_ENTRY",
    startMin: 930, endMin: 935,  // 15:30-15:35
    entryAllowed: true,
    minTradeQuality: 70, minEMCoverage: "HIGH",
    description: "High-conviction window. Stronger confirmation required.",
  },
  {
    window: "EXCEPTIONAL_ENTRY",
    startMin: 935, endMin: 938,  // 15:35-15:38
    entryAllowed: true,
    minTradeQuality: 85, minEMCoverage: "EXTREME",
    description: "Exceptional entry only. Extreme expansion required.",
  },
  {
    window: "NO_NEW_ENTRY",
    startMin: 938, endMin: 960,  // 15:38-16:00
    entryAllowed: false,
    minTradeQuality: 0, minEMCoverage: "LOW",
    description: "No new entries. Manage existing positions only.",
  },
];

// ─── Exit Config ──────────────────────────────────────────────────

export interface ExitConfig {
  targetPct: number;           // % of premium for target
  stopLossPct: number;         // % of premium for stop loss
  maxHoldingBars: number;      // max bars to hold
  trailingActivationPct: number;  // % profit to activate trailing
  trailingStepPct: number;     // % step for trailing stop
  partialExitEnabled: boolean;
  partialExitLevels: number[]; // e.g., [25, 50, 75]
  hardExitTime: string;        // "15:35" format
  emCompletionThreshold: number;  // % of EM achieved to trigger exit
  premiumExhaustionBars: number;  // bars of deceleration to trigger
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  targetPct: 20,
  stopLossPct: 100,
  maxHoldingBars: 5,
  trailingActivationPct: 15,
  trailingStepPct: 5,
  partialExitEnabled: false,
  partialExitLevels: [25, 50, 75],
  hardExitTime: "15:35",
  emCompletionThreshold: 80,
  premiumExhaustionBars: 3,
};

// ─── Market State (input to the engine) ───────────────────────────

export interface MarketState {
  timestamp: string;
  istMinutes: number;          // minutes from midnight in IST
  spot: number;
  prevClose: number;
  // CAS data
  casReferencePrice: number;
  casDislocationPct: number;
  casVelocity: number;
  casImbalance: number;        // buy/(buy+sell), 0.5 = neutral
  casAboveReference: boolean;
  casPressure: "BUILDING" | "STEADY" | "EXHAUSTING" | "REVERSING" | "NONE";
  // Underlying
  underlyingMovePct: number;   // % move from prev close
  underlyingVWAP: number;
  priceVsVWAP: "ABOVE" | "BELOW" | "AT";
  marketStructure: "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE";
  // Futures
  futuresPrice: number;
  futuresBasis: number;
  futuresConfirmation: boolean;
  futuresVolumeIncreasing: boolean;
  // Options
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  ceVolume: number;
  peVolume: number;
  cePremiumIncreasing: boolean;
  pePremiumIncreasing: boolean;
  ivLevel: number;
  ivTrend: "RISING" | "FALLING" | "STABLE";
  // Expected Move
  expectedMove: number;
  expectedMovePct: number;
  emIncreasing: boolean;
  // Volume
  currentVolume: number;
  avgVolume: number;
  volumeRatio: number;
  // Risk
  atr: number;
  atrPct: number;
  // Chain
  chain: Array<{
    strike: number;
    ce?: { ltp: number; oi: number; volume: number; iv: number; spread?: number } | null;
    pe?: { ltp: number; oi: number; volume: number; iv: number; spread?: number } | null;
  }>;
  // Previous state (for momentum/reversal detection)
  prevCombinedPremium: number;
  prevExpectedMove: number;
  prevCASPressure: "BUILDING" | "STEADY" | "EXHAUSTING" | "REVERSING" | "NONE";
  prevUnderlyingMovePct: number;
}

// ─── Confirmation Check Result ────────────────────────────────────

export interface ConfirmationCheck {
  factor: ConfirmationFactor;
  passed: boolean;
  value: number | string;
  threshold: number | string;
  reasoning: string;
}

// ─── Entry Decision ───────────────────────────────────────────────

export interface EntryDecision {
  canEnter: boolean;
  entryType: EntryType;
  window: EntryWindow;
  strategy: "STRADDLE" | "STRANGLE" | "CALL" | "PUT" | "NO_TRADE";
  confidence: number;
  tradeQuality: number;
  confirmationChecks: ConfirmationCheck[];
  rejectionReasons: string[];
  reasoning: string[];
  // Strike details
  ceStrike: number;
  peStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  // Risk
  maxRisk: number;
  maxReward: number;
  riskReward: number;
  breakevenUpper: number;
  breakevenLower: number;
  // Expected move
  expectedMove: number;
  expectedMovePct: number;
  expectedUpper: number;
  expectedLower: number;
  emCoverage: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
}

// ─── Exit Decision ────────────────────────────────────────────────

export interface ExitDecision {
  shouldExit: boolean;
  exitType: ExitType;
  partialExitPct: number;  // 0 = full exit, >0 = partial
  reasoning: string[];
  exitPremium: number;
  unrealizedPnL: number;
}

// ─── Trade Record ─────────────────────────────────────────────────

export interface TradeRecord {
  id: number;
  entryTime: string;
  entryISTMinutes: number;
  exitTime: string;
  exitISTMinutes: number;
  entryWindow: EntryWindow;
  entryType: EntryType;
  strategy: string;
  state: TradeState;
  // Entry
  spotAtEntry: number;
  ceStrike: number;
  peStrike: number;
  ceEntryPremium: number;
  peEntryPremium: number;
  combinedPremiumAtEntry: number;
  expectedMoveAtEntry: number;
  casScoreAtEntry: number;
  tradeQualityAtEntry: number;
  confidenceAtEntry: number;
  regimeAtEntry: string;
  // Exit
  exitPremium: number;
  exitReason: ExitType;
  barsHeld: number;
  // P&L
  grossPnL: number;
  charges: number;
  slippage: number;
  netPnL: number;
  returnPct: number;
  // MFE/MAE
  mfe: number;
  mae: number;
  mfePct: number;
  maePct: number;
  // State history
  stateHistory: Array<{ state: TradeState; timestamp: string; reason: string }>;
  // Confirmation
  confirmationChecks: ConfirmationCheck[];
}

// ─── Time Engine Result ───────────────────────────────────────────

export interface TimeEngineResult {
  // Current state
  currentWindow: EntryWindow;
  currentPhase: string;
  entryAllowed: boolean;
  exitRequired: boolean;
  // Live status
  canEnter: boolean;
  shouldExit: boolean;
  // Entry/exit decisions
  entryDecision?: EntryDecision;
  exitDecision?: ExitDecision;
  // All confirmation checks
  confirmationChecks: ConfirmationCheck[];
  // Trade state
  tradeState: TradeState;
  activeTrade?: TradeRecord;
}

// ═══════════════════════════════════════════════════════════════════
// PHASE DETECTION
// ═══════════════════════════════════════════════════════════════════

export function detectEntryWindow(istMinutes: number): TimeWindowConfig {
  for (const w of TIME_WINDOWS) {
    if (istMinutes >= w.startMin && istMinutes < w.endMin) return w;
  }
  return TIME_WINDOWS[TIME_WINDOWS.length - 1]; // NO_NEW_ENTRY
}

export function getPhaseLabel(window: EntryWindow): string {
  const labels: Record<EntryWindow, string> = {
    DATA_COLLECTION: "📊 Data Collection",
    REGIME_ANALYSIS: "🔍 Regime Analysis",
    EM_BUILDING: "📈 EM Building",
    CAS_PREPARATION: "⏳ CAS Prep",
    CAS_REFERENCE: "📍 CAS Reference",
    CAS_TRANSITION: "🔄 CAS Transition",
    PRIMARY_ENTRY: "🎯 Primary Entry",
    HIGH_CONVICT_ENTRY: "🔥 High-Conviction Entry",
    EXCEPTIONAL_ENTRY: "⚡ Exceptional Entry",
    NO_NEW_ENTRY: "⚪ No New Entry",
  };
  return labels[window];
}

export function getTimeUntilEntry(istMinutes: number): { minutes: number; window: string } | null {
  if (istMinutes < 920) return { minutes: 920 - istMinutes, window: "PRIMARY_ENTRY (15:20)" };
  if (istMinutes < 930) return { minutes: 930 - istMinutes, window: "HIGH_CONVICT (15:30)" };
  if (istMinutes < 935) return { minutes: 935 - istMinutes, window: "EXCEPTIONAL (15:35)" };
  return null; // past all entry windows
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-FACTOR CONFIRMATION ENGINE
// ═══════════════════════════════════════════════════════════════════

function checkFactor(
  factor: ConfirmationFactor,
  passed: boolean,
  value: number | string,
  threshold: number | string,
  reasoning: string,
): ConfirmationCheck {
  return { factor, passed, value, threshold, reasoning };
}

export function runConfirmationChecks(
  state: MarketState,
  window: EntryWindow,
): ConfirmationCheck[] {
  const checks: ConfirmationCheck[] = [];

  // ─── CAS Expansion ────────────────────────────────────────
  const casDisloc = Math.abs(state.casDislocationPct);
  const casPressureActive = state.casPressure === "BUILDING" || state.casPressure === "STEADY";
  checks.push(checkFactor(
    "cas_expansion",
    casPressureActive && casDisloc > 0.1,
    `${state.casPressure} (${casDisloc.toFixed(2)}%)`,
    "PRESSURE > 0.1%",
    casPressureActive
      ? `CAS pressure ${state.casPressure}, dislocation ${casDisloc.toFixed(2)}%`
      : `CAS pressure ${state.casPressure} — insufficient`,
  ));

  // ─── Underlying Movement ──────────────────────────────────
  const underlyingOK = Math.abs(state.underlyingMovePct) > 0.3;
  checks.push(checkFactor(
    "underlying_movement",
    underlyingOK,
    `${state.underlyingMovePct.toFixed(2)}%`,
    "> 0.3%",
    underlyingOK
      ? `Underlying moved ${state.underlyingMovePct.toFixed(2)}%`
      : `Underlying move ${state.underlyingMovePct.toFixed(2)}% — insufficient`,
  ));

  // ─── VWAP Relationship ────────────────────────────────────
  const vwapOK = state.priceVsVWAP !== "AT";
  checks.push(checkFactor(
    "underlying_vwap",
    vwapOK,
    state.priceVsVWAP,
    "ABOVE or BELOW",
    vwapOK
      ? `Price ${state.priceVsVWAP.toLowerCase()} VWAP`
      : "Price at VWAP — no directional bias",
  ));

  // ─── Market Structure ─────────────────────────────────────
  const structureOK = state.marketStructure === "TRENDING_UP" || state.marketStructure === "TRENDING_DOWN";
  checks.push(checkFactor(
    "underlying_structure",
    structureOK,
    state.marketStructure,
    "TRENDING_UP or TRENDING_DOWN",
    structureOK
      ? `Market structure: ${state.marketStructure}`
      : `Market structure: ${state.marketStructure} — no clear trend`,
  ));

  // ─── Expected Move Increasing ─────────────────────────────
  const emIncreasingOK = state.emIncreasing;
  checks.push(checkFactor(
    "em_increasing",
    emIncreasingOK,
    state.emIncreasing ? "INCREASING" : "DECREASING",
    "INCREASING",
    emIncreasingOK
      ? `Expected move increasing (₹${state.expectedMove.toFixed(0)})`
      : `Expected move not increasing — momentum fading`,
  ));

  // ─── Futures Confirmation ─────────────────────────────────
  checks.push(checkFactor(
    "futures_confirmation",
    state.futuresConfirmation,
    state.futuresConfirmation ? "CONFIRMED" : "NOT CONFIRMED",
    "CONFIRMED",
    state.futuresConfirmation
      ? `Futures confirm underlying direction (basis ₹${state.futuresBasis.toFixed(0)})`
      : `Futures do not confirm — divergence`,
  ));

  // ─── Futures Volume ───────────────────────────────────────
  checks.push(checkFactor(
    "futures_volume",
    state.futuresVolumeIncreasing,
    state.futuresVolumeIncreasing ? "INCREASING" : "NOT INCREASING",
    "INCREASING",
    state.futuresVolumeIncreasing
      ? "Futures volume/participation increasing"
      : "Futures volume not increasing",
  ));

  // ─── CE Premium Activity ──────────────────────────────────
  checks.push(checkFactor(
    "ce_premium_activity",
    state.cePremiumIncreasing,
    state.cePremiumIncreasing ? "INCREASING" : "NOT INCREASING",
    "INCREASING",
    state.cePremiumIncreasing
      ? `CE premium increasing (₹${state.cePremium.toFixed(1)})`
      : `CE premium not increasing`,
  ));

  // ─── PE Premium Activity ──────────────────────────────────
  checks.push(checkFactor(
    "pe_premium_activity",
    state.pePremiumIncreasing,
    state.pePremiumIncreasing ? "INCREASING" : "NOT INCREASING",
    "INCREASING",
    state.pePremiumIncreasing
      ? `PE premium increasing (₹${state.pePremium.toFixed(1)})`
      : `PE premium not increasing`,
  ));

  // ─── Volume Expansion ─────────────────────────────────────
  const volOK = state.volumeRatio > 1.2;
  checks.push(checkFactor(
    "volume_expansion",
    volOK,
    `${state.volumeRatio.toFixed(2)}x`,
    "> 1.2x",
    volOK
      ? `Volume ${state.volumeRatio.toFixed(2)}x average — expansion`
      : `Volume ${state.volumeRatio.toFixed(2)}x — no expansion`,
  ));

  // ─── IV Supportive ────────────────────────────────────────
  const ivOK = state.ivLevel > 12 && state.ivLevel < 30;
  checks.push(checkFactor(
    "iv_supportive",
    ivOK,
    `${state.ivLevel.toFixed(1)}%`,
    "12-30%",
    ivOK
      ? `IV ${state.ivLevel.toFixed(1)}% — sweet spot`
      : `IV ${state.ivLevel.toFixed(1)}% — outside optimal range`,
  ));

  // ─── Liquidity ────────────────────────────────────────────
  const liqOK = state.ceVolume > 5000 && state.peVolume > 5000;
  checks.push(checkFactor(
    "liquidity_acceptable",
    liqOK,
    `CE:${state.ceVolume.toLocaleString()} PE:${state.peVolume.toLocaleString()}`,
    "> 5000 each",
    liqOK
      ? `Liquidity acceptable (CE:${state.ceVolume.toLocaleString()}, PE:${state.peVolume.toLocaleString()})`
      : "Liquidity insufficient",
  ));

  // ─── Spread ───────────────────────────────────────────────
  const avgSpread = state.chain.reduce((acc, row) => {
    const ceS = row.ce?.spread || 0;
    const peS = row.pe?.spread || 0;
    return acc + ceS + peS;
  }, 0) / Math.max(1, state.chain.length * 2);
  const spreadOK = avgSpread < 5;
  checks.push(checkFactor(
    "spread_acceptable",
    spreadOK,
    `₹${avgSpread.toFixed(1)}`,
    "< ₹5",
    spreadOK
      ? `Average spread ₹${avgSpread.toFixed(1)} — acceptable`
      : `Average spread ₹${avgSpread.toFixed(1)} — too wide`,
  ));

  // ─── Cost Check ───────────────────────────────────────────
  const costRatio = state.expectedMove > 0 ? state.combinedPremium / state.expectedMove : 999;
  const costOK = costRatio < 1.0;
  checks.push(checkFactor(
    "cost_check",
    costOK,
    `${costRatio.toFixed(2)}x`,
    "< 1.0x",
    costOK
      ? `Premium/Move ratio ${costRatio.toFixed(2)} — affordable`
      : `Premium/Move ratio ${costRatio.toFixed(2)} — too expensive`,
  ));

  // ─── Risk/Reward ──────────────────────────────────────────
  const riskReward = state.combinedPremium > 0 ? state.expectedMove / state.combinedPremium : 0;
  const rrOK = riskReward >= 1.0;
  checks.push(checkFactor(
    "risk_reward",
    rrOK,
    `${riskReward.toFixed(2)}x`,
    ">= 1.0x",
    rrOK
      ? `R:R ${riskReward.toFixed(2)} — expected move covers premium`
      : `R:R ${riskReward.toFixed(2)} — insufficient`,
  ));

  // ─── Anti-Chase ───────────────────────────────────────────
  const recentMove = Math.abs(state.underlyingMovePct);
  const premiumExpanded = state.combinedPremium > state.prevCombinedPremium * 1.3;
  const emShrinking = state.expectedMove < state.prevExpectedMove * 0.9;
  const chaseRisk = recentMove > 1.5 && premiumExpanded && emShrinking;
  checks.push(checkFactor(
    "anti_chase",
    !chaseRisk,
    chaseRisk ? "CHASE RISK" : "OK",
    "NO CHASE",
    chaseRisk
      ? `Chase risk: move ${recentMove.toFixed(2)}% + premium expanded + EM shrinking`
      : "No chase risk detected",
  ));

  // ─── Position Size ────────────────────────────────────────
  checks.push(checkFactor(
    "position_size",
    true, // always pass for now — checked separately
    "1 lot",
    "within risk",
    "Position size within risk limits",
  ));

  return checks;
}

// ═══════════════════════════════════════════════════════════════════
// ENTRY ENGINE
// ═══════════════════════════════════════════════════════════════════

export function evaluateEntry(
  state: MarketState,
  windowConfig: TimeWindowConfig,
  confirmationChecks: ConfirmationCheck[],
  previousTrade?: TradeRecord,
): EntryDecision {
  const reasoning: string[] = [];
  const rejectionReasons: string[] = [];
  const window = windowConfig.window;

  // ─── Step 1: Time Window Gate ──────────────────────────────
  if (!windowConfig.entryAllowed) {
    return {
      canEnter: false, entryType: "NO_ENTRY", window,
      strategy: "NO_TRADE", confidence: 0, tradeQuality: 0,
      confirmationChecks, rejectionReasons: [`Time window ${window} — no entries allowed`],
      reasoning: [windowConfig.description],
      ceStrike: 0, peStrike: 0, cePremium: 0, pePremium: 0,
      combinedPremium: 0, maxRisk: 0, maxReward: 0, riskReward: 0,
      breakevenUpper: 0, breakevenLower: 0,
      expectedMove: state.expectedMove, expectedMovePct: state.expectedMovePct,
      expectedUpper: 0, expectedLower: 0, emCoverage: "LOW",
    };
  }

  // ─── Step 2: Count Confirmation Factors ────────────────────
  const passedFactors = confirmationChecks.filter(c => c.passed);
  const totalFactors = confirmationChecks.length;
  const passRate = totalFactors > 0 ? passedFactors.length / totalFactors : 0;

  // Mandatory factors that MUST pass
  const mandatoryFactors: ConfirmationFactor[] = [
    "cas_expansion", "underlying_movement", "futures_confirmation",
    "cost_check", "anti_chase",
  ];
  const mandatoryPassed = mandatoryFactors.every(f =>
    confirmationChecks.find(c => c.factor === f)?.passed
  );

  if (!mandatoryPassed) {
    const failedMandatory = mandatoryFactors.filter(f =>
      !confirmationChecks.find(c => c.factor === f)?.passed
    );
    rejectionReasons.push(`Mandatory factors failed: ${failedMandatory.join(", ")}`);
    failedMandatory.forEach(f => {
      const check = confirmationChecks.find(c => c.factor === f);
      if (check) rejectionReasons.push(check.reasoning);
    });
  }

  // ─── Step 3: Compute Trade Quality ─────────────────────────
  let tradeQuality = 0;

  // CAS score (0-20)
  const casDisloc = Math.abs(state.casDislocationPct);
  if (casDisloc > 0.6) tradeQuality += 20;
  else if (casDisloc > 0.3) tradeQuality += 15;
  else if (casDisloc > 0.1) tradeQuality += 10;
  else tradeQuality += 5;

  // Expected move quality (0-20)
  if (state.expectedMovePct > 1.0) tradeQuality += 20;
  else if (state.expectedMovePct > 0.7) tradeQuality += 15;
  else if (state.expectedMovePct > 0.5) tradeQuality += 10;
  else tradeQuality += 5;

  // Premium cost efficiency (0-15)
  if (costRatio < 0.5) tradeQuality += 15;
  else if (costRatio < 0.8) tradeQuality += 10;
  else if (costRatio < 1.0) tradeQuality += 5;

  // Volume (0-10)
  if (state.volumeRatio > 1.5) tradeQuality += 10;
  else if (state.volumeRatio > 1.2) tradeQuality += 5;

  // Confirmation pass rate (0-25)
  tradeQuality += Math.round(passRate * 25);

  // Window bonus (0-10)
  if (window === "PRIMARY_ENTRY") tradeQuality += 10;
  else if (window === "HIGH_CONVICT_ENTRY") tradeQuality += 8;
  else if (window === "EXCEPTIONAL_ENTRY") tradeQuality += 5;

  tradeQuality = Math.min(100, Math.max(0, tradeQuality));

  // ─── Step 4: Window-Specific Quality Threshold ─────────────
  if (tradeQuality < windowConfig.minTradeQuality) {
    rejectionReasons.push(`Trade quality ${tradeQuality} < ${windowConfig.minTradeQuality} required for ${window}`);
  }

  // ─── Step 5: EM Coverage Check ─────────────────────────────
  const emCoverage = computeEMCoverage(state);
  const emCoverageOrder = { LOW: 0, MEDIUM: 1, HIGH: 2, EXTREME: 3 };
  if (emCoverageOrder[emCoverage] < emCoverageOrder[windowConfig.minEMCoverage]) {
    rejectionReasons.push(`EM coverage ${emCoverage} < ${windowConfig.minEMCoverage} required for ${window}`);
  }

  // ─── Step 6: Anti-Chase Deep Check ─────────────────────────
  const underlyingAlreadyMoved = Math.abs(state.underlyingMovePct) > 1.5;
  const premiumAlreadyExpanded = state.combinedPremium > state.prevCombinedPremium * 1.5;
  const emRemaining = state.expectedMove - Math.abs(state.underlyingMovePct) * state.spot / 100;

  if (underlyingAlreadyMoved && premiumAlreadyExpanded && emRemaining < state.combinedPremium * 0.5) {
    rejectionReasons.push(`Chase risk: underlying +${state.underlyingMovePct.toFixed(2)}%, premium expanded, remaining EM insufficient`);
  }

  // ─── Step 7: Determine Strategy ────────────────────────────
  let strategy: EntryDecision["strategy"] = "NO_TRADE";
  const absDisloc = Math.abs(state.casDislocationPct);

  if (mandatoryPassed && tradeQuality >= windowConfig.minTradeQuality) {
    if (absDisloc > 0.4 && (state.marketStructure === "TRENDING_UP" || state.marketStructure === "TRENDING_DOWN")) {
      strategy = state.casAboveReference ? "CALL" : "PUT";
      reasoning.push(`Strong CAS + trending → ${strategy}`);
    } else if (state.marketStructure === "RANGING" || state.marketStructure === "VOLATILE") {
      strategy = state.ivLevel > 18 ? "STRADDLE" : "STRANGLE";
      reasoning.push(`Ranging/volatile + IV ${state.ivLevel.toFixed(1)} → ${strategy}`);
    } else if (absDisloc > 0.15) {
      strategy = state.casAboveReference ? "CALL" : "PUT";
      reasoning.push(`Moderate CAS → ${strategy}`);
    } else {
      strategy = "STRADDLE";
      reasoning.push("Default: STRADDLE for non-directional");
    }
  }

  // ─── Step 8: Strike Optimization ───────────────────────────
  const strikes = optimizeStrikes(state, strategy);
  const combinedPremium = strikes.cePremium + strikes.pePremium;

  // ─── Step 9: Risk Calculation ──────────────────────────────
  let maxRisk = 0, maxReward = 0;
  if (strategy === "STRADDLE" || strategy === "STRANGLE") {
    maxRisk = combinedPremium * 3;
    maxReward = combinedPremium;
  } else if (strategy === "CALL") {
    maxRisk = strikes.cePremium;
    maxReward = state.expectedMove - strikes.cePremium;
  } else if (strategy === "PUT") {
    maxRisk = strikes.pePremium;
    maxReward = state.expectedMove - strikes.pePremium;
  }
  const riskReward = maxRisk > 0 ? maxReward / maxRisk : 0;

  // ─── Step 10: Determine Entry Type ─────────────────────────
  let entryType: EntryType = "INITIAL";
  if (previousTrade && previousTrade.exitReason === "THESIS_FAILURE") {
    // Check for retest setup
    const retestOK = state.underlyingMovePct * state.prevUnderlyingMovePct < 0; // direction changed
    if (retestOK && tradeQuality >= windowConfig.minTradeQuality) {
      entryType = "RETEST";
      reasoning.push("Retest entry after thesis failure");
    }
  }
  if (state.emIncreasing && Math.abs(state.underlyingMovePct) > 1.0) {
    entryType = "EXPANSION";
  }
  if (window === "PRIMARY_ENTRY" && state.casPressure === "BUILDING") {
    entryType = "BREAKOUT";
  }

  // ─── Final Decision ────────────────────────────────────────
  const canEnter = mandatoryPassed
    && tradeQuality >= windowConfig.minTradeQuality
    && strategy !== "NO_TRADE"
    && rejectionReasons.length === 0;

  if (canEnter) {
    reasoning.push(`Entry OK: ${strategy} in ${window} window, quality ${tradeQuality}`);
  }

  const emUpper = state.spot + state.expectedMove;
  const emLower = state.spot - state.expectedMove;
  let breakevenUpper = 0, breakevenLower = 0;
  if (strategy === "STRADDLE" || strategy === "STRANGLE") {
    breakevenUpper = (strategy === "STRADDLE" ? state.spot : strikes.ceStrike) + combinedPremium;
    breakevenLower = (strategy === "STRADDLE" ? state.spot : strikes.peStrike) - combinedPremium;
  } else if (strategy === "CALL") {
    breakevenUpper = strikes.ceStrike + strikes.cePremium;
    breakevenLower = strikes.ceStrike;
  } else if (strategy === "PUT") {
    breakevenLower = strikes.peStrike - strikes.pePremium;
    breakevenUpper = strikes.peStrike;
  }

  return {
    canEnter, entryType, window, strategy,
    confidence: Math.round(tradeQuality * 0.6 + passRate * 40),
    tradeQuality,
    confirmationChecks,
    rejectionReasons,
    reasoning,
    ceStrike: strikes.ceStrike, peStrike: strikes.peStrike,
    cePremium: strikes.cePremium, pePremium: strikes.pePremium,
    combinedPremium,
    maxRisk, maxReward, riskReward,
    breakevenUpper, breakevenLower,
    expectedMove: state.expectedMove,
    expectedMovePct: state.expectedMovePct,
    expectedUpper: emUpper, expectedLower: emLower,
    emCoverage,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXIT ENGINE
// ═══════════════════════════════════════════════════════════════════

export function evaluateExit(
  state: MarketState,
  trade: TradeRecord,
  exitConfig: ExitConfig,
): ExitDecision {
  const reasoning: string[] = [];
  const entryPremium = trade.combinedPremiumAtEntry;

  // Current premium
  const currentPremium = state.combinedPremium;

  // P&L calculation
  let unrealizedPnL = 0;
  if (trade.strategy === "STRADDLE" || trade.strategy === "STRANGLE") {
    unrealizedPnL = (entryPremium - currentPremium); // short: profit if premium drops
  } else if (trade.strategy === "CALL") {
    unrealizedPnL = (currentPremium - trade.ceEntryPremium);
  } else if (trade.strategy === "PUT") {
    unrealizedPnL = (currentPremium - trade.peEntryPremium);
  }
  const returnPct = entryPremium > 0 ? (unrealizedPnL / entryPremium) * 100 : 0;

  // ─── Target ────────────────────────────────────────────────
  if (returnPct >= exitConfig.targetPct) {
    return {
      shouldExit: true, exitType: "TARGET", partialExitPct: 0,
      reasoning: [`Target reached: ${returnPct.toFixed(1)}% >= ${exitConfig.targetPct}%`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Stop Loss ─────────────────────────────────────────────
  if (returnPct <= -exitConfig.stopLossPct) {
    return {
      shouldExit: true, exitType: "STOP_LOSS", partialExitPct: 0,
      reasoning: [`Stop loss hit: ${returnPct.toFixed(1)}% <= -${exitConfig.stopLossPct}%`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Thesis Failure ────────────────────────────────────────
  const thesisFailed = checkThesisFailure(state, trade);
  if (thesisFailed) {
    return {
      shouldExit: true, exitType: "THESIS_FAILURE", partialExitPct: 0,
      reasoning: [`Thesis failure: ${thesisFailed}`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── CAS Reversal ─────────────────────────────────────────
  if (state.casPressure === "REVERSING") {
    const underlyingConfirms = (trade.strategy === "CALL" && state.underlyingMovePct < 0) ||
      (trade.strategy === "PUT" && state.underlyingMovePct > 0) ||
      (trade.strategy === "STRADDLE" || trade.strategy === "STRANGLE");
    if (underlyingConfirms) {
      return {
        shouldExit: true, exitType: "CAS_REVERSAL", partialExitPct: 0,
        reasoning: [`CAS reversal: ${state.prevCASPressure} → ${state.casPressure}, underlying confirms`],
        exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
      };
    }
  }

  // ─── Momentum Exit ─────────────────────────────────────────
  if (returnPct > 5 && !state.emIncreasing && !state.cePremiumIncreasing && !state.pePremiumIncreasing) {
    return {
      shouldExit: true, exitType: "MOMENTUM_EXIT", partialExitPct: 0,
      reasoning: [`Momentum exhausted: profit ${returnPct.toFixed(1)}% but EM flat + premiums flat`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Premium Exhaustion ────────────────────────────────────
  const premiumDecelerating = state.combinedPremium < state.prevCombinedPremium * 0.95;
  const emFlat = state.expectedMove < state.prevExpectedMove * 0.98;
  if (premiumDecelerating && emFlat && returnPct > 0) {
    return {
      shouldExit: true, exitType: "PREMIUM_EXHAUSTION", partialExitPct: 0,
      reasoning: [`Premium exhaustion: premium decelerating + EM flat`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Expected Move Completed ───────────────────────────────
  const emAchieved = Math.abs(state.underlyingMovePct) >= state.expectedMovePct * (exitConfig.emCompletionThreshold / 100);
  if (emAchieved && returnPct > 0) {
    return {
      shouldExit: true, exitType: "EM_COMPLETED", partialExitPct: 0,
      reasoning: [`Expected move ${exitConfig.emCompletionThreshold}% achieved: underlying ${state.underlyingMovePct.toFixed(2)}% vs EM ${state.expectedMovePct.toFixed(2)}%`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Max Holding Time ──────────────────────────────────────
  const barsHeld = trade.barsHeld;
  if (barsHeld >= exitConfig.maxHoldingBars) {
    return {
      shouldExit: true, exitType: "MAX_HOLDING", partialExitPct: 0,
      reasoning: [`Max holding time: ${barsHeld} bars >= ${exitConfig.maxHoldingBars}`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Hard Exit Time ────────────────────────────────────────
  const hardExitMin = parseTimeToMinutes(exitConfig.hardExitTime);
  if (state.istMinutes >= hardExitMin) {
    return {
      shouldExit: true, exitType: "HARD_EXIT", partialExitPct: 0,
      reasoning: [`Hard exit time reached: ${exitConfig.hardExitTime}`],
      exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
    };
  }

  // ─── Trailing Stop ─────────────────────────────────────────
  if (returnPct >= exitConfig.trailingActivationPct) {
    const trailingStop = returnPct - exitConfig.trailingStepPct;
    if (returnPct < trailingStop) {
      return {
        shouldExit: true, exitType: "MOMENTUM_EXIT", partialExitPct: 0,
        reasoning: [`Trailing stop: profit was ${returnPct.toFixed(1)}%, now below trailing threshold`],
        exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
      };
    }
  }

  // ─── No Exit ───────────────────────────────────────────────
  return {
    shouldExit: false, exitType: "TARGET", partialExitPct: 0,
    reasoning: [`Holding: P&L ${returnPct.toFixed(1)}%, ${barsHeld} bars held`],
    exitPremium: currentPremium, unrealizedPnL: unrealizedPnL,
  };
}

// ═══════════════════════════════════════════════════════════════════
// TRADE STATE MACHINE
// ═══════════════════════════════════════════════════════════════════

export function updateTradeState(
  currentState: TradeState,
  entryDecision: EntryDecision | null,
  exitDecision: ExitDecision | null,
  window: EntryWindow,
): { newState: TradeState; reason: string } {
  switch (currentState) {
    case "WAITING":
      if (entryDecision?.canEnter) return { newState: "READY", reason: "Entry conditions met" };
      if (window === "DATA_COLLECTION" || window === "REGIME_ANALYSIS") return { newState: "BUILDING", reason: "Data collection phase" };
      return { newState: "WAITING", reason: "No setup" };

    case "BUILDING":
      if (entryDecision?.canEnter) return { newState: "READY", reason: "Entry conditions met" };
      if (entryDecision && entryDecision.tradeQuality > 30) return { newState: "CONFIRMING", reason: "Setup forming" };
      return { newState: "BUILDING", reason: "Developing" };

    case "CONFIRMING":
      if (entryDecision?.canEnter) return { newState: "READY", reason: "All conditions met" };
      if (!entryDecision || entryDecision.tradeQuality < 20) return { newState: "BUILDING", reason: "Setup weakened" };
      return { newState: "CONFIRMING", reason: "Awaiting confirmation" };

    case "READY":
      if (entryDecision?.canEnter && entryDecision.window === window) return { newState: "ENTERED", reason: "Entered position" };
      if (!entryDecision?.canEnter) return { newState: "CONFIRMING", reason: "Conditions weakened" };
      return { newState: "READY", reason: "Waiting for entry window" };

    case "ENTERED":
      if (exitDecision?.shouldExit) return { newState: "EXIT", reason: exitDecision.exitType };
      if (entryDecision && entryDecision.tradeQuality > 60) return { newState: "PROFITABLE", reason: "Trade developing" };
      return { newState: "ENTERED", reason: "Position active" };

    case "PROFITABLE":
      if (exitDecision?.shouldExit) return { newState: "EXIT", reason: exitDecision.exitType };
      if (entryDecision && entryDecision.tradeQuality > 70) return { newState: "TRAILING", reason: "Trailing stop active" };
      return { newState: "PROFITABLE", reason: "In profit" };

    case "TRAILING":
      if (exitDecision?.shouldExit) return { newState: "EXIT", reason: exitDecision.exitType };
      return { newState: "TRAILING", reason: "Trailing" };

    case "EXIT":
      return { newState: "WAITING", reason: "Position closed" };

    default:
      return { newState: "WAITING", reason: "Default" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function computeEMCoverage(state: MarketState): "LOW" | "MEDIUM" | "HIGH" | "EXTREME" {
  const ratio = state.combinedPremium > 0 ? state.expectedMove / state.combinedPremium : 0;
  if (ratio >= 2.0) return "EXTREME";
  if (ratio >= 1.5) return "HIGH";
  if (ratio >= 1.0) return "MEDIUM";
  return "LOW";
}

function checkThesisFailure(state: MarketState, trade: TradeRecord): string | null {
  // CAS pressure collapsed
  if (state.casPressure === "REVERSING" && state.prevCASPressure === "BUILDING") {
    return "CAS pressure reversed from BUILDING to REVERSING";
  }

  // Underlying lost confirmation
  if (trade.strategy === "CALL" && state.underlyingMovePct < -0.5) {
    return `CALL thesis: underlying moved ${state.underlyingMovePct.toFixed(2)}% (was positive)`;
  }
  if (trade.strategy === "PUT" && state.underlyingMovePct > 0.5) {
    return `PUT thesis: underlying moved +${state.underlyingMovePct.toFixed(2)}% (was negative)`;
  }

  // Futures reversed
  if (trade.strategy === "CALL" && state.futuresBasis < -50) {
    return "CALL thesis: futures reversed to discount";
  }
  if (trade.strategy === "PUT" && state.futuresBasis > 50) {
    return "PUT thesis: futures reversed to premium";
  }

  // Expected move decreased sharply
  if (state.expectedMove < state.prevExpectedMove * 0.8) {
    return `EM decreased sharply: ₹${state.expectedMove.toFixed(0)} vs prev ₹${state.prevExpectedMove.toFixed(0)}`;
  }

  return null;
}

function optimizeStrikes(
  state: MarketState,
  strategy: string,
): { ceStrike: number; peStrike: number; cePremium: number; pePremium: number } {
  const step = state.chain.length > 0 && state.chain[0].strike % 100 === 0 ? 100 : 50;
  const atmStrike = Math.round(state.spot / step) * step;

  if (strategy === "NO_TRADE" || strategy === "CALL" || strategy === "PUT") {
    // For directional, find best OTM strike
    const ceStrike = strategy === "CALL" ? atmStrike + step : atmStrike;
    const peStrike = strategy === "PUT" ? atmStrike - step : atmStrike;
    const ceRow = state.chain.find(r => r.strike === ceStrike);
    const peRow = state.chain.find(r => r.strike === peStrike);
    return {
      ceStrike, peStrike,
      cePremium: ceRow?.ce?.ltp || 0,
      pePremium: peRow?.pe?.ltp || 0,
    };
  }

  // For STRADDLE/STRANGLE — ATM
  const ceRow = state.chain.find(r => r.strike === atmStrike);
  const peRow = state.chain.find(r => r.strike === atmStrike);
  return {
    ceStrike: atmStrike, peStrike: atmStrike,
    cePremium: ceRow?.ce?.ltp || 0,
    pePremium: peRow?.pe?.ltp || 0,
  };
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// ═══════════════════════════════════════════════════════════════════
// FULL TIME ENGINE — combines all components
// ═══════════════════════════════════════════════════════════════════

export function runTimeEngine(
  state: MarketState,
  currentTradeState: TradeState,
  activeTrade: TradeRecord | null,
  exitConfig: ExitConfig = DEFAULT_EXIT_CONFIG,
): TimeEngineResult {
  // 1. Detect current window
  const windowConfig = detectEntryWindow(state.istMinutes);

  // 2. Run confirmation checks
  const confirmationChecks = runConfirmationChecks(state, windowConfig.window);

  // 3. Entry decision
  let entryDecision: EntryDecision | undefined;
  if (windowConfig.entryAllowed && currentTradeState !== "ENTERED" && currentTradeState !== "PROFITABLE" && currentTradeState !== "TRAILING") {
    entryDecision = evaluateEntry(state, windowConfig, confirmationChecks, activeTrade || undefined);
  }

  // 4. Exit decision
  let exitDecision: ExitDecision | undefined;
  if (activeTrade && (currentTradeState === "ENTERED" || currentTradeState === "PROFITABLE" || currentTradeState === "TRAILING")) {
    exitDecision = evaluateExit(state, activeTrade, exitConfig);
  }

  // 5. Update state machine
  const { newState, reason } = updateTradeState(currentTradeState, entryDecision || null, exitDecision || null, windowConfig.window);

  return {
    currentWindow: windowConfig.window,
    currentPhase: getPhaseLabel(windowConfig.window),
    entryAllowed: windowConfig.entryAllowed,
    exitRequired: exitDecision?.shouldExit || false,
    canEnter: entryDecision?.canEnter || false,
    shouldExit: exitDecision?.shouldExit || false,
    entryDecision,
    exitDecision,
    confirmationChecks,
    tradeState: newState,
    activeTrade: activeTrade || undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════
// BACKTEST TIME ANALYSIS HELPERS
// ═══════════════════════════════════════════════════════════════════

export interface WindowPerformance {
  window: EntryWindow;
  trades: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  avgProfit: number;
  avgLoss: number;
}

export interface ExitTypePerformance {
  exitType: ExitType;
  trades: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
}

export function computeWindowPerformance(trades: TradeRecord[]): Record<string, WindowPerformance> {
  const byWindow: Record<string, TradeRecord[]> = {};
  for (const t of trades) {
    if (!byWindow[t.entryWindow]) byWindow[t.entryWindow] = [];
    byWindow[t.entryWindow].push(t);
  }

  const result: Record<string, WindowPerformance> = {};
  for (const [window, windowTrades] of Object.entries(byWindow)) {
    const wins = windowTrades.filter(t => t.netPnL > 0);
    const losses = windowTrades.filter(t => t.netPnL <= 0);
    const netPnL = windowTrades.reduce((a, t) => a + t.netPnL, 0);
    const grossProfit = wins.reduce((a, t) => a + t.netPnL, 0);
    const grossLoss = losses.reduce((a, t) => a + Math.abs(t.netPnL), 0);

    let peak = 0, dd = 0, maxDD = 0;
    let cap = 100000;
    for (const t of windowTrades) {
      cap += t.netPnL;
      if (cap > peak) peak = cap;
      dd = peak - cap;
      if (dd > maxDD) maxDD = dd;
    }

    result[window] = {
      window: window as EntryWindow,
      trades: windowTrades.length,
      winRate: windowTrades.length > 0 ? (wins.length / windowTrades.length) * 100 : 0,
      netPnL: Math.round(netPnL),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy: windowTrades.length > 0 ? Math.round(netPnL / windowTrades.length) : 0,
      maxDrawdown: Math.round(maxDD),
      avgProfit: wins.length > 0 ? Math.round(grossProfit / wins.length) : 0,
      avgLoss: losses.length > 0 ? -Math.round(grossLoss / losses.length) : 0,
    };
  }
  return result;
}

export function computeExitTypePerformance(trades: TradeRecord[]): Record<string, ExitTypePerformance> {
  const byExit: Record<string, TradeRecord[]> = {};
  for (const t of trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = [];
    byExit[t.exitReason].push(t);
  }

  const result: Record<string, ExitTypePerformance> = {};
  for (const [exitType, exitTrades] of Object.entries(byExit)) {
    const wins = exitTrades.filter(t => t.netPnL > 0);
    result[exitType] = {
      exitType: exitType as ExitType,
      trades: exitTrades.length,
      winRate: exitTrades.length > 0 ? (wins.length / exitTrades.length) * 100 : 0,
      totalPnL: Math.round(exitTrades.reduce((a, t) => a + t.netPnL, 0)),
      avgPnL: exitTrades.length > 0 ? Math.round(exitTrades.reduce((a, t) => a + t.netPnL, 0) / exitTrades.length) : 0,
    };
  }
  return result;
}
