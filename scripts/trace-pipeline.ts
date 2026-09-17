// Manual pipeline trace — run with: bun run scripts/trace-pipeline.ts
import { buildOptionChain, assessChainQuality, type NormalizedStrike } from '../src/lib/option-chain-normalizer';
import { detectAndResolveConflicts } from '../src/lib/signal-conflict-detector';
import { runQualityGates, shouldBlockTrade } from '../src/lib/data-validation';
import { scoreTrade, getProfileWeights } from '../src/lib/unified-scoring-engine';

// Simulated MOAPI raw data (LTP only, no OI/Greeks)
const moapiStrikes: NormalizedStrike[] = [
  { strike: 24400, ce: { ltp: 250, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 15, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true }, pe: { ltp: 80, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 16, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true } },
  { strike: 24500, ce: { ltp: 180, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 14, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true }, pe: { ltp: 130, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 15, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true } },
  { strike: 24600, ce: { ltp: 120, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 13, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true }, pe: { ltp: 190, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 17, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: true } },
];

// Simulated Breeze/NSE raw data (full data with OI/Greeks)
const breezeStrikes: NormalizedStrike[] = Array.from({ length: 20 }, (_, i) => {
  const strike = 24100 + i * 100;
  const dist = Math.abs(strike - 24500) / 24500;
  const ceLtp = Math.max(10, 200 - dist * 2000);
  const peLtp = Math.max(10, 50 + dist * 2000);
  return {
    strike,
    ce: { ltp: ceLtp, bid: ceLtp - 2, ask: ceLtp + 2, spread: 4, quoteQuality: 'COMPLETE' as const, oi: 50000 + i * 5000, oiChange: (i - 10) * 1000, volume: 2000 + i * 300, iv: 14 + dist * 5, delta: Math.max(0.05, 0.5 - dist * 2), gamma: 0.001 + (1 - dist) * 0.002, theta: -(3 + dist * 5), vega: 0.08 + (1 - dist) * 0.05, hasData: true },
    pe: { ltp: peLtp, bid: peLtp - 2, ask: peLtp + 2, spread: 4, quoteQuality: 'COMPLETE' as const, oi: 40000 + i * 6000, oiChange: (10 - i) * 1000, volume: 1500 + i * 400, iv: 15 + dist * 5, delta: -(Math.max(0.05, 0.4 - dist * 2)), gamma: 0.001 + (1 - dist) * 0.002, theta: -(3 + dist * 5), vega: 0.08 + (1 - dist) * 0.05, hasData: true },
  };
});

console.log('═══════════════════════════════════════════════════════════');
console.log('  PIPELINE TRACE — MOAPI (no OI) vs BREEZE (full data)');
console.log('═══════════════════════════════════════════════════════════');

for (const [label, strikes, source] of [['MOAPI (LTP only)', moapiStrikes, 'moapi'], ['BREEZE (full)', breezeStrikes, 'breeze']] as const) {
  console.log(`\n── ${label} ──`);

  // Step 1: Build canonical chain
  const chain = buildOptionChain(strikes, 24500, 'NIFTY', source);
  console.log(`\n1. CANONICAL CHAIN:`);
  if (!chain) {
    console.log('   chain: NULL');
    console.log('   → Quality gates will BLOCK');
  } else {
    console.log(`   spot: ${chain.spot}`);
    console.log(`   strikes: ${chain.strikes.length}`);
    console.log(`   pcr: ${chain.pcr.toFixed(2)}`);
    console.log(`   maxPain: ${chain.maxPain}`);
    console.log(`   totalCallOI: ${chain.totalCallOI}`);
    console.log(`   totalPutOI: ${chain.totalPutOI}`);
    console.log(`   dataSource: ${chain.dataSource}`);
    const firstStrike = chain.strikes[0];
    if (firstStrike?.ce) {
      console.log(`   CE[0]: premium=${firstStrike.ce.premium} bid=${firstStrike.ce.bid} ask=${firstStrike.ce.ask} spread=${firstStrike.ce.spread} quoteQuality=${firstStrike.ce.quoteQuality} oi=${firstStrike.ce.oi} delta=${firstStrike.ce.delta.toFixed(2)}`);
    }
  }

  // Step 2: Quality assessment
  if (chain) {
    const quality = assessChainQuality(chain);
    console.log(`\n2. CHAIN QUALITY:`);
    console.log(`   quality: ${quality.quality}`);
    console.log(`   issues: ${quality.issues.join('; ') || 'none'}`);
    console.log(`   hasOI: ${quality.hasOI}`);
    console.log(`   hasGreeks: ${quality.hasGreeks}`);
    console.log(`   hasVolume: ${quality.hasVolume}`);
  }

  // Step 3: Quality gates
  const gates = runQualityGates(chain as any, 24500, 15, source);
  const blockResult = shouldBlockTrade(gates);
  console.log(`\n3. QUALITY GATES:`);
  for (const g of gates) {
    console.log(`   ${g.passed ? '✓' : '✗'} ${g.gate}: ${g.reason} [${g.severity}]`);
  }
  console.log(`   BLOCK: ${blockResult.block}`);
  if (blockResult.block) {
    console.log(`   REASONS: ${blockResult.reasons.join('; ')}`);
  }

  // Step 4: CE/PE scoring (using unified engine)
  if (!blockResult.block && chain) {
    const ceInput = {
      symbol: 'NIFTY', strategy: 'HERMES' as const, direction: 'BULLISH' as const,
      spot: 24500, vix: 15, pcr: chain.pcr,
      optionChain: chain.strikes.map(s => ({
        strike: s.strike,
        ce: s.ce ? { ltp: s.ce.premium, oi: s.ce.oi, oiChg: s.ce.oiChange, volume: s.ce.volume, iv: s.ce.iv, delta: s.ce.delta, theta: s.ce.theta, gamma: s.ce.gamma, vega: s.ce.vega } : undefined,
        pe: s.pe ? { ltp: s.pe.premium, oi: s.pe.oi, oiChg: s.pe.oiChange, volume: s.pe.volume, iv: s.pe.iv, delta: s.pe.delta, theta: s.pe.theta, gamma: s.pe.gamma, vega: s.pe.vega } : undefined,
      })),
    };
    const peInput = { ...ceInput, direction: 'BEARISH' as const };

    const ceResult = scoreTrade(ceInput);
    const peResult = scoreTrade(peInput);

    console.log(`\n4. CE SCORE: ${ceResult.score}/100 (${ceResult.grade}) decision=${ceResult.decision}`);
    console.log(`   weights: structure=${ceResult.weightsUsed.structure} oiDelta=${ceResult.weightsUsed.oiDelta} greeksIv=${ceResult.weightsUsed.greeksIv}`);
    console.log(`   profile: ${ceResult.strategyProfile}`);

    console.log(`\n5. PE SCORE: ${peResult.score}/100 (${peResult.grade}) decision=${peResult.decision}`);

    // Step 5: Conflict detection
    const ceSignal = { source: 'unified-HERMES-CE', direction: ceResult.decision === 'TRADE' ? 'CE' as const : 'NO_TRADE' as const, confidence: ceResult.score, score: ceResult.score };
    const peSignal = { source: 'unified-HERMES-PE', direction: peResult.decision === 'TRADE' ? 'PE' as const : 'NO_TRADE' as const, confidence: peResult.score, score: peResult.score };

    const conflict = detectAndResolveConflicts([ceSignal, peSignal], chain as any, 'neutral');
    console.log(`\n6. CONFLICT CHECK:`);
    console.log(`   hasConflict: ${conflict.hasConflict}`);
    console.log(`   resolved: ${conflict.resolvedDirection}`);
    console.log(`   reasons: ${conflict.reasons.join('; ')}`);

    // Final decision
    console.log(`\n7. FINAL DECISION: ${conflict.resolvedDirection === 'WAIT' ? 'WAIT' : conflict.resolvedDirection === 'CE' ? 'BUY_CE' : conflict.resolvedDirection === 'PE' ? 'BUY_PE' : 'WAIT'}`);
  } else {
    console.log(`\n4. FINAL DECISION: WAIT (quality gates blocked)`);
  }
}
