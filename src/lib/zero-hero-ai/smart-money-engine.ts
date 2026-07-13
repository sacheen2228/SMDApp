// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Smart Money Engine
// Detects BOS/CHoCH/FVG/OB/Liquidity Sweep using price action

export interface SmartMoneyInput {
  candles: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: number;
  }[];
  spot: number;
}

export interface SmartMoneyOutput {
  bos: boolean;          // Break of Structure
  choch: boolean;        // Change of Character
  fvg: {                 // Fair Value Gap
    top: number;
    bottom: number;
    direction: 'UP' | 'DOWN';
  }[];
  ob: {                  // Order Block
    top: number;
    bottom: number;
    direction: 'BULLISH' | 'BEARISH';
  }[];
  liquidity_sweep: boolean;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
}

function detectFVG(candles: SmartMoneyInput['candles']): SmartMoneyOutput['fvg'] {
  const fvgs: SmartMoneyOutput['fvg'] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    // Bullish FVG: gap up between prev high and next low
    if (prev.high < next.low) {
      fvgs.push({ top: next.low, bottom: prev.high, direction: 'UP' });
    }
    // Bearish FVG: gap down between prev low and next high
    if (prev.low > next.high) {
      fvgs.push({ top: prev.low, bottom: next.high, direction: 'DOWN' });
    }
  }
  return fvgs;
}

function detectOB(candles: SmartMoneyInput['candles']): SmartMoneyOutput['ob'] {
  const obs: SmartMoneyOutput['ob'] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    // Bullish OB: strong down candle followed by up move
    if (curr.close < curr.open && curr.close < prev.close && next.close > curr.open) {
      obs.push({ top: curr.open, bottom: curr.low, direction: 'BULLISH' });
    }
    // Bearish OB: strong up candle followed by down move
    if (curr.close > curr.open && curr.close > prev.close && next.close < curr.open) {
      obs.push({ top: curr.high, bottom: curr.open, direction: 'BEARISH' });
    }
  }
  return obs;
}

function detectBOS(candles: SmartMoneyInput['candles']): { bos: boolean; choch: boolean } {
  if (candles.length < 5) return { bos: false, choch: false };
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const lastHigh = Math.max(...highs.slice(-3));
  const lastLow = Math.min(...lows.slice(-3));
  const prevHigh = Math.max(...highs.slice(0, -3));
  const prevLow = Math.min(...lows.slice(0, -3));

  const bos = candles[candles.length - 1].close > prevHigh || candles[candles.length - 1].close < prevLow;
  const choch = (candles[candles.length - 1].close > lastHigh && candles[candles.length - 1].close < prevHigh) ||
                (candles[candles.length - 1].close < lastLow && candles[candles.length - 1].close > prevLow);

  return { bos, choch };
}

function detectLiquiditySweep(candles: SmartMoneyInput['candles']): boolean {
  if (candles.length < 3) return false;
  const recent = candles.slice(-3);
  const prior = candles.slice(-10, -3);
  if (prior.length === 0) return false;
  const priorHigh = Math.max(...prior.map(c => c.high));
  const priorLow = Math.min(...prior.map(c => c.low));
  const last = recent[recent.length - 1];

  // Sweep above prior high then reverse
  if (last.high > priorHigh && last.close < priorHigh) return true;
  // Sweep below prior low then reverse
  if (last.low < priorLow && last.close > priorLow) return true;
  return false;
}

export function smartMoneyEngine(input: SmartMoneyInput): SmartMoneyOutput {
  const { candles, spot } = input;

  if (candles.length < 5) {
    return {
      bos: false,
      choch: false,
      fvg: [],
      ob: [],
      liquidity_sweep: false,
      bias: 'NEUTRAL',
      confidence: 0,
    };
  }

  const { bos, choch } = detectBOS(candles);
  const fvg = detectFVG(candles);
  const ob = detectOB(candles);
  const liquiditySweep = detectLiquiditySweep(candles);

  // Bias determination
  let bullishCount = 0;
  let bearishCount = 0;
  if (bos && candles[candles.length - 1].close > candles[candles.length - 1].open) bullishCount++;
  if (choch && candles[candles.length - 1].close > candles[candles.length - 1].open) bullishCount++;
  if (fvg.some(f => f.direction === 'UP')) bullishCount++;
  if (ob.some(o => o.direction === 'BULLISH')) bullishCount++;
  if (liquiditySweep && candles[candles.length - 1].close > candles[candles.length - 1].open) bullishCount++;

  if (bos && candles[candles.length - 1].close < candles[candles.length - 1].open) bearishCount++;
  if (choch && candles[candles.length - 1].close < candles[candles.length - 1].open) bearishCount++;
  if (fvg.some(f => f.direction === 'DOWN')) bearishCount++;
  if (ob.some(o => o.direction === 'BEARISH')) bearishCount++;
  if (liquiditySweep && candles[candles.length - 1].close < candles[candles.length - 1].open) bearishCount++;

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (bullishCount > bearishCount) bias = 'BULLISH';
  else if (bearishCount > bullishCount) bias = 'BEARISH';
  else bias = 'NEUTRAL';

  return {
    bos,
    choch,
    fvg,
    ob,
    liquidity_sweep: liquiditySweep,
    bias,
    confidence: Math.min(100, (bullishCount + bearishCount) * 15),
  };
}
