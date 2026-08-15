// Market Regime Classifier - 12 regimes using auction theory, volume profile, structure, VWAP

import { Candle, MarketRegime, MarketData, VolumeProfile, SessionProfile } from './auction-types';
import { calculateVolumeProfile, classifyAuctionState, detectAcceptance } from './auction-engine';
import { analyzeMarketStructure } from './market-structure-engine';
import { calculateSessionVWAP, classifyVWAPState } from './vwap-engine';
import { calculateRelativeVolume } from './volume-engine';

export function classifyMarketRegime(
  candles: Candle[],
  profile: VolumeProfile,
  sessionProfile: SessionProfile,
  structure: ReturnType<typeof analyzeMarketStructure>,
  relativeVol: RelativeVolume,
  sessionVwap: number,
  vwapState: ReturnType<typeof classifyVWAPState>
): MarketRegime {
  const currentPrice = candles[candles.length - 1]?.close || 0;
  const { state: auctionState } = classifyAuctionState(currentPrice, profile.vah, profile.val, profile.poc);
  const { currentTrend, bosEvents, chochEvents, displacements } = structure;

  // Volatility
  const recentCandles = candles.slice(-20);
  const avgRange = recentCandles.reduce((s, c) => s + (c.high - c.low), 0) / recentCandles.length;
  const currentRange = recentCandles[recentCandles.length - 1].high - recentCandles[recentCandles.length - 1].low;
  const volatilityRatio = avgRange > 0 ? currentRange / avgRange : 1;
  const highVol = volatilityRatio > 1.5;
  const lowVol = volatilityRatio < 0.5;

  // Trend strength
  const trendUp = currentTrend === 'UP';
  const trendDown = currentTrend === 'DOWN';

  // BOS/CHOCH
  const hasBullishBOS = bosEvents.includes('BOS_BULLISH');
  const hasBearishBOS = bosEvents.includes('BOS_BEARISH');
  const hasBullishCHOCH = chochEvents.includes('CHOCH_BULLISH');
  const hasBearishCHOCH = chochEvents.includes('CHOCH_BEARISH');

  // Value Area position
  const priceAboveVAH = auctionState === 'PRICE_ABOVE_VALUE';
  const priceBelowVAL = auctionState === 'PRICE_BELOW_VALUE';
  const priceInside = auctionState === 'PRICE_INSIDE_VALUE';

  // VWAP
  const aboveVWAP = vwapState.state === 'ABOVE_VWAP' || vwapState.state === 'VWAP_RECLAIM';
  const belowVWAP = vwapState.state === 'BELOW_VWAP' || vwapState.state === 'VWAP_REJECTION';

  // Volume
  const highRelativeVol = relativeVol.ratio > 1.5;
  const lowRelativeVol = relativeVol.ratio < 0.7;

  // Displacements
  const hasDisplacementUp = displacements.includes('DISPLACEMENT_UP');
  const hasDisplacementDown = displacements.includes('DISPLACEMENT_DOWN');

  // Value migration
  // Would need previous profile - simplified

  // ---- REGIME CLASSIFICATION ----

  // HIGH VOLATILITY takes priority
  if (highVol && (hasDisplacementUp || hasDisplacementDown)) {
    return 'HIGH_VOLATILITY';
  }

  if (lowVol && relativeVol.ratio < 0.8 && priceInside) {
    return 'LOW_VOLATILITY';
  }

  // TRENDING UP
  if (trendUp && hasBullishBOS && aboveVWAP && priceAboveVAH) {
    return 'TRENDING_UP';
  }

  // TRENDING DOWN
  if (trendDown && hasBearishBOS && belowVWAP && priceBelowVAL) {
    return 'TRENDING_DOWN';
  }

  // BREAKOUT
  if (priceAboveVAH && hasBullishBOS && highRelativeVol && aboveVWAP) {
    return 'BREAKOUT';
  }

  // FAILED BREAKOUT
  if (priceAboveVAH && hasBearishCHOCH && belowVWAP) {
    return 'FAILED_BREAKOUT';
  }

  // REVERSAL
  if ((trendUp && hasBearishCHOCH && priceBelowVAL) || (trendDown && hasBullishCHOCH && priceAboveVAH)) {
    return 'REVERSAL';
  }

  // ACCUMULATION
  if (priceInside && !trendUp && !trendDown && vwapState.state === 'VWAP_ACCEPTANCE' && lowRelativeVol) {
    return 'ACCUMULATION';
  }

  // DISTRIBUTION
  if (priceInside && !trendUp && !trendDown && vwapState.state === 'VWAP_REJECTION' && highRelativeVol) {
    return 'DISTRIBUTION';
  }

  // BALANCED
  if (priceInside && !highVol && !lowVol && Math.abs(vwapState.distance) < 0.5) {
    return 'BALANCED';
  }

  // RANGING
  if (priceInside && !trendUp && !trendDown) {
    return 'RANGING';
  }

  // TRANSITION
  return 'TRANSITION';
}

export function getRegimeCharacteristics(regime: MarketRegime): {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: 'HIGH' | 'NORMAL' | 'LOW';
  tradeable: boolean;
  preferredSetups: string[];
  avoidSetups: string[];
} {
  const chars: Record<MarketRegime, any> = {
    TRENDING_UP: {
      bias: 'BULLISH', volatility: 'NORMAL', tradeable: true,
      preferredSetups: ['VAL_RECLAIM', 'VWAP_RECLAIM', 'OPENING_RANGE_BREAKOUT', 'LVN_BREAKOUT'],
      avoidSetups: ['VAH_REJECTION', 'PREV_HIGH_SWEEP_REJECTION', 'VWAP_REJECTION'],
    },
    TRENDING_DOWN: {
      bias: 'BEARISH', volatility: 'NORMAL', tradeable: true,
      preferredSetups: ['VAH_REJECTION', 'VWAP_REJECTION', 'OPENING_RANGE_BREAKDOWN', 'LVN_BREAKDOWN'],
      avoidSetups: ['VAL_RECLAIM', 'VWAP_RECLAIM', 'PREV_LOW_SWEEP_RECLAIM'],
    },
    BALANCED: {
      bias: 'NEUTRAL', volatility: 'LOW', tradeable: true,
      preferredSetups: ['VAL_RECLAIM', 'VAH_REJECTION', 'HVN_REJECTION'],
      avoidSetups: ['BREAKOUT', 'LVN_BREAKOUT', 'LVN_BREAKDOWN'],
    },
    RANGING: {
      bias: 'NEUTRAL', volatility: 'LOW', tradeable: true,
      preferredSetups: ['VAL_RECLAIM', 'VAH_REJECTION', 'HVN_REJECTION'],
      avoidSetups: ['TREND_FOLLOWING', 'BREAKOUT'],
    },
    BREAKOUT: {
      bias: 'BULLISH', volatility: 'HIGH', tradeable: true,
      preferredSetups: ['OPENING_RANGE_BREAKOUT', 'LVN_BREAKOUT', 'MOMENTUM'],
      avoidSetups: ['MEAN_REVERSION', 'VAH_REJECTION'],
    },
    FAILED_BREAKOUT: {
      bias: 'BEARISH', volatility: 'HIGH', tradeable: true,
      preferredSetups: ['VAH_REJECTION', 'FAILED_BREAKDOWN', 'REVERSAL'],
      avoidSetups: ['LONG_BREAKOUT', 'MOMENTUM_LONG'],
    },
    REVERSAL: {
      bias: 'NEUTRAL', volatility: 'HIGH', tradeable: true,
      preferredSetups: ['REVERSAL', 'GAP_REVERSAL', 'FAILED_BREAKOUT'],
      avoidSetups: ['TREND_CONTINUATION'],
    },
    ACCUMULATION: {
      bias: 'BULLISH', volatility: 'LOW', tradeable: true,
      preferredSetups: ['VAL_RECLAIM', 'PREV_LOW_SWEEP_RECLAIM', 'VWAP_RECLAIM'],
      avoidSetups: ['SHORT_BREAKDOWN'],
    },
    DISTRIBUTION: {
      bias: 'BEARISH', volatility: 'LOW', tradeable: true,
      preferredSetups: ['VAH_REJECTION', 'PREV_HIGH_SWEEP_REJECTION', 'VWAP_REJECTION'],
      avoidSetups: ['LONG_BREAKOUT'],
    },
    HIGH_VOLATILITY: {
      bias: 'NEUTRAL', volatility: 'HIGH', tradeable: false,
      preferredSetups: ['WAIT', 'REDUCE_SIZE'],
      avoidSetups: ['ALL_AGGRESSIVE'],
    },
    LOW_VOLATILITY: {
      bias: 'NEUTRAL', volatility: 'LOW', tradeable: true,
      preferredSetups: ['SCALP', 'MEAN_REVERSION', 'RANGE_TRADE'],
      avoidSetups: ['BREAKOUT', 'MOMENTUM'],
    },
    TRANSITION: {
      bias: 'NEUTRAL', volatility: 'NORMAL', tradeable: false,
      preferredSetups: ['WAIT_FOR_CLARITY'],
      avoidSetups: ['ALL'],
    },
  };

  return chars[regime] || chars.TRANSITION;
}