export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type SmcMarker = {
  type: 'BOS' | 'CHoCH' | 'MSS' | 'OB' | 'FVG' | 'IFVG' | 'BSL' | 'SSL' | 'EQH' | 'EQL' | 'SWEEP' | 'DISPLACEMENT';
  direction: 'bullish' | 'bearish';
  index: number;
  price: number;
  strength: number; // 0-100
  notes?: string;
};

export type SmcRead = {
  latest: SmcMarker[];
  bos: SmcMarker | null;
  choch: SmcMarker | null;
  mss: SmcMarker | null;
  orderBlocks: SmcMarker[];
  fvgs: SmcMarker[];
  liquidity: SmcMarker[];
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0-100
};

function isHigherHigh(prev: Candle[], i: number) { return i>1 && prev[i].high > prev[i-2].high && prev[i-2].high >= prev[i-1].high; }
function isLowerLow(prev: Candle[], i: number) { return i>1 && prev[i].low < prev[i-2].low && prev[i-2].low <= prev[i-1].low; }

export function analyzeSMC(candles: Candle[]): SmcRead {
  const markers: SmcMarker[] = [];
  let lastSwingHigh = -1;
  let lastSwingLow = -1;
  let trend: 'up'|'down'|'neutral' = 'neutral';

  for (let i=2; i<candles.length; i++) {
    const c = candles[i];
    const p1 = candles[i-1];
    const p2 = candles[i-2];
    // BOS / CHoCH
    if (c.high > p1.high && p1.high > p2.high) {
      if (trend !== 'up') {
        trend = 'up';
        markers.push({type:'BOS', direction:'bullish', index:i, price:c.high, strength:70});
      }
    }
    if (c.low < p1.low && p1.low < p2.low) {
      if (trend !== 'down') {
        trend = 'down';
        markers.push({type:'BOS', direction:'bearish', index:i, price:c.low, strength:70});
      }
    }
    // CHoCH detection
    if (trend==='up' && isLowerLow(candles,i)) {
      markers.push({type:'CHoCH', direction:'bearish', index:i, price:c.low, strength:75, notes:'up->down'});
      trend='down';
    }
    if (trend==='down' && isHigherHigh(candles,i)) {
      markers.push({type:'CHoCH', direction:'bullish', index:i, price:c.high, strength:75, notes:'down->up'});
      trend='up';
    }
    // FVG: 3 candle gap
    if (i>=2) {
      const a = candles[i-2];
      const b = candles[i-1];
      if (b.close > a.high) {
        markers.push({type:'FVG', direction:'bullish', index:i, price:(a.high+b.low)/2, strength:60});
      }
      if (b.close < a.low) {
        markers.push({type:'FVG', direction:'bearish', index:i, price:(a.low+b.high)/2, strength:60});
      }
    }
    // Order Block: last opposite candle before impulse
    if (markers.length && i>2) {
      const last = markers[markers.length-1];
      if (last.type==='BOS') {
        const ob = candles[i-3];
        markers.push({type:'OB', direction:last.direction, index:i-3, price:ob.close, strength:50});
      }
    }
    // Liquidity sweep
    if (c.low < p1.low && c.close > p1.low) {
      markers.push({type:'SWEEP', direction:'bullish', index:i, price:c.low, strength:55, notes:'low sweep reclaim'});
    }
    if (c.high > p1.high && c.close < p1.high) {
      markers.push({type:'SWEEP', direction:'bearish', index:i, price:c.high, strength:55, notes:'high sweep reject'});
    }
    // EQH/EQL
    if (i>5) {
      const highs = candles.slice(i-5,i).map(x=>x.high);
      const maxH = Math.max(...highs);
      if (c.high === maxH && highs.filter(h=>h===maxH).length>=2) {
        markers.push({type:'EQH', direction:'neutral', index:i, price:c.high, strength:40});
      }
      const lows = candles.slice(i-5,i).map(x=>x.low);
      const minL = Math.min(...lows);
      if (c.low === minL && lows.filter(l=>l===minL).length>=2) {
        markers.push({type:'EQL', direction:'neutral', index:i, price:c.low, strength:40});
      }
    }
  }

  const latest = markers.slice(-20);
  const bos = markers.find(m=>m.type==='BOS') || null;
  const choch = markers.find(m=>m.type==='CHoCH') || null;
  const mss = markers.find(m=>m.type==='MSS') || null;
  const orderBlocks = markers.filter(m=>m.type==='OB');
  const fvgs = markers.filter(m=>m.type==='FVG' || m.type==='IFVG');
  const liquidity = markers.filter(m=>m.type==='SWEEP' || m.type==='DISPLACEMENT');

  const bullishScore = latest.filter(m=>m.direction==='bullish').reduce((s,m)=>s+m.strength,0);
  const bearishScore = latest.filter(m=>m.direction==='bearish').reduce((s,m)=>s+m.strength,0);
  const bias = bullishScore > bearishScore ? 'bullish' : bearishScore > bullishScore ? 'bearish' : 'neutral';
  const confidence = Math.min(100, Math.abs(bullishScore-bearishScore));

  return { latest, bos, choch, mss, orderBlocks, fvgs, liquidity, bias, confidence };
}
