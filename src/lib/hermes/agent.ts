// Hermes Agent — main orchestrator
// Replaces the monolithic agent-brain.ts loop with structured pipeline.

import type {
  HermesContext, HermesDecision, TradeCandidate, Direction, OptionSide, Decision, HermesMode
} from "./types";
import { detectIntent, detectSymbol, detectDirection, createExecutionPlan } from "./task-router";
import { collectHermesContext } from "./context";
import { interpretRegime } from "./regime-engine";
import { analyzeOIIntelligence } from "./oi-intel";
import { analyzeGammaIntelligence } from "./gamma-intel";
import { analyzeFlowIntelligence } from "./flow-intel";
import { getTradeGrade } from "./scoring-engine";
import { selectOptimalStrikes, compareCEvsPE, getBestStrike } from "./strike-selector";
import { validateTrade, isTradeValid } from "./trade-validator";
import { evaluateNoTrade, shouldRejectTrade } from "./no-trade-engine";
import { generateExplanation } from "./explainer";
import { formatHermesDecision } from "./response";
import { runQualityGates, shouldBlockTrade } from "@/lib/data-validation";
import { scoreWithUnifiedEngine } from "./unified-scoring-bridge";
import { detectAndResolveConflicts, type EngineSignal } from "@/lib/signal-conflict-detector";
import { registerAgent, getAgentByName, createSignal, emitEvent } from "@/lib/agents/registry";
import { transitionSignal } from "@/lib/agents/signal-lifecycle";
import { maybeRecordJevShadow } from "@/lib/jev/shadow";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_EXECUTION_TIME_MS = 30_000;

// ── Jev shadow (never alters HermesDecision) ───────────────────────────

function recordJevShadowForHermes(
  decision: HermesDecision,
  ctx: HermesContext
): HermesDecision {
  try {
    maybeRecordJevShadow(
      {
        source: "HERMES",
        symbol: ctx.symbol,
        productionDecision: decision.decision,
        hermesDecision: {
          decision: decision.decision,
          score: decision.score,
          grade: decision.grade,
          confidence: decision.confidence,
          marketRegime: decision.marketRegime,
          dataHealth: decision.dataHealth,
          timestamp: decision.timestamp,
        },
      },
      ctx
    );
  } catch {
    // Shadow must never break Hermes
  }
  return decision;
}

// ── Main Orchestrator ──────────────────────────────────────────────────

export async function hermesPro(
  message: string,
  options: {
    symbol?: string;
    spotPrice?: number;
    apiBase?: string;
    /** Force pipeline mode (e.g. paper trader forces TRADE). Overrides detectIntent. */
    mode?: HermesMode;
    /** Force intent (e.g. LIVE_TRADE). Overrides detectIntent. */
    intent?: string;
  } = {}
): Promise<HermesDecision> {
  const startTime = Date.now();

  // 1. Detect intent and symbol (caller may override mode/intent)
  const detectedIntent = detectIntent(message);
  const intent = options.intent || detectedIntent.intent;
  const mode = options.mode || detectedIntent.mode;
  const detected = options.symbol
    ? { symbol: options.symbol, exchange: "NSE", instrument: "index" }
    : detectSymbol(message);
  const direction = detectDirection(message);

  // 2. Collect market data
  const ctx = await collectHermesContext(detected.symbol, mode, options.apiBase || "");

  // 3. Check market status first (NSE holiday = exchange closed, research only;
  // MCX has its own calendar so only NSE-scoped statuses block)
  if (
    ctx.marketStatus === "WEEKEND" ||
    (ctx.marketStatus === "HOLIDAY" && ctx.exchange === "NSE") ||
    (ctx.marketStatus === "MARKET_CLOSED" && ctx.exchange === "NSE")
  ) {
    return recordJevShadowForHermes(buildDecision({
      decision: "RESEARCH_ONLY",
      explanation: `Market is ${ctx.marketStatus === "WEEKEND" ? "closed (weekend)" : "closed"}. Research analysis only.`,
      ctx,
      startTime,
      toolsCalled: ["collectHermesContext"],
    }), ctx);
  }

  // 4. Run intelligence layers
  const regime = interpretRegime(ctx);
  const oi = analyzeOIIntelligence(ctx);
  const gamma = analyzeGammaIntelligence(ctx);
  const flow = analyzeFlowIntelligence(ctx);

  // 5. Determine direction from context if not provided
  let effectiveDirection: Direction = regime.bias;

  // 6. If TRADE mode, run full pipeline
  if (mode === "TRADE" || intent === "LIVE_TRADE" || intent === "ZERO_HERO") {
    return recordJevShadowForHermes(
      await executeTradePipeline(ctx, effectiveDirection, startTime),
      ctx
    );
  }

  // 7. For RESEARCH/QUICK modes, provide analysis
  return recordJevShadowForHermes(
    buildAnalysisDecision(ctx, effectiveDirection, regime, oi, gamma, flow, startTime),
    ctx
  );
}

// ── Trade Pipeline ─────────────────────────────────────────────────────

async function executeTradePipeline(
  ctx: HermesContext,
  initialDirection: Direction,
  startTime: number
): Promise<HermesDecision> {
  const toolsCalled = ["collectHermesContext", "interpretRegime", "analyzeOI", "analyzeGamma", "analyzeFlow"];

  // Check no-trade conditions first
  const noTradeReasons = evaluateNoTrade(ctx);
  if (shouldRejectTrade(noTradeReasons)) {
    const critical = noTradeReasons.filter(r => r.severity === "CRITICAL");
    return buildDecision({
      decision: "NO_TRADE",
      explanation: `Trade blocked: ${critical.map(r => r.reason).join("; ")}`,
      ctx,
      startTime,
      toolsCalled,
    });
  }

  // Run quality gates — block trade if data is too poor
  const chain = ctx.optionChain.value;
  const spot = chain?.spot || ctx.spot.value?.price || 0;
  const vix = ctx.indiaVix?.value?.value || 15;
  const qualityGates = runQualityGates(chain as any, spot, vix, chain?.source || 'unknown');
  const gateResult = shouldBlockTrade(qualityGates);
  if (gateResult.block) {
    return buildDecision({
      decision: "NO_TRADE",
      explanation: `Data quality gates failed: ${gateResult.reasons.join("; ")}`,
      ctx,
      startTime,
      toolsCalled: [...toolsCalled, "qualityGates"],
    });
  }

  // Compare CE vs PE — score BOTH sides using unified engine
  const ceResult = scoreWithUnifiedEngine(ctx, "BULLISH", "CE");
  const peResult = scoreWithUnifiedEngine(ctx, "BEARISH", "PE");

  // Run conflict detector BEFORE choosing direction
  const regime = interpretRegime(ctx);
  const trend = regime.bias === "BULLISH" ? "bullish" as const
    : regime.bias === "BEARISH" ? "bearish" as const
    : "neutral" as const;

  const ceSignal: EngineSignal = {
    source: "unified-HERMES-CE",
    direction: ceResult.decision.decision === "TRADE" ? "CE" : "NO_TRADE",
    confidence: ceResult.decision.score,
    score: ceResult.decision.score,
  };
  const peSignal: EngineSignal = {
    source: "unified-HERMES-PE",
    direction: peResult.decision.decision === "TRADE" ? "PE" : "NO_TRADE",
    confidence: peResult.decision.score,
    score: peResult.decision.score,
  };

  const conflictResult = detectAndResolveConflicts(
    [ceSignal, peSignal],
    chain as any,
    trend
  );

  // If conflict detector says WAIT, honour it
  if (conflictResult.resolvedDirection === "WAIT" || conflictResult.resolvedDirection === "NO_TRADE") {
    return buildDecision({
      decision: "NO_TRADE",
      explanation: `Conflict detected: ${conflictResult.reasons.join("; ")}`,
      ctx,
      startTime,
      toolsCalled: [...toolsCalled, "unifiedScoring", "conflictDetector"],
    });
  }

  // Determine preferred side from conflict resolution
  const preferredFromConflict = conflictResult.resolvedDirection;
  const side: OptionSide = preferredFromConflict === "CE" ? "CE" : "PE";
  const direction: Direction = side === "CE" ? "BULLISH" : "BEARISH";
  const unifiedResult = side === "CE" ? ceResult : peResult;
  const score = unifiedResult.decision;

  // Check minimum score — unified engine uses grade system
  if (score.decision !== "TRADE") {
    return buildDecision({
      decision: "NO_TRADE",
      explanation: `Score ${score.score}/100 (Grade ${score.grade}) — ${score.decision}. ${score.reasons.join("; ")}`,
      ctx,
      startTime,
      toolsCalled: [...toolsCalled, "unifiedScoring", "conflictDetector"],
    });
  }

  // Select best strike for preferred side
  const bestStrike = side === "CE" ? getBestStrike(ctx, "BULLISH", "CE") : getBestStrike(ctx, "BEARISH", "PE");

  if (!bestStrike) {
    return buildDecision({
      decision: "NO_TRADE",
      explanation: "No valid strike found with acceptable parameters",
      ctx,
      startTime,
      toolsCalled: [...toolsCalled, "unifiedScoring", "conflictDetector"],
    });
  }

  // Build trade candidate using unified scoring result
  const entry = bestStrike.premium;
  const sl = calculateStopLoss(bestStrike, direction, ctx);
  const { tp1, tp2, tp3 } = calculateTargets(bestStrike, direction, ctx);
  const rr = entry > 0 && sl > 0 ? (tp1 - entry) / (entry - sl) : 0;

  const candidate: TradeCandidate = {
    symbol: ctx.symbol,
    exchange: ctx.exchange,
    instrument: ctx.instrument,
    direction,
    optionSide: side,
    strike: bestStrike.strike,
    position: bestStrike.position,
    expiry: chain?.expiry || "",
    entry,
    entryRange: { min: entry * 0.98, max: entry * 1.02 },
    stopLoss: sl,
    tp1,
    tp2,
    tp3,
    riskReward: rr,
    quantity: 1,
    lotSize: 65,
    riskAmount: (entry - sl) * 65,
    score: score.score,
    grade: score.grade,
    confidence: score.score,
    reasons: score.scoreBreakdown.filter(b => b.available && b.score >= 60).map(b => b.reason),
    risks: score.scoreBreakdown.filter(b => b.available && b.score < 40).map(b => b.reason),
    invalidation: [`If spot moves against ${direction === "BULLISH" ? "below" : "above"} ${direction === "BULLISH" ? "support" : "resistance"}`],
    dataSources: [ctx.spot.source, ctx.optionChain.source],
    timestamp: new Date().toISOString(),
  };

  // Validate the candidate
  const validationResults = validateTrade(ctx, candidate);
  const validation = isTradeValid(validationResults);

  if (!validation.valid) {
    return buildDecision({
      decision: "NO_TRADE",
      explanation: `Validation failed: ${validation.failures.join("; ")}`,
      candidate,
      ctx,
      startTime,
      toolsCalled: [...toolsCalled, "unifiedScoring", "conflictDetector", "validation"],
    });
  }

  // Build decision
  const decision: Decision = side === "CE" ? "BUY_CE" : "BUY_PE";
  const explanation = generateExplanation(candidate, { total: score.score, grade: score.grade, breakdown: score.scoreBreakdown } as any, ctx);

  // ── Agent Signal Lifecycle ──────────────────────────────────────────
  try {
    let hermesAgent = getAgentByName('HERMES');
    if (!hermesAgent) {
      hermesAgent = registerAgent({
        name: 'HERMES',
        type: 'HERMES',
        version: '2.0',
        description: 'Hermes Pro AI Trading Agent',
      });
    }

    const optionType = side === "CE" ? "CE" : "PE";
    const entryPrice = candidate.premium || 0;
    const stopLoss = calculateStopLoss(candidate, candidate.direction, ctx);
    const targets = calculateTargets(candidate, candidate.direction, ctx);

    const signal = createSignal({
      agentId: hermesAgent.id,
      market: 'INDIA',
      exchange: 'NFO',
      underlying: ctx.symbol,
      signalType: 'CANDIDATE',
      direction: decision,
      optionType,
      strike: candidate.strike,
      expiry: candidate.expiry,
      entryPrice,
      stopLoss,
      target1: targets.tp1,
      target2: targets.tp2,
      confidence: score,
      thesis: explanation,
      evidence: {
        priceStructure: ctx.marketStructure.value?.trend || null,
        volume: ctx.optionChain.value ? `PCR: ${ctx.optionChain.value.pcrOI.toFixed(2)}` : null,
        callOI: ctx.optionChain.value ? `Max Pain: ₹${ctx.optionChain.value.maxPain}` : null,
        vix: ctx.vix.value?.toFixed(1) || null,
      },
      dataSource: ctx.spot.source || 'UNKNOWN',
      dataFreshness: ctx.spot.freshness || 'UNKNOWN',
    });

    // Transition through lifecycle
    transitionSignal(signal.id, 'CANDIDATE');
    transitionSignal(signal.id, 'VALIDATING');
    transitionSignal(signal.id, 'VALIDATED');
    transitionSignal(signal.id, 'FINAL');

    emitEvent('SIGNAL_CREATED', hermesAgent.id, {
      signalId: signal.id,
      direction: decision,
      underlying: ctx.symbol,
      strike: candidate.strike,
      confidence: score,
    });
  } catch (err) {
    // Non-critical — don't fail the trade pipeline
    console.error('[Hermes] Signal lifecycle error:', err);
  }

  return buildDecision({
    decision,
    candidate,
    explanation,
    ctx,
    startTime,
    toolsCalled: [...toolsCalled, "unifiedScoring", "conflictDetector", "validation"],
    validation,
    scoringProvenance: {
      scoringEngine: "unified",
      strategyProfile: "HERMES",
      profileVersion: "2.0",
      weightsUsed: unifiedResult.weightsUsed,
      ceScore: ceResult.decision.score,
      peScore: peResult.decision.score,
      conflictStatus: conflictResult.hasConflict ? "CONFLICT_RESOLVED" : "NO_CONFLICT",
    },
  });
}

// ── Analysis Decision ──────────────────────────────────────────────────

function buildAnalysisDecision(
  ctx: HermesContext,
  direction: Direction,
  regime: any,
  oi: any,
  gamma: any,
  flow: any,
  startTime: number
): HermesDecision {
  const spot = ctx.spot.value?.price || 0;
  const chain = ctx.optionChain.value;
  const parts: string[] = [];

  parts.push(`${ctx.symbol}: ₹${spot.toLocaleString("en-IN")}`);
  parts.push(`Regime: ${regime.regime} (${regime.bias})`);
  parts.push(`OI: ${oi.oiBias}`);
  parts.push(`Gamma: ${gamma.gammaRegime}`);
  parts.push(`Flow: ${flow.combinedBias}`);
  parts.push(`VIX: ${ctx.vix.value?.toFixed(1) || "N/A"}`);

  if (chain) {
    parts.push(`PCR: ${chain.pcrOI.toFixed(2)}`);
    parts.push(`Max Pain: ₹${chain.maxPain.toLocaleString("en-IN")}`);
  }

  return buildDecision({
    decision: "RESEARCH_ONLY",
    explanation: parts.join("\n"),
    ctx,
    startTime,
    toolsCalled: ["collectHermesContext", "interpretRegime", "analyzeOI", "analyzeGamma", "analyzeFlow"],
  });
}

// ── Helper Functions ───────────────────────────────────────────────────

function calculateStopLoss(strike: any, direction: Direction, ctx: HermesContext): number {
  const premium = strike.premium;
  if (direction === "BULLISH") {
    return Math.max(premium * 0.5, premium - 20);
  } else {
    return Math.max(premium * 0.5, premium - 20);
  }
}

function calculateTargets(strike: any, direction: Direction, ctx: HermesContext): { tp1: number; tp2: number; tp3: number } {
  const premium = strike.premium;
  return {
    tp1: premium * 1.5,
    tp2: premium * 2.0,
    tp3: premium * 3.0,
  };
}

interface BuildDecisionInput {
  decision: Decision;
  candidate?: TradeCandidate;
  explanation: string;
  ctx: HermesContext;
  startTime: number;
  toolsCalled: string[];
  validation?: { passed: boolean; failures: string[]; warnings: string[] };
  scoringProvenance?: {
    scoringEngine: string;
    strategyProfile: string;
    profileVersion: string;
    weightsUsed: Record<string, number>;
    ceScore: number;
    peScore: number;
    conflictStatus: string;
  };
}

function buildDecision(input: BuildDecisionInput): HermesDecision {
  const regime = interpretRegime(input.ctx);
  const score = input.candidate?.score || 0;
  const grade = getTradeGrade(score);
  const executionTimeMs = Date.now() - input.startTime;

  const dataHealth = calculateDataHealth(input.ctx);

  return {
    decision: input.decision,
    candidate: input.candidate,
    explanation: input.explanation,
    evidence: input.candidate ? buildEvidence(input.ctx, input.candidate) : [],
    risks: input.candidate?.risks || [],
    score,
    grade,
    confidence: score,
    marketRegime: regime.regime,
    dataHealth,
    toolsCalled: input.toolsCalled,
    executionTimeMs,
    dataQuality: {
      status: input.ctx.spot.freshness,
      provider: input.ctx.spot.source,
      ageMs: input.ctx.spot.ageMs,
      freshness: input.ctx.spot.freshness,
    },
    validation: input.validation || { passed: true, failures: [], warnings: [] },
    scoringProvenance: input.scoringProvenance,
    timestamp: new Date().toISOString(),
  };
}

function calculateDataHealth(ctx: HermesContext): number {
  let health = 100;
  if (ctx.spot.freshness === "STALE") health -= 30;
  if (ctx.spot.freshness === "UNAVAILABLE") health -= 50;
  if (ctx.optionChain.freshness === "STALE") health -= 20;
  if (ctx.optionChain.freshness === "UNAVAILABLE") health -= 30;
  if (ctx.spot.delayed) health -= 20;
  if (ctx.optionChain.delayed) health -= 15;
  return Math.max(0, health);
}

function buildEvidence(ctx: HermesContext, candidate: TradeCandidate): any[] {
  const evidence = [];
  const structure = ctx.marketStructure.value;
  if (structure) {
    evidence.push({
      factor: "Structure",
      score: structure.trend === (candidate.direction === "BULLISH" ? "UP" : "DOWN") ? 80 : 30,
      weight: 20,
      evidence: `Trend: ${structure.trend}`,
      direction: candidate.direction,
    });
  }
  return evidence;
}

// ── Formatted Response ─────────────────────────────────────────────────

export async function hermesProFormatted(
  message: string,
  options: { symbol?: string; spotPrice?: number; apiBase?: string; mode?: HermesMode; intent?: string } = {}
): Promise<string> {
  const decision = await hermesPro(message, options);
  return formatHermesDecision(decision);
}
