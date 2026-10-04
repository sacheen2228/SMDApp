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
import { runGrokSupervisor, getGrokBackstopFireCount } from './supervisor';
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
}

// ─── Full Pipeline Execution ──────────────────────────────────────

export async function runFullPipeline(
  symbol: string,
  ctx: AgentContext,
  options?: {
    agentIds?: AgentId[];
    dryRun?: boolean;
  }
): Promise<PipelineResult> {
  const timestamp = new Date().toISOString();
  const dryRun = options?.dryRun ?? false;

  // PHASE 1: Run all 30 agents
  console.log(`[Pipeline] Running agents for ${symbol}...`);
  const agentOutputs = await runAllAgents(ctx, options?.agentIds);

  // PHASE 2: Cross-confluence analysis
  console.log(`[Pipeline] Cross-confluence for ${symbol}...`);
  const crossConfluence = analyzeCrossConfluence(symbol, agentOutputs);

  // PHASE 3: Grok supervisor
  console.log(`[Pipeline] Grok supervisor for ${symbol}...`);
  const grokDecision = runGrokSupervisor(symbol, agentOutputs, crossConfluence);

  // Jev shadow comparison — fire-and-forget; never mutates grokDecision
  try {
    maybeRecordJevShadow({
      source: 'AGENT_PIPELINE',
      symbol,
      productionDecision: grokDecision.direction,
      grokDirection: grokDecision.direction,
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
  } else if (grokDecision.selectedEngine === 'OPTION') {
    engineDecision = await runOptionEngine(symbol, grokDecision, agentOutputs);
    engine = 'OPTION';
  } else if (grokDecision.selectedEngine === 'CASH_FUTURES') {
    engineDecision = await runCashFuturesEngine(symbol, grokDecision, agentOutputs);
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
      grokDirection: grokDecision.direction,
      agentOutputs,
      crossConfluence,
    });
  } catch {
    /* ignore */
  }

  // PHASE 5: Trade registration (if not dry run and action is trade)
  let tradeRegistered = false;
  let tradeId: string | undefined;
  let telegramAlert = false;
  let blockedByKillSwitch = false;

  if (!dryRun && engineDecision.action !== 'NO_TRADE') {
    if (isTradingHalted()) {
      // v2 §10 — kill switch blocks NEW registrations; monitoring of
      // existing trades (and their TP/SL alerts) is never gated.
      blockedByKillSwitch = true;
      console.warn(`[KillSwitch] registration blocked for ${symbol} (engine action ${engineDecision.action})`);
    } else
    if ((engineDecision as any).candidate) {
      const candidate = (engineDecision as any).candidate;
      // Validate through canonical validator
      const validation = validateCandidateTrade(candidate);
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
              confidence: grokDecision.consensusConfidence,
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
            grokDecision,
            direction: engineDecision.action,
            optionSide: candidate.optionType,
            strike: candidate.strike,
            entry: candidate.entry,
            stopLoss: candidate.stopLoss,
            tp1: candidate.tp1 || candidate.target1,
            tp2: candidate.tp2 || candidate.target2,
            confidence: grokDecision.consensusConfidence,
            grade: (engineDecision as any).grade || 'C',
            regime: grokDecision.marketRegime,
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
  }

  return {
    symbol,
    timestamp,
    agentOutputs,
    crossConfluence,
    grokDecision,
    feedGate,
    playbookCheck,
    engineDecision,
    engine,
    tradeRegistered,
    tradeId,
    telegramAlert,
    ...(blockedByKillSwitch ? { blockedByKillSwitch: true } : {}),
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
