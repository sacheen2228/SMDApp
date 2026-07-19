export interface FlowLeg {
  ltp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface FlowStrike {
  strike: number;
  ce: FlowLeg;
  pe: FlowLeg;
  pcr: number;
  maxPain: number;
}

export interface FlowSummary {
  spot: number;
  vix: number;
  indiaVIX: number;
  pcr: number;
  maxPain: number;
  atmStrike: number;
  totalOICE: number;
  totalOIPE: number;
}

interface NormalizedMetrics {
  gamma: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  theta: number;
  vega: number;
  delta: number;
  spread: number;
  depth: number;
}

interface DerivedMetrics {
  gammaExpansion: number;
  gammaAcceleration: number;
  oiVelocity: number;
  oiAcceleration: number;
  volumeSpike: number;
  relativeVolume: number;
  liquidityScore: number;
  marketImpact: number;
  ivRank: number;
  ivPercentile: number;
  ivExpansion: number;
  ivCrushProbability: number;
  dealerLongGamma: number;
  dealerShortGamma: number;
  dealerHedgingPressure: number;
  dealerFlipZone: number;
}

export interface ScoredStrike {
  strike: number;
  type: "CE" | "PE";
  institutionalScore: number;
  gammaScore: number;
  oiFlowScore: number;
  oiChangeScore: number;
  deltaQualityScore: number;
  volumeScore: number;
  vegaScore: number;
  thetaScore: number;
  liquidityScore: number;
  ivScore: number;
  dealerPressureScore: number;
  gammaExpansion: number;
  oiFlow: number;
  volume: number;
  dealerPressure: string;
  signal: string;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  oiChg: number;
  bidAskSpread: number;
  depth: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  tp: number;
  sl: number;
  rr: number;
  normalized: NormalizedMetrics;
  derived: DerivedMetrics;
  meetsBuyConditions: boolean;
  meetsSellConditions: boolean;
}

export interface FlowEngineResult {
  strikes: ScoredStrike[];
  topCalls: ScoredStrike[];
  topPuts: ScoredStrike[];
  bestCallStrike: ScoredStrike | null;
  bestPutStrike: ScoredStrike | null;
  bestGammaStrike: ScoredStrike | null;
  highestOIStrike: ScoredStrike | null;
  highestOIChangeStrike: ScoredStrike | null;
  highestVolumeStrike: ScoredStrike | null;
  highestScoreStrike: ScoredStrike | null;
  timestamp: string;
  symbol: string;
  spot: number;
  atmStrike: number;
}

const HISTORY_TTL_MS = 15 * 60 * 1000;

interface HistoryEntry {
  gamma: number;
  oi: number;
  volume: number;
  iv: number;
  timestamp: number;
}

const strikeHistory = new Map<string, HistoryEntry[]>();

function pushHistory(key: string, entry: HistoryEntry) {
  const arr = strikeHistory.get(key) || [];
  arr.push(entry);
  const cutoff = Date.now() - HISTORY_TTL_MS;
  const filtered = arr.filter((e) => e.timestamp > cutoff);
  strikeHistory.set(key, filtered);
}

function getPrevious(key: string): HistoryEntry | null {
  const arr = strikeHistory.get(key) || [];
  if (arr.length < 2) return null;
  return arr[arr.length - 2];
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return values;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return values.map(() => 50);
  return values.map(((v) => ((v - min) / (max - min)) * 100));
}

function normalizeMetric(strikes: FlowStrike[], extract: (s: FlowStrike) => number): number[] {
  return normalize(strikes.map(extract));
}

function signal(score: number): string {
  if (score >= 95) return "STRONG BUY";
  if (score >= 90) return "BUY";
  if (score >= 80) return "WATCH";
  if (score >= 70) return "WAIT";
  return "IGNORE";
}

function computeTPSL(
  ltp: number,
  gamma: number,
  delta: number,
  theta: number,
  iv: number,
  spot: number,
  strike: number,
  type: "CE" | "PE"
): { tp: number; sl: number; rr: number } {
  if (ltp <= 0) return { tp: 0, sl: 0, rr: 0 };
  const expectedMove = spot * (iv / 100) * Math.sqrt(1 / 365);
  const moneyness = Math.max(0, 1 - Math.abs(strike - spot) / spot);
  const deltaSensitivity = Math.abs(delta) * expectedMove;
  const gammaBoost = 0.5 * gamma * expectedMove * expectedMove;
  const thetaDecay = Math.abs(theta);
  const slLoss = thetaDecay * 2 + ltp * 0.02;
  const sl = Math.max(ltp * 0.75, ltp - Math.min(ltp * 0.25, slLoss));
  const tpGain = (deltaSensitivity + gammaBoost) * Math.max(0.3, moneyness) - thetaDecay * 0.5;
  const tp = ltp + Math.max(ltp * 0.15, tpGain);
  const rr = sl > 0 ? (tp - ltp) / (ltp - sl) : 0;
  return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
}

function heatColor(value: number, max: number): number {
  if (max === 0) return 0;
  return Math.min(100, (value / max) * 100);
}

function computeDerived(
  current: FlowLeg,
  prev: HistoryEntry | null,
  allStrikeGamma: number[],
  allStrikeOI: number[],
  allStrikeVolume: number[],
  allStrikeIV: number[],
  strikeIndex: number
): DerivedMetrics {
  const gamma = current.gamma;
  const oi = current.oi;
  const volume = current.volume;
  const iv = current.iv;

  const prevGamma = prev?.gamma ?? gamma;
  const prevOI = prev?.oi ?? oi;
  const prevVolume = prev?.volume ?? volume;
  const prevIV = prev?.iv ?? iv;

  const gammaRoC = prevGamma !== 0 ? ((gamma - prevGamma) / Math.abs(prevGamma)) * 100 : 0;

  const avgGamma = allStrikeGamma.reduce((a, b) => a + b, 0) / allStrikeGamma.length || 0.001;
  const gammaAcceleration = gammaRoC > 0 && gamma > avgGamma ? gammaRoC : gammaRoC * 0.5;

  const oiDelta = oi - prevOI;
  const avgOI = allStrikeOI.reduce((a, b) => a + b, 0) / allStrikeOI.length || 1;
  const oiVelocity = avgOI !== 0 ? (oiDelta / avgOI) * 100 : 0;

  const prevOIDelta = prev ? prevOI - (prev?.oi ?? prevOI) : 0;
  const oiAcceleration = oiVelocity - (avgOI !== 0 ? (prevOIDelta / avgOI) * 100 : 0);

  const avgVolume = allStrikeVolume.reduce((a, b) => a + b, 0) / allStrikeVolume.length || 1;
  const volumeSpike = avgVolume !== 0 ? ((volume - avgVolume) / avgVolume) * 100 : 0;
  const relativeVolume = avgVolume !== 0 ? volume / avgVolume : 1;

  const spread = current.ask - current.bid;
  const totalDepth = current.bidQty + current.askQty;
  const marketImpact = totalDepth > 0 ? spread / totalDepth : spread;
  const avgSpread = allStrikeGamma.length * 0.5;
  const liquidityScoreVal = spread > 0 ? Math.max(0, 100 - (spread / (avgSpread || 1)) * 50) : 100;

  const sortedIV = [...allStrikeIV].sort((a, b) => a - b);
  const ivRank = sortedIV.length > 0 ? (sortedIV.indexOf(iv) / sortedIV.length) * 100 : 50;
  const ivPercentile = ivRank;
  const ivExpansion = prevIV !== 0 ? ((iv - prevIV) / prevIV) * 100 : 0;
  const ivCrushProbability = ivExpansion > 5 ? Math.min(100, ivExpansion * 5) : Math.max(0, 50 + ivExpansion * 3);

  const ATM = 0.5;
  const distFromATM = Math.abs(strikeIndex / allStrikeGamma.length - 0.5);
  const dealerLongGamma = gamma > 0.001 && distFromATM < 0.2 ? gamma * 1000 : 0;
  const dealerShortGamma = gamma < 0.0005 && distFromATM < 0.3 ? (0.001 - gamma) * 1000 : 0;
  const dealerHedgingPressure = dealerLongGamma + dealerShortGamma;
  const dealerFlipZone = distFromATM < 0.15 && Math.abs(gamma - 0.001) < 0.0005 ? 100 : 0;

  return {
    gammaExpansion: gammaRoC,
    gammaAcceleration,
    oiVelocity,
    oiAcceleration,
    volumeSpike,
    relativeVolume,
    liquidityScore: liquidityScoreVal,
    marketImpact,
    ivRank,
    ivPercentile,
    ivExpansion,
    ivCrushProbability,
    dealerLongGamma,
    dealerShortGamma,
    dealerHedgingPressure,
    dealerFlipZone,
  };
}

export function runGreekFlowEngine(
  strikes: FlowStrike[],
  summary: FlowSummary,
  symbol: string
): FlowEngineResult {
  const allGammaCE = strikes.map((s) => s.ce.gamma);
  const allGammaPE = strikes.map((s) => s.pe.gamma);
  const allOICE = strikes.map((s) => s.ce.oi);
  const allOIPE = strikes.map((s) => s.pe.oi);
  const allVolCE = strikes.map((s) => s.ce.volume);
  const allVolPE = strikes.map((s) => s.pe.volume);
  const allIVCE = strikes.map((s) => s.ce.iv);
  const allIVPE = strikes.map((s) => s.pe.iv);
  const allThetaCE = strikes.map((s) => Math.abs(s.ce.theta));
  const allThetaPE = strikes.map((s) => Math.abs(s.pe.theta));
  const allVegaCE = strikes.map((s) => s.ce.vega);
  const allVegaPE = strikes.map((s) => s.pe.vega);
  const allDeltaCE = strikes.map((s) => s.ce.delta);
  const allDeltaPE = strikes.map((s) => Math.abs(s.pe.delta));
  const allSpreadCE = strikes.map((s) => s.ce.ask - s.ce.bid);
  const allSpreadPE = strikes.map((s) => s.pe.ask - s.pe.bid);
  const allDepthCE = strikes.map((s) => s.ce.bidQty + s.ce.askQty);
  const allDepthPE = strikes.map((s) => s.pe.bidQty + s.pe.askQty);

  const normGammaCE = normalizeMetric(strikes, (s) => s.ce.gamma);
  const normGammaPE = normalizeMetric(strikes, (s) => s.pe.gamma);
  const normOICE = normalizeMetric(strikes, (s) => s.ce.oi);
  const normOIPE = normalizeMetric(strikes, (s) => s.pe.oi);
  const normOiChgCE = normalizeMetric(strikes, (s) => Math.abs(s.ce.oiChg));
  const normOiChgPE = normalizeMetric(strikes, (s) => Math.abs(s.pe.oiChg));
  const normVolCE = normalizeMetric(strikes, (s) => s.ce.volume);
  const normVolPE = normalizeMetric(strikes, (s) => s.pe.volume);
  const normIVCE = normalizeMetric(strikes, (s) => s.ce.iv);
  const normIVPE = normalizeMetric(strikes, (s) => s.pe.iv);
  const normThetaCE = normalizeMetric(strikes, (s) => Math.abs(s.ce.theta));
  const normThetaPE = normalizeMetric(strikes, (s) => Math.abs(s.pe.theta));
  const normVegaCE = normalizeMetric(strikes, (s) => s.ce.vega);
  const normVegaPE = normalizeMetric(strikes, (s) => s.pe.vega);
  const normDeltaCE = normalizeMetric(strikes, (s) => s.ce.delta);
  const normDeltaPE = normalizeMetric(strikes, (s) => Math.abs(s.pe.delta));
  const normSpreadCE = normalizeMetric(strikes, (s) => s.ce.ask - s.ce.bid);
  const normSpreadPE = normalizeMetric(strikes, (s) => s.pe.ask - s.pe.bid);
  const normDepthCE = normalizeMetric(strikes, (s) => s.ce.bidQty + s.ce.askQty);
  const normDepthPE = normalizeMetric(strikes, (s) => s.pe.bidQty + s.pe.askQty);

  const scoredStrikes: ScoredStrike[] = [];

  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i];
    const historyKeyCE = `${symbol}_${strike.strike}_CE`;
    const historyKeyPE = `${symbol}_${strike.strike}_PE`;

    pushHistory(historyKeyCE, {
      gamma: strike.ce.gamma,
      oi: strike.ce.oi,
      volume: strike.ce.volume,
      iv: strike.ce.iv,
      timestamp: Date.now(),
    });
    pushHistory(historyKeyPE, {
      gamma: strike.pe.gamma,
      oi: strike.pe.oi,
      volume: strike.pe.volume,
      iv: strike.pe.iv,
      timestamp: Date.now(),
    });

    const prevCE = getPrevious(historyKeyCE);
    const prevPE = getPrevious(historyKeyPE);

    const derivedCE = computeDerived(strike.ce, prevCE, allGammaCE, allOICE, allVolCE, allIVCE, i);
    const derivedPE = computeDerived(strike.pe, prevPE, allGammaPE, allOIPE, allVolPE, allIVPE, i);

    const gammaScoreCE = normGammaCE[i];
    const gammaScorePE = normGammaPE[i];
    const oiFlowScoreCE = normOICE[i];
    const oiFlowScorePE = normOIPE[i];
    const oiChangeScoreCE = normOiChgCE[i];
    const oiChangeScorePE = normOiChgPE[i];
    const volumeScoreCE = normVolCE[i];
    const volumeScorePE = normVolPE[i];
    const ivScoreCE = normIVCE[i];
    const ivScorePE = normIVPE[i];
    const thetaScoreCE = 100 - normThetaCE[i];
    const thetaScorePE = 100 - normThetaPE[i];
    const vegaScoreCE = normVegaCE[i];
    const vegaScorePE = normVegaPE[i];
    const deltaQualityCE = 100 - Math.abs(normDeltaCE[i] - 55) * 2;
    const deltaQualityPE = 100 - Math.abs(normDeltaPE[i] - 55) * 2;
    const liquidityScoreCE = 100 - normSpreadCE[i] + normDepthCE[i] * 0.3;
    const liquidityScorePE = 100 - normSpreadPE[i] + normDepthPE[i] * 0.3;

    const dealerPressureCE =
      derivedCE.dealerLongGamma * 0.4 + derivedCE.dealerHedgingPressure * 0.3 + derivedCE.dealerFlipZone * 0.3;
    const dealerPressurePE =
      derivedPE.dealerLongGamma * 0.4 + derivedPE.dealerHedgingPressure * 0.3 + derivedPE.dealerFlipZone * 0.3;

    const institutionalScoreCE =
      gammaScoreCE * 0.25 +
      oiFlowScoreCE * 0.20 +
      oiChangeScoreCE * 0.15 +
      deltaQualityCE * 0.10 +
      volumeScoreCE * 0.10 +
      vegaScoreCE * 0.05 +
      thetaScoreCE * 0.05 +
      liquidityScoreCE * 0.05 +
      ivScoreCE * 0.05 +
      dealerPressureCE * 0.05;

    const institutionalScorePE =
      gammaScorePE * 0.25 +
      oiFlowScorePE * 0.20 +
      oiChangeScorePE * 0.15 +
      deltaQualityPE * 0.10 +
      volumeScorePE * 0.10 +
      vegaScorePE * 0.05 +
      thetaScorePE * 0.05 +
      liquidityScorePE * 0.05 +
      ivScorePE * 0.05 +
      dealerPressurePE * 0.05;

    const deltaAbs = Math.abs(strike.ce.delta);
    const meetsBuyConditionsCE =
      institutionalScoreCE >= 85 &&
      derivedCE.gammaExpansion > 0 &&
      strike.ce.oiChg > 0 &&
      strike.ce.volume > 0 &&
      (strike.ce.ask - strike.ce.bid) < 2 &&
      deltaAbs >= 0.40 && deltaAbs <= 0.65 &&
      liquidityScoreCE > 60;

    const deltaAbsPE = Math.abs(strike.pe.delta);
    const meetsBuyConditionsPE =
      institutionalScorePE >= 85 &&
      derivedPE.gammaExpansion > 0 &&
      strike.pe.oiChg > 0 &&
      strike.pe.volume > 0 &&
      (strike.pe.ask - strike.pe.bid) < 2 &&
      deltaAbsPE >= 0.40 && deltaAbsPE <= 0.65 &&
      liquidityScorePE > 60;

    const spreadCE = strike.ce.ask - strike.ce.bid;
    const spreadPE = strike.pe.ask - strike.pe.bid;
    const depthCE = strike.ce.bidQty + strike.ce.askQty;
    const depthPE = strike.pe.bidQty + strike.pe.askQty;

    const dealerPressureLabel = (score: number) => {
      if (score >= 70) return "HIGH";
      if (score >= 40) return "MEDIUM";
      return "LOW";
    };

    const tpslCE = computeTPSL(strike.ce.ltp, strike.ce.gamma, strike.ce.delta, strike.ce.theta, strike.ce.iv, summary.spot, strike.strike, "CE");
    const tpslPE = computeTPSL(strike.pe.ltp, strike.pe.gamma, strike.pe.delta, strike.pe.theta, strike.pe.iv, summary.spot, strike.strike, "PE");

    scoredStrikes.push({
      strike: strike.strike,
      type: "CE",
      institutionalScore: Math.round(institutionalScoreCE * 10) / 10,
      gammaScore: Math.round(gammaScoreCE * 10) / 10,
      oiFlowScore: Math.round(oiFlowScoreCE * 10) / 10,
      oiChangeScore: Math.round(oiChangeScoreCE * 10) / 10,
      deltaQualityScore: Math.round(deltaQualityCE * 10) / 10,
      volumeScore: Math.round(volumeScoreCE * 10) / 10,
      vegaScore: Math.round(vegaScoreCE * 10) / 10,
      thetaScore: Math.round(thetaScoreCE * 10) / 10,
      liquidityScore: Math.round(liquidityScoreCE * 10) / 10,
      ivScore: Math.round(ivScoreCE * 10) / 10,
      dealerPressureScore: Math.round(dealerPressureCE * 10) / 10,
      gammaExpansion: Math.round(derivedCE.gammaExpansion * 10) / 10,
      oiFlow: Math.round(derivedCE.oiVelocity * 10) / 10,
      volume: strike.ce.volume,
      dealerPressure: dealerPressureLabel(dealerPressureCE),
      signal: signal(institutionalScoreCE),
      ltp: strike.ce.ltp,
      delta: strike.ce.delta,
      gamma: strike.ce.gamma,
      theta: strike.ce.theta,
      vega: strike.ce.vega,
      iv: strike.ce.iv,
      oi: strike.ce.oi,
      oiChg: strike.ce.oiChg,
      bidAskSpread: Math.round(spreadCE * 100) / 100,
      depth: depthCE,
      bid: strike.ce.bid,
      ask: strike.ce.ask,
      bidQty: strike.ce.bidQty,
      askQty: strike.ce.askQty,
      tp: tpslCE.tp,
      sl: tpslCE.sl,
      rr: tpslCE.rr,
      normalized: {
        gamma: Math.round(normGammaCE[i]),
        oi: Math.round(normOICE[i]),
        oiChg: Math.round(normOiChgCE[i]),
        volume: Math.round(normVolCE[i]),
        iv: Math.round(normIVCE[i]),
        theta: Math.round(normThetaCE[i]),
        vega: Math.round(normVegaCE[i]),
        delta: Math.round(normDeltaCE[i]),
        spread: Math.round(normSpreadCE[i]),
        depth: Math.round(normDepthCE[i]),
      },
      derived: derivedCE,
      meetsBuyConditions: meetsBuyConditionsCE,
      meetsSellConditions: false,
    });

    scoredStrikes.push({
      strike: strike.strike,
      type: "PE",
      institutionalScore: Math.round(institutionalScorePE * 10) / 10,
      gammaScore: Math.round(gammaScorePE * 10) / 10,
      oiFlowScore: Math.round(oiFlowScorePE * 10) / 10,
      oiChangeScore: Math.round(oiChangeScorePE * 10) / 10,
      deltaQualityScore: Math.round(deltaQualityPE * 10) / 10,
      volumeScore: Math.round(volumeScorePE * 10) / 10,
      vegaScore: Math.round(vegaScorePE * 10) / 10,
      thetaScore: Math.round(thetaScorePE * 10) / 10,
      liquidityScore: Math.round(liquidityScorePE * 10) / 10,
      ivScore: Math.round(ivScorePE * 10) / 10,
      dealerPressureScore: Math.round(dealerPressurePE * 10) / 10,
      gammaExpansion: Math.round(derivedPE.gammaExpansion * 10) / 10,
      oiFlow: Math.round(derivedPE.oiVelocity * 10) / 10,
      volume: strike.pe.volume,
      dealerPressure: dealerPressureLabel(dealerPressurePE),
      signal: signal(institutionalScorePE),
      ltp: strike.pe.ltp,
      delta: strike.pe.delta,
      gamma: strike.pe.gamma,
      theta: strike.pe.theta,
      vega: strike.pe.vega,
      iv: strike.pe.iv,
      oi: strike.pe.oi,
      oiChg: strike.pe.oiChg,
      bidAskSpread: Math.round(spreadPE * 100) / 100,
      depth: depthPE,
      bid: strike.pe.bid,
      ask: strike.pe.ask,
      bidQty: strike.pe.bidQty,
      askQty: strike.pe.askQty,
      tp: tpslPE.tp,
      sl: tpslPE.sl,
      rr: tpslPE.rr,
      normalized: {
        gamma: Math.round(normGammaPE[i]),
        oi: Math.round(normOIPE[i]),
        oiChg: Math.round(normOiChgPE[i]),
        volume: Math.round(normVolPE[i]),
        iv: Math.round(normIVPE[i]),
        theta: Math.round(normThetaPE[i]),
        vega: Math.round(normVegaPE[i]),
        delta: Math.round(normDeltaPE[i]),
        spread: Math.round(normSpreadPE[i]),
        depth: Math.round(normDepthPE[i]),
      },
      derived: derivedPE,
      meetsBuyConditions: false,
      meetsSellConditions: meetsBuyConditionsPE,
    });
  }

  scoredStrikes.sort((a, b) => b.institutionalScore - a.institutionalScore);

  const ceStrikes = scoredStrikes.filter((s) => s.type === "CE");
  const peStrikes = scoredStrikes.filter((s) => s.type === "PE");

  const topCalls = ceStrikes.slice(0, 5);
  const topPuts = peStrikes.slice(0, 5);

  const bestCallStrike = topCalls[0] || null;
  const bestPutStrike = topPuts[0] || null;

  const allCE = scoredStrikes.filter((s) => s.type === "CE");
  const bestGammaStrike = allCE.length > 0 ? allCE.reduce((best, s) => (s.gamma > best.gamma ? s : best), allCE[0]) : null;
  const highestOIStrike = allCE.length > 0 ? allCE.reduce((best, s) => (s.oi > best.oi ? s : best), allCE[0]) : null;
  const highestOIChangeStrike = allCE.length > 0 ? allCE.reduce((best, s) => (Math.abs(s.oiChg) > Math.abs(best.oiChg) ? s : best), allCE[0]) : null;
  const highestVolumeStrike = allCE.length > 0 ? allCE.reduce((best, s) => (s.volume > best.volume ? s : best), allCE[0]) : null;
  const highestScoreStrike = scoredStrikes[0] || null;

  return {
    strikes: scoredStrikes,
    topCalls,
    topPuts,
    bestCallStrike,
    bestPutStrike,
    bestGammaStrike,
    highestOIStrike,
    highestOIChangeStrike,
    highestVolumeStrike,
    highestScoreStrike,
    timestamp: new Date().toISOString(),
    symbol,
    spot: summary.spot,
    atmStrike: summary.atmStrike,
  };
}
