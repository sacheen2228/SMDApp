import type { Candle, SmartMoneyData, OrderFlowData, VolatilityData, RegimeResult, OpenInterestData } from '@/types/engine';
import type { MarketPlaybook, AuctionResult, TargetPlan } from './types';

import { determineMarketState } from './market-state';
import { analyzeAuction } from './auction';
import { determineIntent } from './market-intent';
import { buildGraph } from './liquidity-graph';
import { findDestinations } from './destination';
import { predictPath } from './path';
import { generateTargetPlan } from './target';
import { validateTrade, type ValidationInput } from './validation';
import { MarketMemory } from './memory';

export { MarketMemory } from './memory';

export interface ImieInput {
  candles: Candle[];
  levels: { price: number; size: number; isBid: boolean }[];
  price: number;
  sm: SmartMoneyData;
  of: OrderFlowData | null;
  vol: VolatilityData | null;
  regime: RegimeResult | null;
  oi: OpenInterestData | null;
  pair: string;
}

export interface ImieOptions {
  gradeFilter?: 'A' | 'B' | 'C';
  mode?: 'full' | 'fast';
}

export class ImieOrchestrator {
  private memory: MarketMemory;

  constructor() {
    this.memory = new MarketMemory();
  }

  analyze(input: ImieInput, options?: ImieOptions): MarketPlaybook {
    const { candles, levels, price, sm, of, vol, regime, oi, pair } = input;
    const mode = options?.mode || 'full';

    // Phase 1: Market State
    const marketState = determineMarketState(candles, price);

    // Phase 2: Auction State
    const auction = analyzeAuction(candles, price);

    // Phase 3: Market Intent
    const intent = determineIntent(auction, candles, price, sm, of, vol, regime);

    // Phase 4: Liquidity Graph
    const graph = buildGraph(candles, levels, price, sm, oi, of);

    // Phase 5: Destinations
    const destinations = findDestinations(graph, candles, price, sm, of, vol, regime, oi);

    // Fast mode: skip path/plan for low confidence
    if (mode === 'fast' && (!destinations.topDestination || destinations.topDestination.probability < 60)) {
      const noopPlaybook = this.buildPlaybook({
        pair, price, marketState, auction, intent, graph, destinations,
        path: { primary: [], alternative: [], failure: [] },
        plan: null,
        validation: { approved: false, aiScore: 0, confidence: 0, rr: 0, destinationProbability: 0, dataQuality: 0, rejectReasons: ['Fast mode: low confidence destination'] },
      }, marketState.confidence, 0);
      return noopPlaybook;
    }

    // Phase 6: Path
    const path = destinations.topDestination
      ? predictPath(destinations.topDestination, graph, price, candles, sm, of, vol, intent.primary)
      : { primary: [], alternative: [], failure: [] };

    // Phase 7: Target Plan
    const plan = destinations.topDestination
      ? generateTargetPlan(destinations, path, auction, price, vol, sm, intent.primary, of, oi, regime)
      : null;

    // Phase 8: Validation
    const dataQuality = this.computeDataQuality(candles, levels, oi);
    const aiScore = this.computeAiScore(marketState, auction, intent, destinations, graph);
    const confidence = this.computeConfidence(marketState, auction, intent, destinations, plan);
    const rr = plan?.riskReward || 0;
    const destProb = destinations.topDestination?.probability || 0;

    const validation = validateTrade({
      aiScore,
      confidence: Math.round(confidence * 100),
      rr,
      destinationProbability: destProb,
      dataQuality,
      direction: plan?.direction || 'long',
      regime,
      smDirection: sm.bos,
      oiData: oi,
    });

    // Phase 10: Market Playbook
    return this.buildPlaybook({
      pair, price, marketState, auction, intent, graph, destinations, path, plan, validation,
    }, confidence, aiScore);
  }

  getMemory(): MarketMemory {
    return this.memory;
  }

  private computeDataQuality(
    candles: Candle[],
    levels: { price: number; size: number }[],
    oi: OpenInterestData | null,
  ): number {
    let quality = 100;
    if (candles.length < 20) quality -= 20;
    if (candles.length < 50) quality -= 10;
    if (levels.length < 5) quality -= 15;
    if (!oi?.currentOi) quality -= 10;
    if (candles.length > 0 && candles.some(c => c.volume === 0)) quality -= 5;
    return Math.max(50, Math.min(100, quality));
  }

  private computeAiScore(
    marketState: { confidence: number },
    auction: { confidence: number },
    intent: { primaryConfidence: number },
    destinations: { topDestination: { probability: number } | null },
    graph: { totalNodes: number },
  ): number {
    const marketScore = marketState.confidence * 20;
    const auctionScore = auction.confidence * 25;
    const intentScore = intent.primaryConfidence * 25;
    const destScore = (destinations.topDestination?.probability || 0) / 100 * 25;
    const graphScore = Math.min(1, graph.totalNodes / 30) * 5;
    return Math.round(marketScore + auctionScore + intentScore + destScore + graphScore);
  }

  private computeConfidence(
    marketState: { confidence: number },
    auction: AuctionResult,
    intent: { primaryConfidence: number },
    destinations: { topDestination: { probability: number } | null },
    plan: TargetPlan | null,
  ): number {
    const m = marketState.confidence;
    const a = auction.confidence;
    const i = intent.primaryConfidence;
    const d = (destinations.topDestination?.probability || 0) / 100;
    const p = plan?.confidence || 0;
    return parseFloat(((m * 0.15 + a * 0.15 + i * 0.25 + d * 0.25 + p * 0.2)).toFixed(2));
  }

  private buildPlaybook(
    data: {
      pair: string; price: number;
      marketState: any; auction: any; intent: any;
      graph: any; destinations: any;
      path: any; plan: any; validation: any;
    },
    confidence: number,
    aiScore: number,
  ): MarketPlaybook {
    const { pair, price, marketState, auction, intent, graph, destinations, path, plan, validation } = data;

    const grade = aiScore >= 85 ? 'A' : aiScore >= 75 ? 'B' : aiScore >= 60 ? 'C' : aiScore >= 45 ? 'D' : 'F';
    const conviction = grade === 'A' ? 'STRONG' : grade === 'B' ? 'MODERATE' : grade === 'C' ? 'WEAK' : 'AVOID';

    // Build playbook strings
    const playbook: string[] = [];
    playbook.push(`Market State: ${marketState.state} (${(marketState.confidence * 100).toFixed(0)}% confidence)`);
    playbook.push(`Auction: ${auction.acceptance ? 'Accepting' : auction.rejection ? 'Rejecting' : 'Testing'} at POC ${auction.poc.toFixed(2)} | Value ${auction.val.toFixed(2)}–${auction.vah.toFixed(2)}`);
    playbook.push(`Intent: ${intent.primary.replace(/_/g, ' ')} (${intent.primaryProbability}%)`);

    if (intent.secondary) {
      playbook.push(`Secondary: ${intent.secondary.replace(/_/g, ' ')} (${intent.secondaryProbability}%)`);
    }

    const top = destinations.topDestination;
    if (top) {
      playbook.push(`Primary Destination: ${top.price.toFixed(2)} (${top.probability}%) — ${top.node.type} via ${top.node.source}`);
    }

    playbook.push(`Failure: ${intent.failureCondition}`);

    // Expected path
    const expectedPath: string[] = [];
    expectedPath.push(`Current Price: ${price.toFixed(2)}`);
    for (const step of path.primary) {
      expectedPath.push(`→ ${step.label}: ${step.price.toFixed(2)} — ${step.description}`);
    }

    const second = destinations.destinations[1];
    const third = destinations.destinations[2];

    return {
      timestamp: Date.now(),
      pair,
      price,
      aiScore,
      confidence,
      marketState,
      auction,
      intent,
      graph,
      destinations,
      path,
      plan,
      validation,
      memory: { entries: [], stats: { totalTrades: 0, winRate: 0, avgPnl: 0, avgMfe: 0, avgMae: 0, bestIntents: [], bestDestinations: [] } },
      summary: {
        grade,
        conviction,
        playbook,
        expectedPath,
        failureCondition: intent.failureCondition,
        estimatedWindow: `${intent.primaryDuration}`,
      },
    };
  }
}

export const imie = new ImieOrchestrator();
