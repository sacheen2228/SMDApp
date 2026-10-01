// ═══════════════════════════════════════════════════════════════════════════
// 30-Agent Registry — Every agent connected to real SMDApp data/functions
// Each agent has: real data source, analysis logic, structured output
// ═══════════════════════════════════════════════════════════════════════════

import { freshnessFromIso } from './agent-contract';
import {
  bridgeChainScore, bridgeGreeks, bridgeLevels, bridgeFiiScore, bridgeNewsSigned,
} from './jarvis-bridge';
import type {
  AgentDefinition, AgentId, AgentContext, AgentResearchOutput,
  AgentCategory, AgentBias, AgentRecommendation, DataFreshnessLevel,
} from './agent-contract';

// ─── Helper: create standardized output ───────────────────────────

function createOutput(
  def: AgentDefinition,
  ctx: AgentContext,
  overrides: Partial<AgentResearchOutput>
): AgentResearchOutput {
  return {
    agentId: def.id,
    agentName: def.name,
    category: def.category,
    timestamp: new Date().toISOString(),
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    dataFreshness: freshnessFromIso(ctx.fetchedAtIso),
    observation: '',
    bias: 'NEUTRAL',
    confidence: 50,
    evidence: [],
    riskFlags: [],
    conflicts: [],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: '',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 01 — MARKET REGIME
// Analyzes: bullish/bearish/range, trend strength, volatility, gaps
// Source: /api/market/regime, hermes context
// ═══════════════════════════════════════════════════════════════════

async function analyzeMarketRegime(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'MARKET_REGIME')!;
  const regime = ctx.regime || 'UNCERTAIN';
  const bias = ctx.regimeBias as AgentBias || 'NEUTRAL';
  const confidence = ctx.regimeConfidence || 0;

  const evidence: string[] = [];
  const riskFlags: string[] = [];

  if (regime === 'TRENDING_UP') {
    evidence.push('Market in uptrend');
    if (ctx.spot > ctx.pdh) evidence.push('Price above PDH — bullish continuation');
  } else if (regime === 'TRENDING_DOWN') {
    evidence.push('Market in downtrend');
    if (ctx.spot < ctx.pdl) evidence.push('Price below PDL — bearish continuation');
  } else if (regime === 'RANGE') {
    evidence.push('Market in range — mean reversion likely');
  } else if (regime === 'COMPRESSION') {
    evidence.push('Compression detected — breakout imminent');
    riskFlags.push('Compression may break either direction');
  } else if (regime === 'EXPANSION') {
    evidence.push('Expansion — trending conditions');
  } else if (regime === 'HIGH_VOLATILITY') {
    riskFlags.push('High volatility — wider stops needed');
  }

  return createOutput(def, ctx, {
    observation: `Regime: ${regime}, Bias: ${bias}, Confidence: ${confidence}%`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 60 ? 'TRADE' : 'WAIT',
    recommendationReason: confidence >= 60 ? `Regime ${regime} with ${confidence}% confidence` : 'Insufficient regime clarity',
    data: { regime, bias, confidence },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 02 — FII/DII
// Analyzes: FII cash, DII activity, participant OI, institutional flow
// Source: /api/fii-dii, fii-dii.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeFIIDII(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'FII_DII')!;
  const fiiNet = ctx.fiiNet || 0;
  const diiNet = ctx.diiNet || 0;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  if (fiiNet > 500) { evidence.push(`FII net buying ₹${fiiNet}Cr — bullish`); bias = 'BULLISH'; confidence = 60; }
  else if (fiiNet > 0) { evidence.push(`FII mild buying ₹${fiiNet}Cr`); confidence = 45; }
  else if (fiiNet < -500) { evidence.push(`FII net selling ₹${Math.abs(fiiNet)}Cr — bearish`); bias = 'BEARISH'; confidence = 60; }
  else if (fiiNet < 0) { evidence.push(`FII mild selling ₹${Math.abs(fiiNet)}Cr`); confidence = 45; }

  if (diiNet > 500) { evidence.push(`DII buying ₹${diiNet}Cr — supporting`); }
  else if (diiNet < -500) { evidence.push(`DII selling ₹${Math.abs(diiNet)}Cr`); }

  if (fiiNet > 0 && diiNet > 0) { evidence.push('Both FII + DII buying — strong institutional support'); confidence += 10; }
  if (fiiNet < 0 && diiNet > 0) { evidence.push('FII selling but DII buying — mixed institutional flow'); }
  if (fiiNet > 0 && diiNet < 0) { evidence.push('FII buying but DII selling — mixed'); }

  // v2 §2 — jarvis scoring.ts fiiScore thresholds (-6..+6) over the same snapshot flow
  const jfii = bridgeFiiScore(ctx);
  if (jfii !== 0) {
    evidence.push(`Jarvis FII score: ${jfii > 0 ? '+' : ''}${jfii}`);
    confidence += Math.abs(jfii) >= 3 ? 8 : 3;
  }

  // Reconciled institutional positioning slice (populated by snapshot.ts via runInstitutionalPositioning)
  const inst = ctx.institutional;
  if (inst) {
    const instBias: string = inst.bias || 'neutral';
    const instConf: number = typeof inst.confidence?.overall === 'number' ? inst.confidence.overall : 0;
    const instAlign: number = typeof inst.alignment?.overallAlignment === 'number' ? inst.alignment.overallAlignment : 0;
    const retailTrapDetected: boolean = !!inst.retailTrap?.detected && inst.retailTrap?.severity === 'high';

    if (instBias === 'bullish' && instConf >= 70) {
      bias = 'BULLISH';
      confidence = Math.min(80, confidence + 10);
      evidence.push(`Institutional positioning bullish (confidence ${instConf}/100, alignment ${instAlign}%)`);
    } else if (instBias === 'bearish' && instConf >= 70) {
      bias = 'BEARISH';
      confidence = Math.min(80, confidence + 10);
      evidence.push(`Institutional positioning bearish (confidence ${instConf}/100, alignment ${instAlign}%)`);
    } else if (instConf >= 40 && bias === 'NEUTRAL') {
      evidence.push(`Institutional positioning ${instBias} (confidence ${instConf}/100)`);
      confidence = Math.min(80, confidence + 3);
    }

    if (retailTrapDetected) {
      riskFlags.push('High-severity retail trap flagged by institutional engine');
      confidence = Math.max(0, confidence - 15);
    }
  }

  riskFlags.push('FII/DII alone should not drive trade decisions');

  return createOutput(def, ctx, {
    observation: `FII: ₹${fiiNet}Cr, DII: ₹${diiNet}Cr`,
    bias,
    confidence: Math.min(confidence, 80),
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'FII/DII provides contextual evidence only',
    data: { fiiNet, diiNet, fiiBias: ctx.fiiBias, jarvisFiiScore: jfii, institutionalBias: inst?.bias, institutionalConfidence: inst?.confidence?.overall },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 03 — GLOBAL MARKET
// Analyzes: US indices, Asian markets, overnight risk
// Source: yahoo-finance-api.ts, /api/news
// ═══════════════════════════════════════════════════════════════════

async function analyzeGlobalMarket(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'GLOBAL_MARKET')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  // Use news sentiment as proxy for global market mood
  if (ctx.newsSentiment === 'BULLISH') {
    evidence.push('Global/news sentiment bullish');
    bias = 'BULLISH';
    confidence = 50;
  } else if (ctx.newsSentiment === 'BEARISH') {
    evidence.push('Global/news sentiment bearish');
    bias = 'BEARISH';
    confidence = 50;
  } else {
    evidence.push('Global market sentiment neutral');
  }

  if (ctx.headlines.length > 0) {
    evidence.push(`Recent headlines: ${ctx.headlines.slice(0, 3).join('; ')}`);
  }

  return createOutput(def, ctx, {
    observation: `Global sentiment: ${ctx.newsSentiment || 'UNKNOWN'}`,
    bias,
    confidence,
    evidence,
    riskFlags: ['Global markets are contextual — not direct trade triggers'],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Global market is context, not a trade signal',
    data: { sentiment: ctx.newsSentiment, score: ctx.newsScore },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 04 — INDIA VIX
// Analyzes: current VIX, trend, volatility regime, premium environment
// Source: option chain summary, hermes context
// ═══════════════════════════════════════════════════════════════════

async function analyzeIndiaVIX(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'INDIA_VIX')!;
  const vix = ctx.vix || 15;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  if (vix < 12) {
    evidence.push(`VIX ${vix} — very low volatility, cheap premiums`);
    evidence.push('Favorable for option buying (low cost)');
    bias = 'BULLISH'; // Low vol = good for buyers
    confidence = 60;
  } else if (vix < 15) {
    evidence.push(`VIX ${vix} — low volatility`);
    evidence.push('Reasonable premium environment');
    confidence = 50;
  } else if (vix < 20) {
    evidence.push(`VIX ${vix} — normal volatility`);
    confidence = 50;
  } else if (vix < 25) {
    evidence.push(`VIX ${vix} — elevated volatility`);
    riskFlags.push('Higher premiums — wider stops needed');
    confidence = 45;
  } else {
    evidence.push(`VIX ${vix} — very high volatility`);
    riskFlags.push('Extremely high premiums — avoid OTM buys');
    riskFlags.push('High vol = mean reversion likely');
    bias = 'BEARISH';
    confidence = 40;
  }

  return createOutput(def, ctx, {
    observation: `India VIX: ${vix}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: vix < 15 ? 'TRADE' : 'WAIT',
    recommendationReason: vix < 15 ? 'Low VIX favors option buying' : `VIX ${vix} — wait for calibration`,
    data: { vix, regime: vix < 12 ? 'LOW' : vix < 18 ? 'NORMAL' : vix < 25 ? 'ELEVATED' : 'HIGH' },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 05 — MARKET BREADTH
// Analyzes: advances, declines, A/D ratio, breadth trend
// Source: /api/market/breadth
// ═══════════════════════════════════════════════════════════════════

async function analyzeMarketBreadth(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'MARKET_BREADTH')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 45;

  // Use volume as breadth proxy if real breadth data unavailable
  if (ctx.volume > 0) {
    evidence.push(`Volume: ${ctx.volume.toLocaleString()}`);
  }

  // If market is trending up with broad participation, bullish
  if (ctx.trend === 'UP' && ctx.spot > ctx.pdh) {
    evidence.push('Price above PDH with uptrend — likely broad participation');
    bias = 'BULLISH';
    confidence = 55;
  } else if (ctx.trend === 'DOWN' && ctx.spot < ctx.pdl) {
    evidence.push('Price below PDL with downtrend — likely broad selling');
    bias = 'BEARISH';
    confidence = 55;
  }

  return createOutput(def, ctx, {
    observation: `Breadth context: Trend ${ctx.trend}, Volume ${ctx.volume}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'Breadth confirms directional bias',
    data: {},
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 06 — SECTOR ROTATION
// Analyzes: leading/weak sectors, sector momentum
// Source: /api/market/heatmap
// ═══════════════════════════════════════════════════════════════════

async function analyzeSectorRotation(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'SECTOR_ROTATION')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  // For indices, sector rotation is directly relevant
  if (['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(ctx.symbol)) {
    evidence.push(`Index: ${ctx.symbol} — sector context matters`);
    if (ctx.symbol === 'BANKNIFTY') {
      evidence.push('Banking sector performance is key driver');
    }
    confidence = 45;
  } else {
    evidence.push(`Stock: ${ctx.symbol} — sector context is supplementary`);
    confidence = 35;
  }

  return createOutput(def, ctx, {
    observation: `Sector context for ${ctx.symbol}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Sector rotation is contextual evidence',
    data: {},
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 07 — OI/PCR
// Analyzes: CE OI, PE OI, OI change, PCR, strike-wise OI, support/resistance
// Source: sdm-oianalysis.ts, option chain
// ═══════════════════════════════════════════════════════════════════

async function analyzeOIPCR(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'OI_PCR')!;
  const chain = ctx.optionChain;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  if (!chain) {
    return createOutput(def, ctx, {
      observation: 'Option chain data unavailable',
      bias: 'NO_DATA',
      confidence: 0,
      dataFreshness: 'MISSING',
      recommendationContext: 'NO_TRADE',
      recommendationReason: 'No option chain data',
    });
  }

  const totalCallOI = chain.totalCallOI || 0;
  const totalPutOI = chain.totalPutOI || 0;
  // v2 §2 — canonical PCR/support/resistance/maxPain from jarvis scoring.ts
  // (optionChainScore over ctx.jarvisChain — the same snapshot fetch);
  // inline totals remain only as fallback when the jarvis chain is unusable.
  const js = bridgeChainScore(ctx);
  const pcr = js
    ? Math.round(js.pcr * 100) / 100
    : (totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0);
  const maxPain = js?.maxPain || chain.maxPain || 0;

  if (js?.resistance) evidence.push(`OI wall resistance: ${js.resistance} (top CE OI strike)`);
  if (js?.support) evidence.push(`OI wall support: ${js.support} (top PE OI strike)`);
  if (js) evidence.push(`Jarvis OI score: ${js.score}`);

  if (pcr > 1.2) {
    evidence.push(`PCR ${pcr} — strong put writing, bullish support`);
    bias = 'BULLISH';
    confidence = 60;
  } else if (pcr > 0.8) {
    evidence.push(`PCR ${pcr} — balanced OI`);
    confidence = 50;
  } else if (pcr > 0.5) {
    evidence.push(`PCR ${pcr} — heavy call writing, resistance building`);
    bias = 'BEARISH';
    confidence = 55;
  } else {
    evidence.push(`PCR ${pcr} — extreme call writing, very bearish`);
    bias = 'BEARISH';
    confidence = 60;
  }

  if (maxPain > 0) {
    const distFromMP = Math.abs(ctx.spot - maxPain);
    evidence.push(`Max Pain: ${maxPain}, Spot ${ctx.spot > maxPain ? 'above' : 'below'} by ${distFromMP}`);
    if (distFromMP < 50) evidence.push('Near max pain — expect magnetic pull');
  }

  // OI change
  const callOiChange = chain.callOiChange || 0;
  const putOiChange = chain.putOiChange || 0;
  if (callOiChange > 0) evidence.push(`Call OI increasing +${callOiChange.toLocaleString()} — resistance building`);
  if (putOiChange > 0) evidence.push(`Put OI increasing +${putOiChange.toLocaleString()} — support building`);
  if (callOiChange < 0) evidence.push(`Call OI unwinding ${callOiChange.toLocaleString()} — resistance weakening`);
  if (putOiChange < 0) evidence.push(`Put OI unwinding ${putOiChange.toLocaleString()} — support weakening`);

  riskFlags.push('OI/PCR should not be used standalone for trade decisions');

  return createOutput(def, ctx, {
    observation: `PCR: ${pcr}, Max Pain: ${maxPain}, Call OI: ${totalCallOI.toLocaleString()}, Put OI: ${totalPutOI.toLocaleString()}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: `PCR ${pcr} with OI change analysis`,
    data: { pcr, maxPain, totalCallOI, totalPutOI, callOiChange, putOiChange, jarvis: js ?? null },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 08 — OI CLASSIFICATION
// Classifies: long build-up, short build-up, short covering, long unwinding
// Source: oi-classification-engine.ts (requires PRICE + OI + VOLUME)
// ═══════════════════════════════════════════════════════════════════

async function analyzeOIClassification(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'OI_CLASSIFICATION')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const chain = ctx.optionChain;
  if (!chain) {
    return createOutput(def, ctx, {
      observation: 'OI classification unavailable — no chain data',
      bias: 'NO_DATA', confidence: 0, dataFreshness: 'MISSING',
      recommendationContext: 'NO_TRADE', recommendationReason: 'No data',
    });
  }

  // Simplified OI classification based on price + OI + volume
  const priceChange = ctx.spot - ctx.prevClose;
  const callOiChange = chain.callOiChange || 0;
  const putOiChange = chain.putOiChange || 0;

  if (priceChange > 0 && putOiChange > 0) {
    evidence.push('LONG_BUILDUP: Price up + Put OI up = fresh put writing (bullish)');
    bias = 'BULLISH';
    confidence = 60;
  } else if (priceChange > 0 && callOiChange < 0) {
    evidence.push('SHORT_COVERING: Price up + Call OI down = call writers exiting (bullish)');
    bias = 'BULLISH';
    confidence = 55;
  } else if (priceChange < 0 && callOiChange > 0) {
    evidence.push('SHORT_BUILDUP: Price down + Call OI up = fresh call writing (bearish)');
    bias = 'BEARISH';
    confidence = 60;
  } else if (priceChange < 0 && putOiChange < 0) {
    evidence.push('LONG_UNWINDING: Price down + Put OI down = put buyers exiting (bearish)');
    bias = 'BEARISH';
    confidence = 55;
  } else {
    evidence.push('Mixed OI classification — no clear pattern');
  }

  return createOutput(def, ctx, {
    observation: `OI classification: Price Δ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}, Call OI Δ${callOiChange}, Put OI Δ${putOiChange}`,
    bias,
    confidence,
    evidence,
    riskFlags: ['OI classification requires PRICE + OI + VOLUME confirmation'],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'OI classification supports directional bias',
    data: { priceChange, callOiChange, putOiChange },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 09 — GREEKS
// Analyzes: Delta, Gamma, Theta, Vega, IV, option sensitivity
// Source: greeks.ts, option chain ATM data
// ═══════════════════════════════════════════════════════════════════

async function analyzeGreeks(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'GREEKS')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // v2 §2 — primary source: jarvis greeks.analyseGreeks over the snapshot
  // chain (Black-Scholes from NSE per-strike IV). Hermes ATM greeks are
  // fallback only when the jarvis pass is unavailable.
  const g = bridgeGreeks(ctx, ctx.vix || undefined);
  const atmRow = g ? g.perStrike.find(p => p.strike === g.atmStrike) : undefined;
  const delta = atmRow?.CE?.delta ?? (ctx.atmDelta || 0.5);
  const gamma = atmRow?.CE?.gamma ?? (ctx.atmGamma || 0);
  const theta = atmRow?.CE?.theta ?? (ctx.atmTheta || 0);
  const vega = atmRow?.CE?.vega ?? (ctx.atmVega || 0);
  const iv = (g && g.atmIv > 0 ? g.atmIv : ctx.atmIV) || 0;

  if (g) {
    evidence.push(`Jarvis greek score: ${g.greekScore} (-10..+10)`);
    evidence.push(`ATM strike (jarvis): ${g.atmStrike}`);
  }

  evidence.push(`ATM Delta: ${delta.toFixed(3)}`);
  evidence.push(`ATM Gamma: ${gamma.toFixed(5)}`);
  evidence.push(`ATM Theta: ${theta.toFixed(2)}`);
  evidence.push(`ATM Vega: ${vega.toFixed(3)}`);
  evidence.push(`ATM IV: ${iv.toFixed(1)}%`);

  // High gamma = acceleration potential
  if (gamma > 0.001) {
    evidence.push('High gamma — strong acceleration potential on move');
  }

  // High theta = time decay risk for buyers
  if (theta < -5) {
    evidence.push('High theta decay — premium eroding fast');
  }

  // High vega = volatility sensitivity
  if (vega > 0.5) {
    evidence.push('High vega — VIX changes will impact premium significantly');
  }

  return createOutput(def, ctx, {
    observation: `Greeks: Δ${delta.toFixed(3)} Γ${gamma.toFixed(5)} Θ${theta.toFixed(2)} V${vega.toFixed(3)} IV${iv.toFixed(1)}%`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Greeks provide strike-level context',
    data: { delta, gamma, theta, vega, iv, jarvisScore: g?.greekScore ?? null, source: g ? 'jarvis' : 'hermes' },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 10 — GAMMA
// Analyzes: gamma concentration, walls, positive/negative zones
// Source: hermes gamma data, option chain
// ═══════════════════════════════════════════════════════════════════

async function analyzeGamma(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'GAMMA')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // v2 §2 — jarvis greeks pass gives net GEX + gamma flip + dealer regime
  // (complementary to hermes/greek-flow's wall + dealer-bias detection).
  const g = bridgeGreeks(ctx, ctx.vix || undefined);
  if (g) {
    evidence.push(`Net GEX: ${g.netGex} — regime ${g.regime === 'pinned' ? 'pinned (mean reversion)' : 'trending (acceleration)'}`);
    evidence.push(g.gammaFlip !== null ? `Gamma flip: ${g.gammaFlip}` : 'No gamma flip within chain range');
    if (g.regime === 'trending') riskFlags.push('Negative net GEX — moves can accelerate');
  }

  if (ctx.gammaDetected) {
    evidence.push(`Gamma wall detected at ${ctx.gammaWallStrike}`);
    evidence.push(`Gamma flip (greek-flow): ${ctx.gammaFlip}`);
    evidence.push(`Dealer bias: ${ctx.dealerBias}`);

    if (ctx.dealerBias === 'LONG_GAMMA') {
      evidence.push('Dealers long gamma — will sell rallies, buy dips');
      bias = 'NEUTRAL';
    } else if (ctx.dealerBias === 'SHORT_GAMMA') {
      evidence.push('Dealers short gamma — will buy rallies, sell dips (acceleration)');
      riskFlags.push('Short gamma can accelerate moves');
    }
  } else {
    evidence.push('No significant gamma levels detected');
  }

  return createOutput(def, ctx, {
    observation: `Gamma: ${ctx.gammaDetected ? 'Detected' : 'None'}, Dealer: ${ctx.dealerBias}${g ? `, netGEX ${g.netGex}` : ''}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Gamma provides dealer positioning context',
    data: { detected: ctx.gammaDetected, wall: ctx.gammaWallStrike, flip: g?.gammaFlip ?? ctx.gammaFlip, dealerBias: ctx.dealerBias, netGex: g?.netGex ?? null, regime: g?.regime ?? null },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 11 — IV/HV
// Analyzes: IV, HV, IV/HV relationship, expansion/contraction
// Source: greeks.ts, option chain
// ═══════════════════════════════════════════════════════════════════

async function analyzeIVHV(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'IV_HV')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;
  // v2 §2 — ATM IV + put-call skew from jarvis greeks pass (computed from
  // NSE per-strike IVs); hermes atm IV only as fallback.
  const g = bridgeGreeks(ctx, ctx.vix || undefined);
  const iv = (g && g.atmIv > 0 ? g.atmIv : ctx.atmIV) || 0;

  if (g) {
    evidence.push(`ATM straddle (jarvis): ${g.atmStraddle}`);
    const skew = g.skewPutMinusCall;
    if (skew !== null && skew !== undefined) {
      evidence.push(`IV skew put-call: ${skew} vol pts`);
      if (skew > 2) { evidence.push('Put skew elevated — fear/hedging demand'); riskFlags.push('Elevated put skew — hedging demand raises downside premium risk'); }
      else if (skew < -1) evidence.push('Call skew rich — upside demand');
    }
  }

  // Compare IV to VIX (proxy for HV)
  const vix = ctx.vix || 15;
  if (iv > 0 && vix > 0) {
    const ivHVRatio = iv / vix;
    if (ivHVRatio > 1.3) {
      evidence.push(`IV ${iv.toFixed(1)}% significantly above VIX ${vix}% — IV premium rich`);
      evidence.push('Favorable for buying now if IV contracts');
      bias = 'BULLISH';
      confidence = 55;
    } else if (ivHVRatio < 0.7) {
      evidence.push(`IV ${iv.toFixed(1)}% below VIX ${vix}% — IV discount`);
      evidence.push('Cheap premiums — good for buyers');
      bias = 'BULLISH';
      confidence = 60;
    } else {
      evidence.push(`IV ${iv.toFixed(1)}% in line with VIX ${vix}%`);
    }
  }

  return createOutput(def, ctx, {
    observation: `IV: ${iv.toFixed(1)}%, VIX: ${vix}%`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'IV/HV relationship informs premium environment',
    data: { iv, vix, skewPutMinusCall: g?.skewPutMinusCall ?? null, source: g ? 'jarvis' : 'hermes' },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 12 — OPTION ACCELERATION
// Analyzes: premium movement, delta response, volume acceleration
// Source: option-acceleration-engine.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeOptionAcceleration(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'OPTION_ACCELERATION')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // Use volume + price movement as acceleration proxy
  const priceChange = ctx.spot - ctx.prevClose;
  const priceChangePct = ctx.prevClose > 0 ? (priceChange / ctx.prevClose) * 100 : 0;

  if (Math.abs(priceChangePct) > 0.5) {
    evidence.push(`Strong price movement: ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`);
    if (ctx.volume > 0) {
      evidence.push(`Volume: ${ctx.volume.toLocaleString()} — movement supported`);
    }
    bias = priceChangePct > 0 ? 'BULLISH' : 'BEARISH';
    confidence = 60;
  } else {
    evidence.push(`Price movement muted: ${priceChangePct.toFixed(2)}%`);
    confidence = 40;
  }

  return createOutput(def, ctx, {
    observation: `Acceleration: Price ${priceChangePct.toFixed(2)}%, Volume ${ctx.volume}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: 'Acceleration confirms directional momentum',
    data: { priceChangePct, volume: ctx.volume },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 13 — BUYER CONFLUENCE
// Analyzes: option buying conditions alignment
// Source: buyer-confluence-engine.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeBuyerConfluence(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'BUYER_CONFLUENCE')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;
  let score = 0;

  // Check buyer-favorable conditions
  const vix = ctx.vix || 15;
  if (vix < 15) { score += 2; evidence.push(`VIX ${vix} < 15 — low premium environment`); }
  if (ctx.trend === 'UP' || ctx.trend === 'DOWN') { score += 1; evidence.push(`Clear trend: ${ctx.trend}`); }
  if (ctx.volume > 0) { score += 1; evidence.push('Volume available'); }
  if (ctx.atmIV > 0 && ctx.atmIV < 20) { score += 1; evidence.push(`IV ${ctx.atmIV.toFixed(1)}% — reasonable`); }

  // Check for buyer-unfavorable conditions
  if (vix > 25) { score -= 2; riskFlags.push(`VIX ${vix} — expensive premiums`); }
  if (ctx.trend === 'SIDEWAYS') { score -= 1; riskFlags.push('Sideways market — poor directional conviction'); }

  confidence = Math.max(20, Math.min(80, 40 + score * 8));

  if (score >= 3) { bias = 'BULLISH'; }
  else if (score <= -2) { bias = 'BEARISH'; }
  else { bias = 'NEUTRAL'; }

  return createOutput(def, ctx, {
    observation: `Buyer confluence score: ${score}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: score >= 3 ? 'TRADE' : score <= -1 ? 'NO_TRADE' : 'WAIT',
    recommendationReason: `Buyer conditions score: ${score}`,
    data: { score },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 14 — STRIKE SELECTION
// Analyzes: ATM/ITM/OTM, delta, liquidity, spread, premium
// Source: hermes/strike-selector.ts, option chain
// ═══════════════════════════════════════════════════════════════════

async function analyzeStrikeSelection(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'STRIKE_SELECTION')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  if (!ctx.strikes || ctx.strikes.length === 0) {
    return createOutput(def, ctx, {
      observation: 'No strikes available for selection',
      bias: 'NO_DATA', confidence: 0, dataFreshness: 'MISSING',
      recommendationContext: 'NO_TRADE', recommendationReason: 'No strike data',
    });
  }

  const atmStrike = ctx.optionChain?.atmStrike || 0;
  const atmStrikeData = ctx.strikes.find((s: any) => s.strike === atmStrike);

  // v2 §2 — delta-based strike from jarvis per-strike greeks
  // (same Black-Scholes pass Agent 09 uses — no second Greeks engine).
  let strikeByDelta: number | null = null;
  const g = bridgeGreeks(ctx, ctx.vix || undefined);
  if (g && g.perStrike.length > 0) {
    const cands = g.perStrike.filter(p => p.CE);
    if (cands.length > 0) {
      const best = cands.reduce((a, b) =>
        Math.abs(b.CE!.delta - 0.5) < Math.abs(a.CE!.delta - 0.5) ? b : a);
      strikeByDelta = best.strike;
      evidence.push(`Strike by 0.50-delta: ${best.strike} (CE Δ${best.CE!.delta.toFixed(3)})`);
    }
  }

  if (atmStrikeData) {
    const ceLTP = atmStrikeData.ce?.ltp || 0;
    const peLTP = atmStrikeData.pe?.ltp || 0;
    const ceVolume = atmStrikeData.ce?.volume || 0;
    const peVolume = atmStrikeData.pe?.volume || 0;
    const ceOI = atmStrikeData.ce?.oi || 0;
    const peOI = atmStrikeData.pe?.oi || 0;

    evidence.push(`ATM Strike: ${atmStrike}`);
    evidence.push(`CE: ₹${ceLTP}, Vol: ${ceVolume.toLocaleString()}, OI: ${ceOI.toLocaleString()}`);
    evidence.push(`PE: ₹${peLTP}, Vol: ${peVolume.toLocaleString()}, OI: ${peOI.toLocaleString()}`);

    // Check liquidity
    if (ceVolume < 1000) riskFlags.push('CE volume low — may have wide spread');
    if (peVolume < 1000) riskFlags.push('PE volume low — may have wide spread');
  }

  return createOutput(def, ctx, {
    observation: `ATM: ${atmStrike}, Strikes: ${ctx.strikes.length}${strikeByDelta !== null ? `, 0.50Δ strike: ${strikeByDelta}` : ''}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Strike selection requires established direction first',
    data: { atmStrike, strikeCount: ctx.strikes.length, strikeByDelta },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 15 — EXPIRY/THETA
// Analyzes: expiry, time remaining, theta decay, liquidity
// Source: hermes context, expiry-calculator
// ═══════════════════════════════════════════════════════════════════

async function analyzeExpiryTheta(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'EXPIRY_THETA')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const dte = ctx.daysToExpiry || 0;
  const theta = ctx.atmTheta || 0;

  evidence.push(`Days to expiry: ${dte}`);
  evidence.push(`ATM Theta: ${theta.toFixed(2)}`);

  if (dte <= 0) {
    evidence.push('EXPIRED — no trade possible');
    return createOutput(def, ctx, {
      observation: 'Contract expired',
      bias: 'NO_DATA', confidence: 0,
      recommendationContext: 'NO_TRADE', recommendationReason: 'Expired',
    });
  }

  if (dte <= 2) {
    evidence.push('Very close to expiry — extreme theta decay');
    riskFlags.push('0DTE/1DTE — high gamma risk');
    confidence = 40;
  } else if (dte <= 5) {
    evidence.push('Near expiry — significant theta decay');
    confidence = 45;
  } else if (dte <= 10) {
    evidence.push('Moderate time to expiry — manageable theta');
    confidence = 55;
  } else {
    evidence.push('Sufficient time to expiry — low theta impact');
    confidence = 60;
  }

  return createOutput(def, ctx, {
    observation: `DTE: ${dte}, Theta: ${theta.toFixed(2)}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: dte >= 3 ? 'TRADE' : 'WAIT',
    recommendationReason: `DTE ${dte} — ${dte <= 2 ? 'too close' : 'acceptable'}`,
    data: { dte, theta },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 16 — ZERO HERO
// Analyzes: 0DTE opportunities, gamma, acceleration, volume
// Source: zero-hero.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeZeroHero(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'ZERO_HERO')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  const dte = ctx.daysToExpiry || 99;
  if (dte > 1) {
    return createOutput(def, ctx, {
      observation: `Not expiry day (DTE: ${dte}) — Zero Hero not applicable`,
      bias: 'NEUTRAL', confidence: 30,
      recommendationContext: 'RESEARCH_ONLY',
      recommendationReason: 'Zero Hero only applies on expiry day',
    });
  }

  // Expiry day analysis
  evidence.push('EXPIRY DAY — 0DTE opportunity window');
  const priceChange = ctx.spot - ctx.prevClose;
  const priceChangePct = ctx.prevClose > 0 ? (priceChange / ctx.prevClose) * 100 : 0;

  if (Math.abs(priceChangePct) > 1) {
    evidence.push(`Strong move today: ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`);
    evidence.push('Explosive potential for 0DTE options');
    bias = priceChangePct > 0 ? 'BULLISH' : 'BEARISH';
    confidence = 65;
  } else {
    evidence.push(`Muted move: ${priceChangePct.toFixed(2)}%`);
    confidence = 40;
  }

  riskFlags.push('0DTE is extremely high risk — size accordingly');
  riskFlags.push('Gamma risk is extreme on expiry day');

  return createOutput(def, ctx, {
    observation: `Zero Hero: DTE=${dte}, Move=${priceChangePct.toFixed(2)}%`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 60 ? 'TRADE' : 'WAIT',
    recommendationReason: `Expiry day with ${priceChangePct.toFixed(2)}% move`,
    data: { dte, priceChangePct },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 17 — CAS
// Analyzes: CAS session, expected move, compression, expansion
// Source: cas-straddle-strategy-v2.ts, cas-time-engine.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeCAS(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'CAS')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 45;

  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const isCasWindow = mins >= 900 && mins <= 930; // 15:00-15:30

  if (isCasWindow) {
    evidence.push('CAS window active (15:00-15:30)');
    evidence.push('Institutional order flow expected');
    confidence = 55;
  } else if (mins > 930) {
    evidence.push('Post-CAS — institutional orders absorbed');
    confidence = 45;
  } else {
    evidence.push('Pre-CAS — CAS context not yet relevant');
    confidence = 35;
  }

  return createOutput(def, ctx, {
    observation: `CAS: ${isCasWindow ? 'Active' : mins > 930 ? 'Post' : 'Pre'}`,
    bias,
    confidence,
    evidence,
    riskFlags: ['CAS produces research context, not direct trade signals'],
    recommendationContext: isCasWindow ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: isCasWindow ? 'CAS window — institutional flow active' : 'Outside CAS window',
    data: { isCasWindow, minutes: mins },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 18 — MARKET STRUCTURE
// Analyzes: HH/HL/LH/LL, BOS, CHOCH, displacement, liquidity sweep
// Source: market-structure-engine.ts, /api/sdm-signal
// ═══════════════════════════════════════════════════════════════════

async function analyzeMarketStructure(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'MARKET_STRUCTURE')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const trend = ctx.trend || 'SIDEWAYS';
  const lastEvent = ctx.lastEvent || 'NONE';

  if (trend === 'UP') {
    evidence.push('Structure: Bullish (HH + HL)');
    bias = 'BULLISH';
    confidence = 60;
  } else if (trend === 'DOWN') {
    evidence.push('Structure: Bearish (LH + LL)');
    bias = 'BEARISH';
    confidence = 60;
  } else {
    evidence.push('Structure: Sideways — no clear HH/HL/LH/LL');
    confidence = 40;
  }

  if (lastEvent !== 'NONE') {
    evidence.push(`Last structural event: ${lastEvent}`);
    if (lastEvent === 'BOS_UP' || lastEvent === 'CHOCH_UP') {
      bias = 'BULLISH';
      confidence = Math.max(confidence, 65);
    } else if (lastEvent === 'BOS_DOWN' || lastEvent === 'CHOCH_DOWN') {
      bias = 'BEARISH';
      confidence = Math.max(confidence, 65);
    }
  }

  if (ctx.swingHigh > 0 && ctx.swingLow > 0) {
    evidence.push(`Swing High: ${ctx.swingHigh}, Swing Low: ${ctx.swingLow}`);
  }

  return createOutput(def, ctx, {
    observation: `Structure: ${trend}, Event: ${lastEvent}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: `Market structure: ${trend}`,
    data: { trend, lastEvent, swingHigh: ctx.swingHigh, swingLow: ctx.swingLow },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 19 — SUPPORT/RESISTANCE
// Analyzes: PDH/PDL, OI walls, gamma zones, swing levels
// Source: market-structure, OI analysis, gamma
// ═══════════════════════════════════════════════════════════════════

async function analyzeSupportResistance(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'SUPPORT_RESISTANCE')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // v2 §2 — jarvis levels.buildLevels: OI walls, max pain, confluence zones,
  // expected-move bands (pure mapping of the snapshot chain — no extra fetch)
  const lv = bridgeLevels(ctx);
  if (lv) {
    const L = lv.levels;
    if (L.oiSupport) evidence.push(`OI support: ${L.oiSupport}${L.oiSupport2 ? ` / ${L.oiSupport2}` : ''}`);
    if (L.oiResistance) evidence.push(`OI resistance: ${L.oiResistance}${L.oiResistance2 ? ` / ${L.oiResistance2}` : ''}`);
    if (L.maxPain) evidence.push(`Max pain: ${L.maxPain}`);
    for (const z of lv.confluenceZones.slice(0, 2)) {
      evidence.push(`Confluence zone ${z.priceRange[0]}-${z.priceRange[1]} (${z.strength} levels)`);
    }
    if (lv.levelsNearSpot.length > 0) {
      evidence.push(`Levels within 0.2% of spot: ${lv.levelsNearSpot.join(', ')}`);
      confidence += 5;
    }
    if (lv.confluenceZones.some(z => ctx.spot >= z.priceRange[0] && ctx.spot <= z.priceRange[1])) {
      evidence.push('Spot sits inside a confluence zone');
      confidence += 5;
    }
  }

  const pdh = ctx.pdh || 0;
  const pdl = ctx.pdl || 0;
  const spot = ctx.spot;

  // PDH/PDL
  if (pdh > 0) evidence.push(`PDH: ${pdh}`);
  if (pdl > 0) evidence.push(`PDL: ${pdl}`);
  if (pdh > 0 && spot > pdh) {
    evidence.push('Price above PDH — bullish breakout');
    bias = 'BULLISH';
    confidence = 60;
  } else if (pdl > 0 && spot < pdl) {
    evidence.push('Price below PDL — bearish breakdown');
    bias = 'BEARISH';
    confidence = 60;
  }

  // Support levels
  if (ctx.supportLevels.length > 0) {
    evidence.push(`Support: ${ctx.supportLevels.join(', ')}`);
    const nearestSupport = ctx.supportLevels.filter(s => s < spot).pop();
    if (nearestSupport) {
      const distPct = ((spot - nearestSupport) / spot) * 100;
      evidence.push(`Nearest support: ${nearestSupport} (${distPct.toFixed(1)}% below)`);
    }
  }

  // Resistance levels
  if (ctx.resistanceLevels.length > 0) {
    evidence.push(`Resistance: ${ctx.resistanceLevels.join(', ')}`);
  }

  return createOutput(def, ctx, {
    observation: `S/R: PDH ${pdh}, PDL ${pdl}, Supports: ${ctx.supportLevels.length}, Resistances: ${ctx.resistanceLevels.length}${lv ? `, OI walls ${lv.levels.oiSupport ?? '?'}/${lv.levels.oiResistance ?? '?'}` : ''}`,
    bias,
    confidence: Math.min(confidence, 80),
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'S/R levels define trade zones',
    data: {
      pdh, pdl, supports: ctx.supportLevels, resistances: ctx.resistanceLevels,
      jarvisLevels: lv ? {
        oiSupport: lv.levels.oiSupport, oiResistance: lv.levels.oiResistance,
        maxPain: lv.levels.maxPain, confluenceZones: lv.confluenceZones.length,
        expMoveUp: lv.levels.expMoveUp, expMoveDown: lv.levels.expMoveDown,
      } : null,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 20 — VWAP
// Analyzes: price vs VWAP, VWAP reclaim/rejection, slope, distance
// Source: vwap-engine.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeVWAP(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'VWAP')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // Use POC as VWAP proxy
  const vwap = ctx.poc || 0;
  if (vwap <= 0) {
    return createOutput(def, ctx, {
      observation: 'VWAP/POC data unavailable',
      bias: 'NO_DATA', confidence: 0, dataFreshness: 'MISSING',
      recommendationContext: 'RESEARCH_ONLY', recommendationReason: 'No VWAP data',
    });
  }

  const spot = ctx.spot;
  const distancePct = ((spot - vwap) / vwap) * 100;

  if (spot > vwap) {
    evidence.push(`Price above VWAP by ${distancePct.toFixed(2)}%`);
    evidence.push('Bullish — buyers in control');
    bias = 'BULLISH';
    confidence = 60;
    if (distancePct > 1) evidence.push('Extended above VWAP — reversion risk');
  } else if (spot < vwap) {
    evidence.push(`Price below VWAP by ${Math.abs(distancePct).toFixed(2)}%`);
    evidence.push('Bearish — sellers in control');
    bias = 'BEARISH';
    confidence = 60;
    if (distancePct < -1) evidence.push('Extended below VWAP — bounce risk');
  } else {
    evidence.push('Price at VWAP — neutral');
  }

  return createOutput(def, ctx, {
    observation: `VWAP: ${vwap}, Spot: ${spot}, Distance: ${distancePct.toFixed(2)}%`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: `VWAP position: ${spot > vwap ? 'above' : spot < vwap ? 'below' : 'at'}`,
    data: { vwap, distancePct },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 21 — VOLUME / VOLUME PROFILE
// Analyzes: volume expansion/contraction, POC, VAH, VAL, absorption
// Source: volume-analysis.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeVolume(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'VOLUME')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const vol = ctx.volume || 0;
  const poc = ctx.poc || 0;
  const vah = ctx.vah || 0;
  const val = ctx.val || 0;

  if (vol > 0) {
    evidence.push(`Volume: ${vol.toLocaleString()}`);
  }

  if (poc > 0) {
    evidence.push(`POC: ${poc}`);
    if (ctx.spot > poc) {
      evidence.push('Price above POC — bullish acceptance');
      bias = 'BULLISH';
      confidence = 55;
    } else if (ctx.spot < poc) {
      evidence.push('Price below POC — bearish acceptance');
      bias = 'BEARISH';
      confidence = 55;
    }
  }

  if (vah > 0 && val > 0) {
    evidence.push(`Value Area: ${val} - ${vah}`);
    if (ctx.spot > vah) evidence.push('Above value area — trend move');
    else if (ctx.spot < val) evidence.push('Below value area — trend move');
    else evidence.push('Inside value area — balance');
  }

  return createOutput(def, ctx, {
    observation: `Volume: ${vol}, POC: ${poc}, VAH: ${vah}, VAL: ${val}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'RESEARCH_ONLY',
    recommendationReason: 'Volume confirms price action',
    data: { vol, poc, vah, val },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 22 — BREAKOUT / FAKEOUT
// Analyzes: breakout confirmation, volume, retest, false breakout
// Source: breakout-engine, market structure
// ═══════════════════════════════════════════════════════════════════

async function analyzeBreakout(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'BREAKOUT')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 45;

  const spot = ctx.spot;
  const pdh = ctx.pdh;
  const pdl = ctx.pdl;

  if (pdh > 0 && spot > pdh) {
    evidence.push(`Price ${spot} above PDH ${pdh} — potential breakout`);
    if (ctx.volume > 0) {
      evidence.push('Volume confirmation available');
      confidence = 60;
    } else {
      riskFlags.push('No volume confirmation — possible fakeout');
      confidence = 40;
    }
    bias = 'BULLISH';
  } else if (pdl > 0 && spot < pdl) {
    evidence.push(`Price ${spot} below PDL ${pdl} — potential breakdown`);
    if (ctx.volume > 0) {
      evidence.push('Volume confirmation available');
      confidence = 60;
    } else {
      riskFlags.push('No volume confirmation — possible fakeout');
      confidence = 40;
    }
    bias = 'BEARISH';
  } else {
    evidence.push('No breakout — price within range');
  }

  return createOutput(def, ctx, {
    observation: `Breakout: ${spot > pdh ? 'Above PDH' : spot < pdl ? 'Below PDL' : 'In range'}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: `Breakout ${confidence >= 55 ? 'confirmed' : 'unconfirmed'}`,
    data: { pdh, pdl, spot },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 23 — MTF CONFIRMATION
// Analyzes: multi-timeframe indicator alignment
// Source: mtf-signal-engine.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeMTFConfirmation(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'MTF_CONFIRMATION')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // Use trend as MTF proxy
  const trend = ctx.trend || 'SIDEWAYS';
  if (trend === 'UP') {
    evidence.push('Higher timeframe trend: UP');
    bias = 'BULLISH';
    confidence = 60;
  } else if (trend === 'DOWN') {
    evidence.push('Higher timeframe trend: DOWN');
    bias = 'BEARISH';
    confidence = 60;
  } else {
    evidence.push('Higher timeframe trend: SIDEWAYS — no MTF confirmation');
    confidence = 40;
  }

  // Check for structural confirmation
  if (ctx.lastEvent === 'BOS_UP' || ctx.lastEvent === 'CHOCH_UP') {
    evidence.push(`Structure confirms: ${ctx.lastEvent}`);
    confidence = Math.max(confidence, 65);
  } else if (ctx.lastEvent === 'BOS_DOWN' || ctx.lastEvent === 'CHOCH_DOWN') {
    evidence.push(`Structure confirms: ${ctx.lastEvent}`);
    confidence = Math.max(confidence, 65);
  }

  return createOutput(def, ctx, {
    observation: `MTF: Trend ${trend}, Structure ${ctx.lastEvent}`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: `MTF ${confidence >= 55 ? 'confirmed' : 'not confirmed'}`,
    data: { trend, lastEvent: ctx.lastEvent },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 24 — MOMENTUM
// Analyzes: price momentum, acceleration, divergence
// Source: ml-engine.ts (RSI, Bollinger, EMA, ADX)
// ═══════════════════════════════════════════════════════════════════

async function analyzeMomentum(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'MOMENTUM')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const priceChange = ctx.spot - ctx.prevClose;
  const priceChangePct = ctx.prevClose > 0 ? (priceChange / ctx.prevClose) * 100 : 0;

  if (Math.abs(priceChangePct) > 1) {
    evidence.push(`Strong momentum: ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`);
    bias = priceChangePct > 0 ? 'BULLISH' : 'BEARISH';
    confidence = 65;
  } else if (Math.abs(priceChangePct) > 0.3) {
    evidence.push(`Moderate momentum: ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`);
    bias = priceChangePct > 0 ? 'BULLISH' : 'BEARISH';
    confidence = 55;
  } else {
    evidence.push(`Low momentum: ${priceChangePct.toFixed(2)}%`);
    confidence = 40;
  }

  return createOutput(def, ctx, {
    observation: `Momentum: ${priceChangePct.toFixed(2)}%`,
    bias,
    confidence,
    evidence,
    riskFlags: [],
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: `Momentum ${Math.abs(priceChangePct) > 0.3 ? 'present' : 'weak'}`,
    data: { priceChangePct },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 25 — ATR / VOLATILITY
// Analyzes: ATR, expected move, stop distance, target feasibility
// Source: yahoo-finance-api.ts (getRealATR14)
// ═══════════════════════════════════════════════════════════════════

async function analyzeATR(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'ATR')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  // v2 §2 — jarvis 1σ expected move from the ATM straddle (real chain math)
  const g = bridgeGreeks(ctx, ctx.vix || undefined);
  if (g) {
    const expPct = ctx.spot > 0 ? (g.expectedMove1Sigma / ctx.spot) * 100 : 0;
    evidence.push(`1σ expected move (jarvis): ±${g.expectedMove1Sigma} (${expPct.toFixed(2)}% of spot)`);
    for (const fl of g.gatesFailed) riskFlags.push(fl);
    for (const n of g.notes.slice(0, 3)) evidence.push(n);
  }

  const atr = (ctx.rawContext as any)?.atr || 0;
  if (atr > 0) {
    const atrPct = ctx.spot > 0 ? (atr / ctx.spot) * 100 : 0;
    evidence.push(`ATR: ${atr.toFixed(2)} (${atrPct.toFixed(2)}% of spot)`);

    if (atrPct > 2) {
      evidence.push('High volatility — wider stops needed');
      riskFlags.push('High ATR — reduce position size');
    } else if (atrPct < 0.5) {
      evidence.push('Low volatility — tight stops possible');
    }
  } else if (!g) {
    evidence.push('ATR data unavailable');
  }

  return createOutput(def, ctx, {
    observation: `ATR: ${atr || 'N/A'}${g ? `, 1σ: ±${g.expectedMove1Sigma}` : ''}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'ATR informs stop loss and position sizing',
    data: { atr, expectedMove1Sigma: g?.expectedMove1Sigma ?? null, hoursToExpiry: g?.hoursToExpiry ?? null },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 26 — NEWS
// Analyzes: market news, company news, macro events
// Source: /api/news, sentiment-analyzer.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeNews(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'NEWS')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  if (ctx.newsSentiment && ctx.newsSentiment !== 'NEUTRAL') {
    evidence.push(`News sentiment: ${ctx.newsSentiment} (score: ${ctx.newsScore})`);
    bias = ctx.newsSentiment === 'BULLISH' ? 'BULLISH' : 'BEARISH';
    confidence = 50;
  } else {
    evidence.push('News sentiment neutral or unavailable');
  }

  if (ctx.headlines.length > 0) {
    evidence.push(`Headlines: ${ctx.headlines.slice(0, 3).join('; ')}`);
  }

  // v2 §2 — signed jarvis news scale via the shared adapters helper
  const signed = bridgeNewsSigned(ctx);
  if (signed !== null) {
    evidence.push(`Signed news score (jarvis -100..+100): ${signed}`);
    if (Math.abs(signed) >= 40) {
      if (signed > 0 && bias === 'NEUTRAL') bias = 'BULLISH';
      if (signed < 0 && bias === 'NEUTRAL') bias = 'BEARISH';
      confidence = Math.max(confidence, 50);
    }
  }

  return createOutput(def, ctx, {
    observation: `News: ${ctx.newsSentiment || 'Neutral'}`,
    bias,
    confidence,
    evidence,
    riskFlags: ['News is contextual — never trade on headlines alone'],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'News provides context, not trade signals',
    data: { sentiment: ctx.newsSentiment, score: ctx.newsScore, signedScore: signed },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 27 — EVENT RISK
// Detects: RBI, Fed, earnings, elections, macro announcements
// Source: market-session.ts, expiry calendar
// ═══════════════════════════════════════════════════════════════════

async function analyzeEventRisk(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'EVENT_RISK')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 50;

  const dte = ctx.daysToExpiry || 0;
  if (dte <= 2) {
    evidence.push('Near expiry — elevated event risk');
    riskFlags.push('Expiry week — higher volatility expected');
    confidence = 45;
  }

  // Check if it's an expiry day
  const now = new Date();
  const day = now.getDay();
  if (day === 4) { // Thursday
    evidence.push('Thursday — expiry day for indices');
    riskFlags.push('Expiry day — gamma risk elevated');
    confidence = 40;
  }

  return createOutput(def, ctx, {
    observation: `Event risk: DTE=${dte}, Day=${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: riskFlags.length > 0 ? 'WAIT' : 'RESEARCH_ONLY',
    recommendationReason: riskFlags.length > 0 ? 'Event risk elevated' : 'No major events detected',
    data: { dte, dayOfWeek: day },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 28 — SENTIMENT
// Analyzes: market sentiment, news sentiment, positioning
// Source: sentiment-analyzer.ts, news
// ═══════════════════════════════════════════════════════════════════

async function analyzeSentiment(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'SENTIMENT')!;
  const evidence: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  if (ctx.newsSentiment === 'BULLISH') {
    evidence.push('Market sentiment: Bullish');
    bias = 'BULLISH';
    confidence = 50;
  } else if (ctx.newsSentiment === 'BEARISH') {
    evidence.push('Market sentiment: Bearish');
    bias = 'BEARISH';
    confidence = 50;
  } else {
    evidence.push('Market sentiment: Neutral');
  }

  // v2 §2 — signed jarvis news scale: magnitude scales conviction, sign
  // only breaks a NEUTRAL tie (never overrides an explicit sentiment)
  const signed = bridgeNewsSigned(ctx);
  if (signed !== null) {
    evidence.push(`Sentiment score (jarvis signed): ${signed}`);
    confidence = Math.min(confidence + Math.round(Math.abs(signed) / 4), 70);
    if (signed >= 40 && bias === 'NEUTRAL') bias = 'BULLISH';
    if (signed <= -40 && bias === 'NEUTRAL') bias = 'BEARISH';
  }

  return createOutput(def, ctx, {
    observation: `Sentiment: ${ctx.newsSentiment || 'Neutral'}`,
    bias,
    confidence,
    evidence,
    riskFlags: ['Sentiment is contextual only — not a trade trigger'],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'Sentiment provides market mood context',
    data: { sentiment: ctx.newsSentiment, score: ctx.newsScore, signedScore: signed },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 29 — BTST
// Analyzes: end-of-day structure, volume, trend, overnight risk
// Source: btst-scanner.ts
// ═══════════════════════════════════════════════════════════════════

async function analyzeBTST(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'BTST')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 40;

  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const isEndOfDay = mins >= 900; // After 15:00

  if (!isEndOfDay) {
    return createOutput(def, ctx, {
      observation: 'BTST analysis only relevant near market close',
      bias: 'NEUTRAL', confidence: 30,
      recommendationContext: 'RESEARCH_ONLY',
      recommendationReason: 'Not end of day',
    });
  }

  const trend = ctx.trend || 'SIDEWAYS';
  const priceChangePct = ctx.prevClose > 0 ? ((ctx.spot - ctx.prevClose) / ctx.prevClose) * 100 : 0;

  evidence.push(`End-of-day analysis for ${ctx.symbol}`);
  evidence.push(`Trend: ${trend}, Day change: ${priceChangePct.toFixed(2)}%`);

  if (trend === 'UP' && priceChangePct > 0.5) {
    evidence.push('Bullish close — potential BTST candidate');
    bias = 'BULLISH';
    confidence = 55;
  } else if (trend === 'DOWN' && priceChangePct < -0.5) {
    evidence.push('Bearish close — potential short BTST');
    bias = 'BEARISH';
    confidence = 55;
  }

  riskFlags.push('BTST carries overnight gap risk');

  return createOutput(def, ctx, {
    observation: `BTST: Trend ${trend}, Change ${priceChangePct.toFixed(2)}%`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: `BTST ${confidence >= 55 ? 'candidate' : 'not ready'}`,
    data: { trend, priceChangePct },
  });
}

// ═══════════════════════════════════════════════════════════════════
// AGENT 30 — COMMODITY / MCX
// Analyzes: CRUDEOIL, GOLD, SILVER, NATURALGAS — price, trend, VWAP
// Source: mcx/mcx-intelligence.ts, mcx/ module
// ═══════════════════════════════════════════════════════════════════

async function analyzeCommodityMCX(ctx: AgentContext): Promise<AgentResearchOutput> {
  const def = REGISTRY.find(a => a.id === 'COMMODITY_MCX')!;
  const evidence: string[] = [];
  const riskFlags: string[] = [];
  let bias: AgentBias = 'NEUTRAL';
  let confidence = 45;

  if (ctx.exchange !== 'MCX') {
    return createOutput(def, ctx, {
      observation: 'MCX agent — not a commodity instrument',
      bias: 'NEUTRAL', confidence: 30,
      recommendationContext: 'RESEARCH_ONLY',
      recommendationReason: 'Not MCX',
    });
  }

  const mcxIntel = (ctx.rawContext as any)?.mcxIntelligence;
  if (mcxIntel) {
    evidence.push(`MCX Regime: ${mcxIntel.regime}`);
    evidence.push(`Structure: ${mcxIntel.structureBias}`);
    evidence.push(`OI: ${mcxIntel.oiClassification}`);
    evidence.push(`Volume: ${mcxIntel.volumeState}`);

    if (mcxIntel.bestCandidateDirection === 'LONG') {
      bias = 'BULLISH';
      confidence = Math.min(70, mcxIntel.bestCandidateScore || 50);
    } else if (mcxIntel.bestCandidateDirection === 'SHORT') {
      bias = 'BEARISH';
      confidence = Math.min(70, mcxIntel.bestCandidateScore || 50);
    }
  } else {
    evidence.push(`MCX spot: ${ctx.spot}`);
    const priceChangePct = ctx.prevClose > 0 ? ((ctx.spot - ctx.prevClose) / ctx.prevClose) * 100 : 0;
    evidence.push(`Change: ${priceChangePct.toFixed(2)}%`);
    if (Math.abs(priceChangePct) > 1) {
      bias = priceChangePct > 0 ? 'BULLISH' : 'BEARISH';
      confidence = 55;
    }
  }

  riskFlags.push('MCX allows BUY and SELL');

  return createOutput(def, ctx, {
    observation: `MCX ${ctx.symbol}: Spot ${ctx.spot}`,
    bias,
    confidence,
    evidence,
    riskFlags,
    recommendationContext: confidence >= 55 ? 'TRADE' : 'WAIT',
    recommendationReason: `MCX analysis for ${ctx.symbol}`,
    data: { mcxIntel },
  });
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRY — All 30 agents
// ═══════════════════════════════════════════════════════════════════

export const REGISTRY: AgentDefinition[] = [
  { id: 'MARKET_REGIME', name: 'Market Regime', category: 'MARKET', description: 'Bullish/bearish/range regime, trend strength, volatility', supportedInstruments: ['ALL'], dataSources: ['/api/market/regime'], requiredInputs: ['regime', 'regimeBias', 'regimeConfidence'], analysisFn: analyzeMarketRegime },
  { id: 'FII_DII', name: 'FII/DII', category: 'FLOW', description: 'FII cash activity, DII activity, institutional positioning', supportedInstruments: ['ALL'], dataSources: ['/api/fii-dii'], requiredInputs: ['fiiNet', 'diiNet', 'fiiBias'], analysisFn: analyzeFIIDII },
  { id: 'GLOBAL_MARKET', name: 'Global Market', category: 'CONTEXT', description: 'US indices, Asian markets, overnight risk', supportedInstruments: ['ALL'], dataSources: ['yahoo-finance-api', '/api/news'], requiredInputs: ['newsSentiment', 'headlines'], analysisFn: analyzeGlobalMarket },
  { id: 'INDIA_VIX', name: 'India VIX', category: 'VOLATILITY', description: 'VIX level, trend, volatility regime, premium environment', supportedInstruments: ['INDEX'], dataSources: ['option-chain-summary'], requiredInputs: ['vix'], analysisFn: analyzeIndiaVIX },
  { id: 'MARKET_BREADTH', name: 'Market Breadth', category: 'MARKET', description: 'Advances, declines, A/D ratio, breadth trend', supportedInstruments: ['INDEX'], dataSources: ['/api/market/breadth'], requiredInputs: ['trend', 'volume', 'spot', 'pdh', 'pdl'], analysisFn: analyzeMarketBreadth },
  { id: 'SECTOR_ROTATION', name: 'Sector Rotation', category: 'MARKET', description: 'Leading/weak sectors, sector momentum, NIFTY contribution', supportedInstruments: ['ALL'], dataSources: ['/api/market/heatmap'], requiredInputs: ['symbol'], analysisFn: analyzeSectorRotation },
  { id: 'OI_PCR', name: 'OI/PCR', category: 'OPTIONS', description: 'CE OI, PE OI, OI change, PCR, max pain, support/resistance from OI', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['sdm-oianalysis', 'option-chain'], requiredInputs: ['optionChain', 'spot'], analysisFn: analyzeOIPCR },
  { id: 'OI_CLASSIFICATION', name: 'OI Classification', category: 'OPTIONS', description: 'Long build-up, short build-up, short covering, long unwinding', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['oi-classification-engine'], requiredInputs: ['optionChain', 'spot', 'prevClose'], analysisFn: analyzeOIClassification },
  { id: 'GREEKS', name: 'Greeks', category: 'OPTIONS', description: 'Delta, Gamma, Theta, Vega, IV — option sensitivity', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['greeks.ts', 'option-chain'], requiredInputs: ['atmDelta', 'atmGamma', 'atmTheta', 'atmVega', 'atmIV'], analysisFn: analyzeGreeks },
  { id: 'GAMMA', name: 'Gamma', category: 'OPTIONS', description: 'Gamma concentration, walls, positive/negative zones, dealer bias', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['hermes-gamma', 'option-chain'], requiredInputs: ['gammaDetected', 'gammaWallStrike', 'gammaFlip', 'dealerBias'], analysisFn: analyzeGamma },
  { id: 'IV_HV', name: 'IV/HV', category: 'VOLATILITY', description: 'IV, historical volatility, IV/HV relationship, expansion/contraction', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['greeks.ts', 'option-chain'], requiredInputs: ['atmIV', 'vix'], analysisFn: analyzeIVHV },
  { id: 'OPTION_ACCELERATION', name: 'Option Acceleration', category: 'OPTIONS', description: 'Premium movement, delta response, volume acceleration', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['option-acceleration-engine'], requiredInputs: ['spot', 'prevClose', 'volume'], analysisFn: analyzeOptionAcceleration },
  { id: 'BUYER_CONFLUENCE', name: 'Option Buyer Confluence', category: 'OPTIONS', description: 'Option BUY conditions alignment — underlying direction, volume, IV, Greeks', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['buyer-confluence-engine'], requiredInputs: ['vix', 'trend', 'volume', 'atmIV'], analysisFn: analyzeBuyerConfluence },
  { id: 'STRIKE_SELECTION', name: 'Strike Selection', category: 'OPTIONS', description: 'ATM/ITM/OTM, delta, liquidity, spread, premium — select optimal strike', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['hermes-strike-selector', 'option-chain'], requiredInputs: ['strikes', 'optionChain'], analysisFn: analyzeStrikeSelection },
  { id: 'EXPIRY_THETA', name: 'Expiry/Theta', category: 'OPTIONS', description: 'Expiry proximity, theta decay, time remaining, premium decay risk', supportedInstruments: ['INDEX', 'STOCK_OPTION'], dataSources: ['expiry-calculator', 'hermes-context'], requiredInputs: ['daysToExpiry', 'atmTheta'], analysisFn: analyzeExpiryTheta },
  { id: 'ZERO_HERO', name: 'Zero Hero', category: 'OPTIONS', description: '0DTE expiry-day opportunities, gamma, acceleration, explosive potential', supportedInstruments: ['INDEX'], dataSources: ['zero-hero.ts'], requiredInputs: ['daysToExpiry', 'spot', 'prevClose', 'volume'], analysisFn: analyzeZeroHero },
  { id: 'CAS', name: 'CAS', category: 'OPTIONS', description: 'CAS session analysis — institutional order flow, expected move, compression', supportedInstruments: ['INDEX'], dataSources: ['cas-straddle-strategy-v2', 'cas-time-engine'], requiredInputs: ['symbol'], analysisFn: analyzeCAS },
  { id: 'MARKET_STRUCTURE', name: 'Market Structure', category: 'STRUCTURE', description: 'HH/HL/LH/LL, BOS, CHOCH, displacement, liquidity sweep', supportedInstruments: ['ALL'], dataSources: ['market-structure-engine', '/api/sdm-signal'], requiredInputs: ['trend', 'swingHigh', 'swingLow', 'lastEvent'], analysisFn: analyzeMarketStructure },
  { id: 'SUPPORT_RESISTANCE', name: 'Support/Resistance', category: 'STRUCTURE', description: 'PDH/PDL, OI walls, gamma zones, swing levels, opening range', supportedInstruments: ['ALL'], dataSources: ['market-structure', 'oi-analysis', 'gamma'], requiredInputs: ['spot', 'pdh', 'pdl', 'supportLevels', 'resistanceLevels'], analysisFn: analyzeSupportResistance },
  { id: 'VWAP', name: 'VWAP', category: 'STRUCTURE', description: 'Price vs VWAP, reclaim, rejection, slope, distance', supportedInstruments: ['ALL'], dataSources: ['vwap-engine'], requiredInputs: ['spot', 'poc'], analysisFn: analyzeVWAP },
  { id: 'VOLUME', name: 'Volume/Volume Profile', category: 'VOLUME', description: 'Volume expansion, POC, VAH, VAL, absorption, rejection', supportedInstruments: ['ALL'], dataSources: ['volume-analysis'], requiredInputs: ['volume', 'poc', 'vah', 'val', 'spot'], analysisFn: analyzeVolume },
  { id: 'BREAKOUT', name: 'Breakout/Fakeout', category: 'STRUCTURE', description: 'Breakout confirmation, volume, retest, false breakout detection', supportedInstruments: ['ALL'], dataSources: ['breakout-engine', 'market-structure'], requiredInputs: ['spot', 'pdh', 'pdl', 'volume'], analysisFn: analyzeBreakout },
  { id: 'MTF_CONFIRMATION', name: 'MTF Confirmation', category: 'SIGNALS', description: 'Multi-timeframe indicator alignment — 15M→5M→3M confirmation', supportedInstruments: ['ALL'], dataSources: ['mtf-signal-engine'], requiredInputs: ['trend', 'lastEvent'], analysisFn: analyzeMTFConfirmation },
  { id: 'MOMENTUM', name: 'Momentum', category: 'SIGNALS', description: 'Price momentum, acceleration, trend strength, divergence', supportedInstruments: ['ALL'], dataSources: ['ml-engine'], requiredInputs: ['spot', 'prevClose'], analysisFn: analyzeMomentum },
  { id: 'ATR', name: 'ATR/Volatility', category: 'RISK', description: 'ATR, expected move, stop distance, target feasibility', supportedInstruments: ['ALL'], dataSources: ['yahoo-finance-api-ATR'], requiredInputs: ['spot', 'rawContext'], analysisFn: analyzeATR },
  { id: 'NEWS', name: 'News', category: 'CONTEXT', description: 'Market news, company news, macro events, sentiment', supportedInstruments: ['ALL'], dataSources: ['/api/news', 'sentiment-analyzer'], requiredInputs: ['newsSentiment', 'newsScore', 'headlines'], analysisFn: analyzeNews },
  { id: 'EVENT_RISK', name: 'Event Risk', category: 'CONTEXT', description: 'RBI, Fed, earnings, elections, macro announcements', supportedInstruments: ['ALL'], dataSources: ['market-session', 'expiry-calendar'], requiredInputs: ['daysToExpiry'], analysisFn: analyzeEventRisk },
  { id: 'SENTIMENT', name: 'Sentiment', category: 'CONTEXT', description: 'Market sentiment, news sentiment, positioning sentiment', supportedInstruments: ['ALL'], dataSources: ['sentiment-analyzer', 'news'], requiredInputs: ['newsSentiment', 'newsScore'], analysisFn: analyzeSentiment },
  { id: 'BTST', name: 'BTST', category: 'EQUITY', description: 'End-of-day structure, volume, trend, overnight risk', supportedInstruments: ['STOCK_EQUITY', 'INDEX'], dataSources: ['btst-scanner'], requiredInputs: ['trend', 'spot', 'prevClose'], analysisFn: analyzeBTST },
  { id: 'COMMODITY_MCX', name: 'Commodity/MCX', category: 'MCX', description: 'CRUDEOIL, GOLD, SILVER, NATURALGAS — price, trend, VWAP, structure', supportedInstruments: ['MCX'], dataSources: ['mcx/mcx-intelligence'], requiredInputs: ['spot', 'prevClose', 'exchange', 'rawContext'], analysisFn: analyzeCommodityMCX },
];

// ─── Registry Lookup ──────────────────────────────────────────────

const AGENT_MAP = new Map<AgentId, AgentDefinition>();
for (const agent of REGISTRY) {
  AGENT_MAP.set(agent.id, agent);
}

export function getAgentDef(id: AgentId): AgentDefinition | undefined {
  return AGENT_MAP.get(id);
}

export function getAgentsByCategory(category: AgentCategory): AgentDefinition[] {
  return REGISTRY.filter(a => a.category === category);
}

export function getAgentsForInstrument(instrument: string): AgentDefinition[] {
  return REGISTRY.filter(a =>
    a.supportedInstruments.includes('ALL' as any) ||
    a.supportedInstruments.includes(instrument as any)
  );
}

export function getAllAgentIds(): AgentId[] {
  return REGISTRY.map(a => a.id);
}

export function getAgentCount(): number {
  return REGISTRY.length;
}

// ─── Run All Agents ───────────────────────────────────────────────

export async function runAllAgents(
  ctx: AgentContext,
  agentIds?: AgentId[]
): Promise<AgentResearchOutput[]> {
  const ids = agentIds || getAllAgentIds();
  const results: AgentResearchOutput[] = [];

  for (const id of ids) {
    const def = AGENT_MAP.get(id);
    if (!def) continue;
    try {
      const output = await def.analysisFn(ctx);
      results.push(output);
    } catch (err: any) {
      results.push(createOutput(def, ctx, {
        observation: `ERROR: ${err.message}`,
        bias: 'NO_DATA',
        confidence: 0,
        dataFreshness: 'ERROR',
        riskFlags: [`Agent ${id} failed: ${err.message}`],
        recommendationContext: 'NO_TRADE',
        recommendationReason: `Agent error: ${err.message}`,
      }));
    }
  }

  return results;
}
