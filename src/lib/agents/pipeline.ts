// ═══════════════════════════════════════════════════════════════════════════
// Agent Pipeline — full integration: 30 agents → cross-confluence → Grok
// → engine → trade monitor → Telegram alerts
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentContext, AgentResearchOutput, CrossConfluenceOutput,
  GrokDecision, AgentId,
} from './agent-contract';
import { runAllAgents } from './registry-30';
import { analyzeCrossConfluence } from './cross-confluence';
import { deterministicDecision, getGrokBackstopFireCount } from './supervisor';
import { evaluateFeedGate, feedGateNoTrade, type FeedGateResult } from './feed-gate';
import { evaluatePlaybookCheck, playbookNoTrade, type PlaybookCheckResult } from './playbook-check';
import { runOptionEngine, type OptionEngineDecision } from './option-engine';
import { runCashFuturesEngine, type CashFuturesDecision } from './cash-futures-engine';
import {
  registerTradeForMonitoring, getMonitoredTrade,
  getActiveMonitoredTrades, getMonitorSummary,
} from './trade-monitor';
import { sendTPSLAlert, retryFailedAlerts, getGlobalDeliveryStats } from './telegram-alerts';
import { storeDecisionRecord, updateOutcome } from './learning-db';
import { validateCandidateTrade } from '../trade-validator-gate';
import { acquireTradeLock } from '../active-trade-lock';
import { isTradingHalted } from './kill-switch';
import { maybeRecordJevShadow } from '../jev/shadow';
import { sendTradeAlert } from '../telegram';
import { defaultApiBase } from './snapshot';
import { getCurrentSession, type MarketInstrument } from '../market-session';

// ─── Pipeline Observation (v2 §3 — dry-run visible decisions) ─────
// Complete, comparable record of ONE pipeline run: what Grok wanted, what
// the engine produced, which agents supported/opposed it, what data was
// missing, what the gates said, and how it compares with the existing
// production engine (SDM) when requested. Never fabricates — absent
// fields stay absent.

export interface PipelineObservation {
  symbol: string;
  timestamp: string;
  dryRun: boolean;
  finalAction: string;
  engine: 'OPTION' | 'CASH_FUTURES' | 'NONE';
  grokDirection: string;
  grokConsensus: string;
  consensusConfidence: number;
  engineReason: string;
  directionReason: string;
  strike?: number;
  optionSide?: 'CE' | 'PE';
  confidence: number;
  grade: string;
  supportingAgents: string[];
  rejectingAgents: string[];
  missingData: string[];
  feedGate: { blocked: boolean; reason?: string };
  playbook: { checked: boolean; pass: boolean; failedItems: number[] };
  validation?: { valid: boolean; reasons: string[] };
  noTradeReasons: string[];
  tradeRegistered: boolean;
  tradeId?: string;
  telegramAlert: boolean;
  blockedByMarketClosed?: boolean;
  existingEngine: null | {
    engine: 'SDM_SIGNAL';
    direction: string;
    confidence: number;
    agreement?: boolean;
  };
}

/** Entry-alert gate: ONLY a real, registered, non-dry-run trade may alert. */
export function resolveEntryAlert(params: {
  dryRun: boolean;
  tradeRegistered: boolean;
  action: string;
}): boolean {
  if (params.dryRun) return false;
  if (!params.tradeRegistered) return false;
  if (!params.action || params.action === 'NO_TRADE') return false;
  return true;
}

/** Registration gate — the ONE choke point that may create a trade. */
export function resolveRegistration(params: {
  dryRun: boolean;
  action: string;
  marketOpen: boolean;
  halted: boolean;
}): { register: boolean; reason?: 'dry-run' | 'no-trade' | 'kill-switch' | 'market-closed' } {
  if (params.dryRun) return { register: false, reason: 'dry-run' };
  if (!params.action || params.action === 'NO_TRADE') return { register: false, reason: 'no-trade' };
  if (params.halted) return { register: false, reason: 'kill-switch' };
  if (!params.marketOpen) return { register: false, reason: 'market-closed' };
  return { register: true };
}

const MCX_SYMBOLS = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'];
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

/**
 * Session clock for the registration gate. MCX hours are not modelled by
 * market-session → never blocked here (feed gate + freshness still guard).
 * On a session-clock failure behave like feed-gate: leave the door open so
 * the feed/freshness gates still guard (fail-open, consistent with feed-gate).
 */
export function isSessionOpenFor(symbol: string): boolean {
  if (MCX_SYMBOLS.includes(symbol)) return true;
  const instrument: MarketInstrument = INDEX_SYMBOLS.includes(symbol) ? 'index' : 'cash-stock';
  try {
    return getCurrentSession(instrument).isMarketOpen;
  } catch {
    return true;
  }
}

/** Best-effort read of the existing production engine (SDM signal) for comparison. */
async function fetchExistingEngineSignal(
  apiBase: string,
  symbol: string,
  timeoutMs = 30000
): Promise<PipelineObservation['existingEngine']> {
  try {
    const res = await fetch(
      `${apiBase}/api/sdm-signal?symbol=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const sig = json?.signal ?? json;
    const direction = sig?.direction != null ? String(sig.direction) : null;
    if (!direction) return null;
    const rawConf = sig?.confidence;
    const confidence = typeof rawConf === 'object' && rawConf !== null
      ? Number(rawConf?.total ?? 0)
      : Number(rawConf ?? 0);
    return {
      engine: 'SDM_SIGNAL',
      direction,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  } catch {
    return null;
  }
}

// ─── Pipeline Result ──────────────────────────────────────────────

export interface PipelineResult {
  symbol: string;
  timestamp: string;

  // Research phase
  agentOutputs: AgentResearchOutput[];
  crossConfluence: CrossConfluenceOutput;
  grokDecision: GrokDecision;

  // Playbook live-data gate — market-hours all_live check against
  // live-data-service (127.0.0.1:8765). blocked=true → NO_TRADE, no levels.
  feedGate: FeedGateResult;

  // Playbook 8-item pre-trade checklist — post-engine conjunction gate over
  // existing agent evidence (no re-scoring). pass=false → NO_TRADE.
  playbookCheck: PlaybookCheckResult;

  // Decision phase
  engineDecision: OptionEngineDecision | CashFuturesDecision;
  engine: 'OPTION' | 'CASH_FUTURES' | 'NONE';

  // Trade registration
  tradeRegistered: boolean;
  tradeId?: string;
  telegramAlert: boolean;
  /** v2 §10 — true when the kill switch blocked this registration attempt */
  blockedByKillSwitch?: boolean;
  /** true when the session clock blocked registration (market closed) */
  blockedByMarketClosed?: boolean;

  // Observation record (Phase 6) — complete decision for comparison,
  // recorded in dry-run too (no registration, no alerts).
  observation: PipelineObservation;
}

// ─── Full Pipeline Execution ──────────────────────────────────────

export async function runFullPipeline(
  symbol: string,
  ctx: AgentContext,
  options?: {
    agentIds?: AgentId[];
    dryRun?: boolean;
    /** Phase 7 — also record the existing production engine's signal for comparison */
    compare?: boolean;
    apiBase?: string;
    /** test seam — production uses the real sendTradeAlert */
    deps?: {
      sendTradeAlert?: typeof sendTradeAlert;
    };
  }
): Promise<PipelineResult> {
  const timestamp = new Date().toISOString();
  const dryRun = options?.dryRun ?? false;

  // Phase 7 — kick the existing-engine comparison off in parallel (best-effort;
  // unreachable → null, never blocks or alters the decision).
  const existingEngineP: Promise<PipelineObservation['existingEngine']> = options?.compare
    ? fetchExistingEngineSignal(options.apiBase ?? defaultApiBase(), symbol)
    : Promise.resolve(null);

  // PHASE 1: Run all 30 agents
  console.log(`[Pipeline] Running agents for ${symbol}...`);
  const agentOutputs = await runAllAgents(ctx, options?.agentIds);

  // PHASE 2: Cross-confluence analysis
  console.log(`[Pipeline] Cross-confluence for ${symbol}...`);
  const crossConfluence = analyzeCrossConfluence(symbol, agentOutputs);

  // PHASE 3: Deterministic decision layer (30 agents → cross-confluence math)
  console.log(`[Pipeline] Deterministic decision for ${symbol}...`);
  const decision = deterministicDecision(symbol, agentOutputs, crossConfluence);

  // Jev shadow comparison — fire-and-forget; never mutates the decision
  try {
    maybeRecordJevShadow({
      source: 'AGENT_PIPELINE',
      symbol,
      productionDecision: decision.direction,
      grokDirection: decision.direction,
      agentOutputs,
      crossConfluence,
    });
  } catch {
    /* shadow must never break pipeline */
  }

  // PHASE 3.5: Playbook live-data gate — during market hours the engines
  // only run when live-data-service reports all_live=true (fresh spot/VIX +
  // every chain). Blocked → honest NO_TRADE, no levels produced.
  const feedGate = await evaluateFeedGate();
  if (feedGate.blocked) {
    console.warn(`[Pipeline] Feed gate BLOCKED for ${symbol}: ${feedGate.reason}`);
  }

  // PHASE 4: Engine routing
  let engineDecision: OptionEngineDecision | CashFuturesDecision;
  let engine: 'OPTION' | 'CASH_FUTURES' | 'NONE' = 'NONE';

  if (feedGate.blocked) {
    engineDecision = feedGateNoTrade(feedGate) as OptionEngineDecision | CashFuturesDecision;
  } else if (decision.selectedEngine === 'OPTION') {
    engineDecision = await runOptionEngine(symbol, decision, agentOutputs, ctx);
    engine = 'OPTION';
  } else if (decision.selectedEngine === 'CASH_FUTURES') {
    engineDecision = await runCashFuturesEngine(symbol, decision, agentOutputs, ctx);
    engine = 'CASH_FUTURES';
  } else {
    engineDecision = {
      action: 'NO_TRADE',
      reasons: ['Grok did not route to any engine'],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // PHASE 4.5: Playbook 8-item checklist — conjunction gate over existing
  // agent evidence + the engine candidate. Any "no" → NO_TRADE (playbook:
  // any no = skip). Research outputs are never gated; only trade levels.
  const playbookCheck = evaluatePlaybookCheck(
    (engineDecision as { candidate?: any }).candidate,
    agentOutputs,
    { participantOI: ctx.participantOI },
  );
  if (playbookCheck.checked && !playbookCheck.pass) {
    console.warn(`[Pipeline] Playbook checklist FAILED for ${symbol}: items ${playbookCheck.failedItems.join(', ')}`);
    engineDecision = playbookNoTrade(playbookCheck) as OptionEngineDecision | CashFuturesDecision;
  }

  // Second shadow sample: final engine action (still non-blocking)
  try {
    maybeRecordJevShadow({
      source: 'AGENT_PIPELINE',
      symbol,
      productionDecision: engineDecision.action,
      grokDirection: decision.direction,
      agentOutputs,
      crossConfluence,
    });
  } catch {
    /* ignore */
  }

  // PHASE 5: Trade registration — single choke point (dry-run / no-trade /
  // kill switch / session clock / canonical validator / active lock).
  let tradeRegistered = false;
  let tradeId: string | undefined;
  let telegramAlert = false;
  let blockedByKillSwitch = false;
  let blockedByMarketClosed = false;
  let registrationValidation: { valid: boolean; reasons: string[] } | undefined;

  const registration = resolveRegistration({
    dryRun,
    action: engineDecision.action,
    marketOpen: isSessionOpenFor(symbol),
    halted: isTradingHalted(),
  });

  if (registration.reason === 'kill-switch') {
    // v2 §10 — kill switch blocks NEW registrations; monitoring of
    // existing trades (and their TP/SL alerts) is never gated.
    blockedByKillSwitch = true;
    console.warn(`[KillSwitch] registration blocked for ${symbol} (engine action ${engineDecision.action})`);
  } else if (registration.reason === 'market-closed') {
    blockedByMarketClosed = true;
    console.log(`[Pipeline] registration blocked for ${symbol} — market closed`);
  } else if (registration.register && (engineDecision as any).candidate) {
      const candidate = (engineDecision as any).candidate;
      // Validate through canonical validator
      const validation = validateCandidateTrade(candidate);
      registrationValidation = { valid: validation.valid, reasons: validation.reasons };
      if (validation.valid) {
        // Acquire trade lock
        const lock = await acquireTradeLock({
          tradeId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          strategy: 'AGENT_SYSTEM',
          underlying: symbol,
          exchange: candidate.exchange || 'NSE',
          optionType: candidate.optionType || 'EQ',
          strike: candidate.strike || 0,
          expiry: candidate.expiry || '',
          entry: candidate.entry,
          stopLoss: candidate.stopLoss,
          target1: candidate.tp1 || candidate.target1,
          target2: candidate.tp2 || candidate.target2,
        });

        if ('tradeId' in lock) {
          tradeId = lock.tradeId;
          tradeRegistered = true;

          // Register in the PRODUCTION tracker (activeTradeTracker) so the
          // TIGER poll loop sees this trade and can detect TP/SL + alert.
          // addTrade reuses the already-acquired lock via skip? It acquires
          // again — blocked. So seed memory directly through addTrade's
          // sibling path: we already hold the lock, push via addTrade is
          // wrong. Use addTradeOnly-style registration:
          try {
            const { addTrade } = await import('../activeTradeTracker');
            // Lock already held by acquireTradeLock above with same tradeId —
            // release first so addTrade can re-acquire cleanly.
            const { releaseTradeLock } = await import('../active-trade-lock');
            releaseTradeLock(symbol, candidate.exchange || 'NSE');
            await addTrade({
              id: tradeId,
              symbol,
              side: candidate.direction?.includes('SELL') ? 'SELL' : 'BUY',
              instrument: candidate.instrument || 'EQUITY',
              strike: candidate.strike || 0,
              optionType: candidate.optionType || '',
              entry: candidate.entry,
              sl: candidate.stopLoss,
              tp1: candidate.tp1 || candidate.target1,
              tp2: candidate.tp2 || candidate.target2,
              tp3: candidate.tp3,
              status: 'ACTIVE',
              sentAt: timestamp,
              source: 'AGENT_SYSTEM',
              exchange: candidate.exchange || 'NSE',
              confidence: decision.consensusConfidence,
            }, true); // skipAlert — pipeline handles Telegram separately
          } catch (err: any) {
            console.warn(`[Pipeline] activeTradeTracker addTrade failed: ${err.message}`);
          }

          // Register for Hermes diagnostics monitoring state
          registerTradeForMonitoring({
            tradeId,
            symbol,
            exchange: candidate.exchange || 'NSE',
            instrument: candidate.instrument || 'EQUITY',
            side: candidate.direction?.includes('SELL') ? 'SELL' : 'BUY',
            strike: candidate.strike,
            entry: candidate.entry,
            stopLoss: candidate.stopLoss,
            tp1: candidate.tp1 || candidate.target1,
            tp2: candidate.tp2 || candidate.target2,
            tp3: candidate.tp3,
            quantity: candidate.quantity,
          });

          // Store decision record for learning
          await storeDecisionRecord({
            id: tradeId,
            symbol,
            timestamp,
            agentsUsed: agentOutputs.map(o => o.agentId),
            agentOutputs,
            crossConfluence,
            grokDecision: decision,
            direction: engineDecision.action,
            optionSide: candidate.optionType,
            strike: candidate.strike,
            entry: candidate.entry,
            stopLoss: candidate.stopLoss,
            tp1: candidate.tp1 || candidate.target1,
            tp2: candidate.tp2 || candidate.target2,
            confidence: decision.consensusConfidence,
            grade: (engineDecision as any).grade || 'C',
            regime: decision.marketRegime,
            vix: ctx.vix,
            pcr: ctx.optionChain?.pcr || 0,
            fiiNet: ctx.fiiNet,
            diiNet: ctx.diiNet,
          });

          console.log(`[Pipeline] Trade registered: ${tradeId} for ${symbol}`);
        } else {
          console.log(`[Pipeline] Trade blocked: active trade on ${symbol}`);
        }
      } else {
        console.log(`[Pipeline] Trade validation failed: ${validation.reasons.join(', ')}`);
      }
  }

  // PHASE 5b: Entry alert — ONLY an approved, validated, registered,
  // non-dry-run trade may reach Telegram (full-day dedup + send window
  // still enforced inside sendTradeAlert).
  if (resolveEntryAlert({ dryRun, tradeRegistered, action: engineDecision.action })) {
    const c = (engineDecision as any).candidate || {};
    try {
      const send = options?.deps?.sendTradeAlert ?? sendTradeAlert;
      telegramAlert = await send({
        symbol,
        action: engineDecision.action,
        strike: Number(c.strike) || 0,
        type: c.optionType || (c.instrument === 'EQUITY' ? 'EQ' : c.instrument) || 'OPTION',
        confidence: decision.consensusConfidence,
        entry: c.entry,
        stopLoss: c.stopLoss,
        target1: c.target1,
        target2: c.target2,
        source: 'Grok Supervisor',
        instrument: c.instrument,
      });
      console.log(`[Pipeline] Entry alert ${telegramAlert ? 'sent' : 'not sent'} for ${symbol}`);
    } catch (err: any) {
      console.warn(`[Pipeline] entry alert failed for ${symbol}: ${err.message}`);
      telegramAlert = false;
    }
  }

  // PHASE 6: Observation record — complete decision, dry-run included.
  const candidate = (engineDecision as any).candidate;
  const directionSide = /PE|SELL|SHORT/.test(engineDecision.action) ? 'BEARISH' : 'BULLISH';
  const supportingAgents = agentOutputs
    .filter(o => o.bias === directionSide && o.confidence > 0)
    .map(o => o.agentId);
  const rejectingAgents = agentOutputs
    .filter(o => o.confidence > 0 && (o.bias === 'BULLISH' || o.bias === 'BEARISH') && o.bias !== directionSide)
    .map(o => o.agentId);
  const missingData = agentOutputs
    .filter(o => o.dataFreshness === 'MISSING' || o.dataFreshness === 'ERROR')
    .map(o => o.agentId);
  const existingEngine = await existingEngineP;
  let agreement: boolean | undefined;
  if (existingEngine) {
    const d = existingEngine.direction.toUpperCase();
    const optionDir = d === 'CALL' || d === 'PUT' || d === 'BUY_CE' || d === 'BUY_PE';
    if (engineDecision.action === 'BUY_CE') agreement = d === 'CALL' || d === 'BUY_CE';
    else if (engineDecision.action === 'BUY_PE') agreement = d === 'PUT' || d === 'BUY_PE';
    else if (engineDecision.action === 'NO_TRADE') agreement = !optionDir;
    // equity BUY/SELL is not comparable to an index-option signal → absent
  }

  const observation: PipelineObservation = {
    symbol,
    timestamp,
    dryRun,
    finalAction: engineDecision.action,
    engine,
    grokDirection: decision.direction,
    grokConsensus: decision.consensus,
    consensusConfidence: decision.consensusConfidence,
    engineReason: decision.engineReason,
    directionReason: decision.directionReason,
    ...(candidate?.strike ? { strike: candidate.strike } : {}),
    ...(candidate?.optionType ? { optionSide: candidate.optionType } : {}),
    confidence: (engineDecision as any).confidence ?? decision.consensusConfidence,
    grade: (engineDecision as any).grade || 'F',
    supportingAgents,
    rejectingAgents,
    missingData,
    feedGate: { blocked: feedGate.blocked, ...(feedGate.reason ? { reason: feedGate.reason } : {}) },
    playbook: {
      checked: playbookCheck.checked,
      pass: playbookCheck.pass,
      failedItems: playbookCheck.failedItems,
    },
    ...(registrationValidation ? { validation: registrationValidation } : {}),
    noTradeReasons: engineDecision.action === 'NO_TRADE' ? engineDecision.reasons : [],
    tradeRegistered,
    ...(tradeId ? { tradeId } : {}),
    telegramAlert,
    ...(blockedByMarketClosed ? { blockedByMarketClosed: true } : {}),
    existingEngine: existingEngine
      ? { ...existingEngine, ...(agreement !== undefined ? { agreement } : {}) }
      : null,
  };

  // Persist the full decision for comparison (dry-run included; registered
  // trades already store their record above under the trade id).
  if (!tradeRegistered) {
    try {
      await storeDecisionRecord({
        id: `obs-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        timestamp,
        agentsUsed: agentOutputs.map(o => o.agentId),
        agentOutputs,
        crossConfluence,
        grokDecision: decision,
        direction: engineDecision.action,
        optionSide: candidate?.optionType,
        strike: candidate?.strike,
        entry: candidate?.entry ?? 0,
        stopLoss: candidate?.stopLoss ?? 0,
        tp1: candidate?.target1 ?? 0,
        tp2: candidate?.target2 ?? 0,
        confidence: decision.consensusConfidence,
        grade: observation.grade,
        regime: decision.marketRegime,
        vix: ctx.vix,
        pcr: ctx.optionChain?.pcr || 0,
        fiiNet: ctx.fiiNet,
        diiNet: ctx.diiNet,
      });
    } catch (err: any) {
      console.warn(`[Pipeline] observation record failed: ${err.message}`);
    }
  }

  console.log(`[PipelineObservation] ${JSON.stringify({
    symbol,
    timestamp,
    dryRun,
    finalAction: observation.finalAction,
    engine: observation.engine,
    grokDirection: observation.grokDirection,
    grokConsensus: observation.grokConsensus,
    confidence: observation.confidence,
    strike: observation.strike,
    supportingAgents: observation.supportingAgents,
    rejectingAgents: observation.rejectingAgents,
    missingDataCount: observation.missingData.length,
    feedGateBlocked: observation.feedGate.blocked,
    playbookPassed: observation.playbook.pass,
    validation: observation.validation,
    noTradeReasons: observation.noTradeReasons,
    tradeRegistered: observation.tradeRegistered,
    telegramAlert: observation.telegramAlert,
    existingEngine: observation.existingEngine,
  })}`);

  return {
    symbol,
    timestamp,
    agentOutputs,
    crossConfluence,
    grokDecision: decision,
    feedGate,
    playbookCheck,
    engineDecision,
    engine,
    tradeRegistered,
    tradeId,
    telegramAlert,
    ...(blockedByKillSwitch ? { blockedByKillSwitch: true } : {}),
    ...(blockedByMarketClosed ? { blockedByMarketClosed: true } : {}),
    observation,
  };
}

// ─── Monitor All Active Trades (retry + diagnostics) ─────────────
// TP/SL DETECTION runs in tiger-monitor.pollTradesOnce (the production
// loop with live LTP). This function only retries failed Telegram
// deliveries and reports status — it must NOT re-detect on stale LTP.

export async function monitorAllTrades(): Promise<{
  alertsGenerated: number;
  alertsSent: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let alertsSent = 0;

  // Retry any TP/SL alerts that failed Telegram delivery
  try {
    const retried = await retryFailedAlerts();
    alertsSent += retried.sent;
    if (retried.failed > 0) {
      errors.push(`${retried.failed} alerts still failing after retry`);
    }
  } catch (err: any) {
    errors.push(`Retry failed: ${err.message}`);
  }

  return { alertsGenerated: 0, alertsSent, errors };
}

// ─── Get System Status ────────────────────────────────────────────

export function getSystemStatus(): {
  monitor: ReturnType<typeof getMonitorSummary>;
  activeTrades: Array<{ tradeId: string; symbol: string; status: string; pnl: number }>;
  telegramDelivery: ReturnType<typeof getGlobalDeliveryStats>;
  grokBackstopFires: number;
  killSwitchHalted: boolean;
} {
  return {
    monitor: getMonitorSummary(),
    activeTrades: getActiveMonitoredTrades().map(t => ({
      tradeId: t.tradeId,
      symbol: t.symbol,
      status: t.status,
      pnl: t.pnl,
    })),
    telegramDelivery: getGlobalDeliveryStats(),
    grokBackstopFires: getGrokBackstopFireCount(),
    killSwitchHalted: isTradingHalted(),
  };
}
