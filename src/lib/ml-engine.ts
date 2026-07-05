export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface StrikeData {
  strike: number
  ce: { oi: number; volume: number; ltp: number; iv: number } | null
  pe: { oi: number; volume: number; ltp: number; iv: number } | null
}

export interface Signal {
  type: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  source: string
  description: string
}

export interface MLAnalysis {
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  reasons: string[]
  action: 'BUY_CE' | 'BUY_PE' | 'SELL' | 'NO_TRADE'
}

export function calculateRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close
    if (diff > 0) gains += diff
    else losses -= diff
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

export function calculateEMA(data: number[], period: number): number[] {
  if (data.length === 0) return []
  const ema: number[] = []
  const k = 2 / (period + 1)
  ema[0] = data[0]
  for (let i = 1; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k)
  }
  return ema
}

export function calculateBollingerBands(
  closes: number[],
  period = 20,
  multiplier = 2
): { upper: number; middle: number; lower: number; bandwidth: number } {
  if (closes.length < period) {
    const avg = closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : 0
    return { upper: avg, middle: avg, lower: avg, bandwidth: 0 }
  }
  const slice = closes.slice(-period)
  const middle = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((acc, val) => acc + (val - middle) ** 2, 0) / period
  const std = Math.sqrt(variance)
  const upper = middle + multiplier * std
  const lower = middle - multiplier * std
  const bandwidth = middle !== 0 ? ((upper - lower) / middle) * 100 : 0
  return { upper, middle, lower, bandwidth }
}

export function calculateVWAP(candles: Candle[]): number {
  let cumulativeVolumePrice = 0
  let cumulativeVolume = 0
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3
    cumulativeVolumePrice += typicalPrice * c.volume
    cumulativeVolume += c.volume
  }
  return cumulativeVolume > 0 ? cumulativeVolumePrice / cumulativeVolume : 0
}

export function calculateADX(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 20
  const trueRanges: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high
    const lowDiff = candles[i - 1].low - candles[i].low
    trueRanges.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    )
    plusDMs.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0)
    minusDMs.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0)
  }
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period
  let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period
  let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period
  const dxValues: number[] = []
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
    plusDM = (plusDM * (period - 1) + plusDMs[i]) / period
    minusDM = (minusDM * (period - 1) + minusDMs[i]) / period
    const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0
    const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0
    const diSum = plusDI + minusDI
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0)
  }
  if (dxValues.length === 0) return 20
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period
  }
  return adx
}

function momentumSignal(candles: Candle[]): Signal {
  const rsi = calculateRSI(candles)
  if (rsi >= 70) {
    return { type: 'BEARISH', confidence: Math.min(100, 60 + (rsi - 70) * 4), source: 'RSI', description: `RSI overbought at ${rsi.toFixed(1)}` }
  }
  if (rsi <= 30) {
    return { type: 'BULLISH', confidence: Math.min(100, 60 + (30 - rsi) * 4), source: 'RSI', description: `RSI oversold at ${rsi.toFixed(1)}` }
  }
  return { type: 'NEUTRAL', confidence: 30, source: 'RSI', description: `RSI neutral at ${rsi.toFixed(1)}` }
}

function meanReversionSignal(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close)
  const bb = calculateBollingerBands(closes)
  const lastClose = closes[closes.length - 1]
  const pricePosition = bb.upper !== bb.lower ? (lastClose - bb.lower) / (bb.upper - bb.lower) : 0.5
  if (bb.bandwidth < 2) {
    return { type: 'NEUTRAL', confidence: 40, source: 'BB_SQUEEZE', description: `Bollinger squeeze detected (BW: ${bb.bandwidth.toFixed(2)}%)` }
  }
  if (lastClose < bb.lower) {
    return { type: 'BULLISH', confidence: Math.min(100, 50 + (1 - pricePosition) * 50), source: 'BB', description: `Price below lower BB (${bb.lower.toFixed(0)}), likely bounce` }
  }
  if (lastClose > bb.upper) {
    return { type: 'BEARISH', confidence: Math.min(100, 50 + pricePosition * 50), source: 'BB', description: `Price above upper BB (${bb.upper.toFixed(0)}), likely reversal` }
  }
  return { type: 'NEUTRAL', confidence: 20, source: 'BB', description: `Price within Bollinger bands` }
}

function volumeProfileSignal(candles: Candle[]): Signal {
  const vwap = calculateVWAP(candles)
  const lastClose = candles[candles.length - 1].close
  const avgVolume = candles.reduce((a, c) => a + c.volume, 0) / candles.length
  const lastVolume = candles[candles.length - 1].volume
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 1
  const isSpike = volumeRatio > 2
  const aboveVWAP = lastClose > vwap
  if (isSpike && aboveVWAP) {
    return { type: 'BULLISH', confidence: Math.min(100, 60 + volumeRatio * 5), source: 'VWAP', description: `Volume spike (${volumeRatio.toFixed(1)}x) with price above VWAP` }
  }
  if (isSpike && !aboveVWAP) {
    return { type: 'BEARISH', confidence: Math.min(100, 60 + volumeRatio * 5), source: 'VWAP', description: `Volume spike (${volumeRatio.toFixed(1)}x) with price below VWAP` }
  }
  if (aboveVWAP) {
    return { type: 'BULLISH', confidence: 40, source: 'VWAP', description: `Price above VWAP at ${vwap.toFixed(0)}` }
  }
  return { type: 'BEARISH', confidence: 40, source: 'VWAP', description: `Price below VWAP at ${vwap.toFixed(0)}` }
}

function trendSignal(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close)
  const ema9 = calculateEMA(closes, 9)
  const ema21 = calculateEMA(closes, 21)
  const adx = calculateADX(candles)
  const lastEma9 = ema9[ema9.length - 1]
  const lastEma21 = ema21[ema21.length - 1]
  const prevEma9 = ema9.length > 1 ? ema9[ema9.length - 2] : lastEma9
  const prevEma21 = ema21.length > 1 ? ema21[ema21.length - 2] : lastEma21
  const bullishCross = prevEma9 <= prevEma21 && lastEma9 > lastEma21
  const bearishCross = prevEma9 >= prevEma21 && lastEma9 < lastEma21
  const strongTrend = adx > 25
  if (bullishCross) {
    return { type: 'BULLISH', confidence: Math.min(100, 60 + adx), source: 'EMA_CROSS', description: `Bullish 9/21 EMA crossover, ADX ${adx.toFixed(0)}` }
  }
  if (bearishCross) {
    return { type: 'BEARISH', confidence: Math.min(100, 60 + adx), source: 'EMA_CROSS', description: `Bearish 9/21 EMA crossover, ADX ${adx.toFixed(0)}` }
  }
  if (lastEma9 > lastEma21 && strongTrend) {
    return { type: 'BULLISH', confidence: 55, source: 'TREND', description: `Uptrend: EMA9 > EMA21, ADX ${adx.toFixed(0)}` }
  }
  if (lastEma9 < lastEma21 && strongTrend) {
    return { type: 'BEARISH', confidence: 55, source: 'TREND', description: `Downtrend: EMA9 < EMA21, ADX ${adx.toFixed(0)}` }
  }
  return { type: 'NEUTRAL', confidence: 25, source: 'TREND', description: `No clear trend, ADX ${adx.toFixed(0)}` }
}

function supportResistanceSignal(candles: Candle[]): Signal {
  const lastClose = candles[candles.length - 1].close
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const recentHighs = highs.slice(-20)
  const recentLows = lows.slice(-20)
  const pivot = (recentHighs[recentHighs.length - 1] + recentLows[recentLows.length - 1] + lastClose) / 3
  const r1 = 2 * pivot - recentLows[recentLows.length - 1]
  const s1 = 2 * pivot - recentHighs[recentHighs.length - 1]
  const roundLevel = Math.round(lastClose / 50) * 50
  const distToRound = Math.abs(lastClose - roundLevel)
  const roundStrength = distToRound < 10 ? 20 : 0
  if (lastClose <= s1 + 5) {
    return { type: 'BULLISH', confidence: Math.min(100, 65 + roundStrength), source: 'S/R', description: `Near support S1 at ${s1.toFixed(0)}, likely bounce` }
  }
  if (lastClose >= r1 - 5) {
    return { type: 'BEARISH', confidence: Math.min(100, 65 + roundStrength), source: 'S/R', description: `Near resistance R1 at ${r1.toFixed(0)}, likely rejection` }
  }
  return { type: 'NEUTRAL', confidence: 25, source: 'S/R', description: `Between support ${s1.toFixed(0)} and resistance ${r1.toFixed(0)}` }
}

function oiBuildupSignal(strikes: StrikeData[]): Signal {
  if (strikes.length === 0) return { type: 'NEUTRAL', confidence: 10, source: 'OI', description: 'No OI data available' }
  const totalCeOi = strikes.reduce((a, s) => a + (s.ce?.oi || 0), 0)
  const totalPeOi = strikes.reduce((a, s) => a + (s.pe?.oi || 0), 0)
  const totalCeVol = strikes.reduce((a, s) => a + (s.ce?.volume || 0), 0)
  const totalPeVol = strikes.reduce((a, s) => a + (s.pe?.volume || 0), 0)
  const pcrOi = totalCeOi > 0 ? totalPeOi / totalCeOi : 1
  const pcrVol = totalCeVol > 0 ? totalPeVol / totalCeVol : 1
  const maxCeOiStrike = strikes.reduce((max, s) => (s.ce && s.ce.oi > (max.ce?.oi || 0)) ? s : max, strikes[0])
  const maxPeOiStrike = strikes.reduce((max, s) => (s.pe && s.pe.oi > (max.pe?.oi || 0)) ? s : max, strikes[0])
  const callWall = maxCeOiStrike.strike
  const putWall = maxPeOiStrike.strike
  if (pcrOi > 1.3 && pcrVol > 1.2) {
    return { type: 'BULLISH', confidence: Math.min(100, 60 + (pcrOi - 1) * 20), source: 'OI_BUILDUP', description: `Strong put writing (PCR OI: ${pcrOi.toFixed(2)}), bullish buildup` }
  }
  if (pcrOi < 0.7 && pcrVol < 0.8) {
    return { type: 'BEARISH', confidence: Math.min(100, 60 + (1 - pcrOi) * 20), source: 'OI_BUILDUP', description: `Strong call writing (PCR OI: ${pcrOi.toFixed(2)}), bearish buildup` }
  }
  if (pcrOi > 1.0 && pcrVol < 0.9) {
    return { type: 'NEUTRAL', confidence: 35, source: 'OI_BUILDUP', description: `Mixed signals: PCR OI ${pcrOi.toFixed(2)}, PCR Vol ${pcrVol.toFixed(2)}` }
  }
  return { type: 'NEUTRAL', confidence: 30, source: 'OI_BUILDUP', description: `PCR OI: ${pcrOi.toFixed(2)}, Call wall: ${callWall}, Put wall: ${putWall}` }
}

export function analyzePatterns(candles: Candle[], strikes: StrikeData[]): Signal[] {
  if (candles.length === 0) return []
  return [
    momentumSignal(candles),
    meanReversionSignal(candles),
    volumeProfileSignal(candles),
    trendSignal(candles),
    supportResistanceSignal(candles),
    oiBuildupSignal(strikes),
  ]
}

export function runMLAnalysis(
  candles: Candle[],
  strikes: StrikeData[],
  spotPrice: number
): MLAnalysis {
  const signals = analyzePatterns(candles, strikes)
  if (signals.length === 0) {
    return { direction: 'NEUTRAL', confidence: 0, reasons: ['Insufficient data for analysis'], action: 'NO_TRADE' }
  }
  const weights: Record<string, number> = {
    RSI: 1.2,
    BB: 1.0,
    BB_SQUEEZE: 0.8,
    VWAP: 1.1,
    EMA_CROSS: 1.3,
    TREND: 1.0,
    'S/R': 0.9,
    OI_BUILDUP: 1.4,
  }
  let bullishScore = 0
  let bearishScore = 0
  let totalWeight = 0
  for (const sig of signals) {
    const w = weights[sig.source] || 1
    const weightedConf = sig.confidence * w
    if (sig.type === 'BULLISH') bullishScore += weightedConf
    else if (sig.type === 'BEARISH') bearishScore += weightedConf
    totalWeight += w
  }
  const netScore = totalWeight > 0 ? ((bullishScore - bearishScore) / totalWeight) * 100 / 100 : 0
  const absScore = Math.abs(netScore)
  let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  if (netScore > 10) direction = 'BULLISH'
  else if (netScore < -10) direction = 'BEARISH'
  else direction = 'NEUTRAL'
  const confidence = Math.min(100, Math.round(absScore))
  const sorted = [...signals]
    .filter((s) => s.type !== 'NEUTRAL')
    .sort((a, b) => b.confidence - a.confidence)
  const reasons = sorted.slice(0, 3).map((s) => `${s.source}: ${s.description}`)
  if (reasons.length === 0) reasons.push('No strong directional signals detected')
  let action: 'BUY_CE' | 'BUY_PE' | 'SELL' | 'NO_TRADE'
  if (direction === 'BULLISH' && confidence > 40) action = 'BUY_CE'
  else if (direction === 'BEARISH' && confidence > 40) action = 'BUY_PE'
  else if (confidence < 20) action = 'NO_TRADE'
  else action = 'SELL'
  return { direction, confidence, reasons, action }
}