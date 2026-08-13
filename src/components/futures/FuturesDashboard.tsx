'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TerminalHeader } from './TerminalHeader';
import { ChartPanel } from './ChartPanel';
import { ImieDashboard } from './ImieDashboard';
import type { Candle, Trade, OrderBookLevel, AiFinalScore, Recommendation, OpenInterestData } from '@/types/engine';
import { analyzeMarket, computeGrade } from '@/engines/ai/ai-engine';
import type { MarketPlaybook } from '@/engines/imie/types';
// OI fetch helper (inline to avoid circular deps)
async function fetchOpenInterest(symbol: string): Promise<any> {
  try {
    const res = await fetch(`/api/coindcx/oi?symbol=${symbol}`);
    const json = await res.json();
    return json.success ? json.data : null;
  } catch { return null; }
}

function toPair(m: string) {
  const base = m.replace(/USDT$/, '').replace(/INR$/, '').replace(/BTC$/, '');
  const q = m.endsWith('INR') ? 'INR' : m.endsWith('BTC') ? 'BTC' : 'USDT';
  return `B-${base}_${q}`;
}

const getBase = (m: string) => m.replace(/USDT$/, '').replace(/INR$/, '').replace(/BTC$/, '');

const SESSION_WINDOWS: Record<string, { start: number; end: number; label: string; color: string }> = {
  ny: { start: 18.5, end: 27.5, label: 'NEW YORK', color: '#ff5d00' },
  ldn: { start: 13.5, end: 22.5, label: 'LONDON', color: '#2157f3' },
  tyo: { start: 7.5, end: 16.5, label: 'TOKYO', color: '#e91e63' },
  syd: { start: 5.5, end: 12.5, label: 'SYDNEY', color: '#ffeb3b' },
};

function fmt(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function EngBar({ l, v, c }: { l: string; v: number; c: string }) {
  return (
    <div className="flex items-center gap-2 mb-0.5">
      <span className="w-14 text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>{l}</span>
      <div className="flex-1 h-1 bg-[#1e222d] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${v}%`, background: c }} />
      </div>
      <span className="w-6 text-right text-[9px] font-bold" style={{ color: v >= 60 ? (v >= 80 ? '#26a69a' : '#d1d4dc') : '#ef5350' }}>{v.toFixed(0)}</span>
    </div>
  );
}

function ReasonItem({ t }: { t: string }) {
  return <div className="text-[10px] leading-4" style={{ color: t.includes('✓') ? '#26a69a' : t.includes('✗') ? '#ef5350' : '#787b86' }}>{t}</div>;
}

export function FuturesDashboard() {
  const [marketList, setMarketList] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [timeframe, setTimeframe] = useState('15m');
  const [ticker, setTicker] = useState<any>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [prevTrades, setPrevTrades] = useState<Trade[]>([]);
  const [levels, setLevels] = useState<OrderBookLevel[]>([]);
  const [bidVol, setBidVol] = useState(0);
  const [askVol, setAskVol] = useState(0);
  const [prevBidVol, setPrevBidVol] = useState(0);
  const [prevAskVol, setPrevAskVol] = useState(0);
  const [aiResult, setAiResult] = useState<{ aiScore: AiFinalScore; recommendation: Recommendation; playbook?: MarketPlaybook } | null>(null);
  const [oiData, setOiData] = useState<OpenInterestData | null>(null);
  const [fundingData, setFundingData] = useState<any>(null);

  const intRef = useRef<ReturnType<typeof setInterval>>();
  const candleIntRef = useRef<ReturnType<typeof setInterval>>();

  // Derived state (must be before hooks that reference them)
  const baseAsset = getBase(selected);
  const lp = parseFloat(ticker?.last_price || '0');
  const ch = parseFloat(ticker?.change_24_hour || '0');
  const hi = parseFloat(ticker?.high || '0');
  const lo = parseFloat(ticker?.low || '0');
  const vol = parseFloat(ticker?.volume || ticker?.volume_24h || '0');
  const isBull = ch >= 0;

  // Fetch market list once (spot markets + futures pairs)
  useEffect(() => {
    const fetchMarketList = async () => {
      try {
        const spotRes = await fetch('/api/coindcx/market?action=markets');
        const spotJson = await spotRes.json();
        const spotMarkets: string[] = spotJson.success ? spotJson.data : [];

        // Also fetch futures pairs from funding API
        let allMarkets = [...spotMarkets];
        try {
          const fundingRes = await fetch('/api/coindcx/funding');
          const fundingJson = await fundingRes.json();
          if (fundingJson.success && Array.isArray(fundingJson.data)) {
            for (const f of fundingJson.data) {
              const mktName = (f.symbol || '').replace('B-', '').replace('_', '').toUpperCase();
              if (mktName && !allMarkets.includes(mktName)) {
                allMarkets.push(mktName);
              }
            }
          }
        } catch {}

        allMarkets.sort();
        setMarketList(allMarkets);
        setSelected(allMarkets[0] || '');
      } catch {}
    };
    fetchMarketList();
  }, []);

  const pair = selected ? toPair(selected) : '';

  // Fetch candles independently
  useEffect(() => {
    if (!pair) return;
    const fetchCandles = async () => {
      try {
        const res = await fetch(`/api/coindcx/market?action=candles&pair=${pair}&interval=${timeframe}&limit=200`);
        const j = await res.json();
        if (j.success && j.data) {
          const cls = j.data
            .filter((c: any) => c.time)
            .map((c: any) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
            .sort((a: Candle, b: Candle) => a.time - b.time);
          setCandles(cls);
        }
      } catch {}
    };
    fetchCandles();
    candleIntRef.current = setInterval(fetchCandles, 30000);
    return () => { if (candleIntRef.current) clearInterval(candleIntRef.current); };
  }, [pair, timeframe]);

  // Fetch OI data independently (Binance proxy)
  useEffect(() => {
    if (!selected) return;
    const fetchOI = async () => {
      try {
        const raw = await fetchOpenInterest(selected);
        if (raw && raw.openInterest !== null) {
          const positive = [raw.oiChange5m, raw.oiChange15m, raw.oiChange1h].filter(c => c !== null && c > 0).length;
          const negative = [raw.oiChange5m, raw.oiChange15m, raw.oiChange1h].filter(c => c !== null && c < 0).length;
          const oiTrend = positive >= 2 ? 'rising' : negative >= 2 ? 'falling' : 'neutral';
          const priceUp = lp > (lp * (1 - (raw.oiChange5m || 0) / 100));
          setOiData({
            currentOi: raw.openInterest,
            oi5m: raw.oiChange5m,
            oi15m: raw.oiChange15m,
            oi1h: raw.oiChange1h,
            oi4h: raw.oiChange4h,
            oi24h: raw.oiChange24h,
            oiChange: raw.oiChange5m,
            oiMomentum: raw.oiChange5m !== null && raw.oiChange15m !== null ? raw.oiChange5m - raw.oiChange15m : null,
            longBuildUp: oiTrend === 'rising' && priceUp,
            shortBuildUp: oiTrend === 'rising' && !priceUp,
            shortCovering: oiTrend !== 'rising' && priceUp,
            longUnwinding: oiTrend !== 'rising' && !priceUp,
            oiTrend,
          });
        }
      } catch {}
    };
    fetchOI();
    const oiInterval = setInterval(fetchOI, 60000);
    return () => clearInterval(oiInterval);
  }, [selected, lp]);

  // Fetch funding data independently (CoinDCX futures)
  useEffect(() => {
    if (!selected) return;
    const fetchFunding = async () => {
      try {
        const res = await fetch(`/api/coindcx/funding?symbol=${selected}`);
        const j = await res.json();
        if (j.success) setFundingData(j.data);
      } catch {}
    };
    fetchFunding();
    const fi = setInterval(fetchFunding, 30000);
    return () => clearInterval(fi);
  }, [selected]);

  // Fetch ticker + orderbook + trades every 10s
  const fetchAll = useCallback(async () => {
    if (!selected || !pair) return;
    try {
      const [tr, obr, trr] = await Promise.all([
        fetch(`/api/coindcx/market?action=ticker&market=${encodeURIComponent(selected)}`),
        fetch(`/api/coindcx/market?action=orderbook&pair=${pair}`),
        fetch(`/api/coindcx/market?action=trades&pair=${pair}&limit=50`),
      ]);
      const t = await tr.json();
      const ob = await obr.json();
      const td = await trr.json();

      // Fallback: if ticker fails and we have funding data, use that as pseudo-ticker
      if (t.success) {
        setTicker(t.data);
      } else if (fundingData) {
        setTicker({
          market: selected,
          last_price: String(fundingData.lastPrice || fundingData.markPrice || 0),
          change_24_hour: String(fundingData.priceChange || 0),
          high: String(fundingData.high24h || 0),
          low: String(fundingData.low24h || 0),
          volume: String(fundingData.volume || 0),
          bid: '0', ask: '0', timestamp: Date.now(),
        });
      }
      if (ob.success && ob.data) {
        const a = Object.entries(ob.data.asks || {}).map(([p, q]) => ({
          price: parseFloat(p as string), size: parseFloat(q as string), total: parseFloat(p as string) * parseFloat(q as string), isBid: false, isInstitutional: false,
        })).sort((x, y) => x.price - y.price).slice(0, 12);
        const b = Object.entries(ob.data.bids || {}).map(([p, q]) => ({
          price: parseFloat(p as string), size: parseFloat(q as string), total: parseFloat(p as string) * parseFloat(q as string), isBid: true, isInstitutional: false,
        })).sort((x, y) => y.price - x.price).slice(0, 12);
        const allLevels = [...a, ...b] as OrderBookLevel[];
        setLevels(allLevels);
        const bv = b.reduce((s, x) => s + x.size, 0);
        const av = a.reduce((s, x) => s + x.size, 0);
        setPrevBidVol(p => p || bv);
        setPrevAskVol(p => p || av);
        setBidVol(bv);
        setAskVol(av);
      }
      if (td.success && Array.isArray(td.data)) {
        const newTrades: Trade[] = td.data.map((t: any) => ({ price: t.p, size: t.q, isBuyerMaker: t.m, time: t.T }));
        setTrades(prev => {
          setPrevTrades(prev.length > 0 ? prev : newTrades);
          return newTrades;
        });
      }
    } catch {}
  }, [selected, pair, fundingData]);

  useEffect(() => {
    if (pair) {
      fetchAll();
      intRef.current = setInterval(fetchAll, 10000);
      return () => { if (intRef.current) clearInterval(intRef.current); };
    }
  }, [pair, fetchAll]);

  // Run AI engine when data changes
  useEffect(() => {
    const lp = parseFloat(ticker?.last_price || '0');
    if (lp > 0) {
      const result = analyzeMarket(
        candles.length > 0 ? candles : [],
        trades.length > 0 ? trades : [],
        prevTrades.length > 0 ? prevTrades : trades,
        levels.length > 0 ? levels : [],
        bidVol, askVol, prevBidVol || bidVol, prevAskVol || askVol,
        0, lp, [], [], oiData,
        fundingData?.currentRate !== undefined ? fundingData : null,
      );
      setAiResult({ aiScore: result.aiScore, recommendation: result.recommendation, playbook: (result as any).playbook });
    }
  }, [candles, trades, levels, bidVol, askVol, ticker, fundingData]);

  const maxAskSz = Math.max(...levels.filter(l => !l.isBid).map(l => l.size), 0.001);
  const maxBidSz = Math.max(...levels.filter(l => l.isBid).map(l => l.size), 0.001);
  const maxOrderSz = Math.max(maxAskSz, maxBidSz, 0.001);
  const avgSz = levels.length > 0 ? levels.reduce((s, l) => s + l.size, 0) / levels.length : 0;
  const instAskThreshold = avgSz * 3;
  const instBidThreshold = avgSz * 3;

  const asks = levels.filter(l => !l.isBid).sort((a, b) => b.price - a.price);
  const bids = levels.filter(l => l.isBid).sort((a, b) => b.price - a.price);
  const bestAsk = asks.length > 0 ? asks[asks.length - 1].price : 0;
  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

  const { aiScore, recommendation } = aiResult || {
    aiScore: { overallScore: 0, grade: '—', tradeQuality: 'Waiting...', expectedWinRate: 0, risk: 'medium' as const, engines: {} },
    recommendation: { direction: 'wait' as const, entry: null, stop: null, tp1: null, tp2: null, tp3: null, riskReward: null, expectedWinRate: 0, confidence: 0, positionSize: null, leverage: null, liquidationPrice: null, fundingImpact: null, reasons: [], warnings: [], marketStructureExplanation: '', expectedMoveExplanation: '', riskExplanation: '' },
  };

  const recColor = recommendation.direction === 'long' ? '#26a69a' : recommendation.direction === 'short' ? '#ef5350' : '#787b86';
  const gradeInfo = computeGrade(aiScore.overallScore);
  const gradeColor = gradeInfo.risk === 'low' ? '#26a69a' : gradeInfo.risk === 'medium' ? '#ff5d00' : '#ef5350';

  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const activeSession = Object.entries(SESSION_WINDOWS).find(([, w]) => {
    if (w.end > 24) return h >= w.start || h < w.end - 24;
    return h >= w.start && h < w.end;
  });

  return (
    <div className="h-full flex flex-col" style={{ background: '#0a0e17' }}>
      <TerminalHeader selectedMarket={selected} marketList={marketList}
        onMarketChange={m => {
          setSelected(m); setTicker(null); setTrades([]); setPrevTrades([]);
          setLevels([]); setCandles([]); setAiResult(null); setBidVol(0); setAskVol(0);
        }}
      />

      <div className="flex-1 grid gap-1 p-1 overflow-hidden" style={{ gridTemplateColumns: '1fr 1.4fr 0.8fr', gridTemplateRows: 'auto 1fr auto' }}>
        {/* ===== TOP BANNER: AI Score + Grade + Regime + Expected Move ===== */}
        <div className="col-span-3 grid gap-1 p-2" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4, gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr' }}>
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>AI Score</span>
            <span className="text-lg font-bold" style={{ color: gradeColor }}>{aiScore.overallScore}/100</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Grade</span>
            <span className="text-lg font-bold" style={{ color: gradeColor }}>{aiScore.grade}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Quality</span>
            <span className="text-sm font-bold" style={{ color: '#d1d4dc' }}>{aiScore.tradeQuality}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Prediction</span>
            <span className="text-sm font-bold" style={{ color: recColor }}>
              {recommendation.direction === 'long' ? '📈 BULLISH' : recommendation.direction === 'short' ? '📉 BEARISH' : '⏸️ WAIT'}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Win Rate</span>
            <span className="text-sm font-bold" style={{ color: '#d1d4dc' }}>{aiScore.expectedWinRate}%</span>
          </div>
        </div>

        {/* ===== MIDDLE ROW ===== */}
        {/* Left: Engine Scores */}
        <div className="p-2 text-xs flex flex-col h-full overflow-y-auto" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
          <div className="text-[10px] font-bold uppercase mb-2" style={{ color: '#787b86' }}>Engine Scores</div>
          {Object.entries(aiScore.engines).map(([key, e]) => (
            <div key={key} className="mb-1 p-1.5 rounded" style={{ background: '#0a0e17' }}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] font-bold uppercase" style={{ color: '#787b86' }}>{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                <span className="text-[9px]" style={{ color: '#5d6070' }}>{(e.confidence * 100).toFixed(0)}%</span>
              </div>
              <EngBar l="" v={e.score} c={e.score >= 60 ? '#26a69a' : e.score >= 40 ? '#ff5d00' : '#ef5350'} />
              {e.reasons.slice(0, 2).map((r, i) => (
                <div key={i} className="text-[9px] leading-3 mt-0.5" style={{ color: '#5d6070' }}>{r}</div>
              ))}
            </div>
          ))}
        </div>

        {/* Center: Chart */}
        <div className="h-full" style={{ minHeight: 350 }}>
          <ChartPanel market={selected} timeframe={timeframe} onTimeframeChange={setTimeframe} />
        </div>

        {/* Right: Recommendation + Order Book */}
        <div className="text-xs flex flex-col h-full overflow-hidden" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
          {/* Recommendation card */}
          <div className="p-2" style={{ borderBottom: '1px solid #1e222d' }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold uppercase" style={{ color: '#787b86' }}>Trade Recommendation</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: recColor + '18', color: recColor }}>
                {recommendation.direction === 'long' ? '▲ LONG' : recommendation.direction === 'short' ? '▼ SHORT' : '◆ WAIT'}
              </span>
            </div>
            {recommendation.direction !== 'wait' ? (
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div><span style={{ color: '#5d6070' }}>Entry</span><div style={{ color: '#d1d4dc' }}>${recommendation.entry?.toFixed(2) || '—'}</div></div>
                <div><span style={{ color: '#5d6070' }}>SL</span><div style={{ color: '#ef5350' }}>${recommendation.stop?.toFixed(2) || '—'}</div></div>
                <div><span style={{ color: '#5d6070' }}>TP1</span><div style={{ color: '#26a69a' }}>${recommendation.tp1?.toFixed(2) || '—'}</div></div>
                <div><span style={{ color: '#5d6070' }}>TP2</span><div style={{ color: '#26a69a' }}>${recommendation.tp2?.toFixed(2) || '—'}</div></div>
                <div><span style={{ color: '#5d6070' }}>RR</span><div style={{ color: '#d1d4dc' }}>{recommendation.riskReward?.toFixed(2) || '—'}:1</div></div>
                <div><span style={{ color: '#5d6070' }}>Conf</span><div style={{ color: recColor }}>{recommendation.confidence}%</div></div>
              </div>
            ) : (
              <div className="text-[10px]" style={{ color: '#787b86' }}>No clear signal — engines diverging</div>
            )}
            <div className="mt-1 space-y-0.5">
              {recommendation.reasons.slice(0, 4).map((r, i) => <ReasonItem key={i} t={r} />)}
            </div>
            {recommendation.warnings.length > 0 && (
              <div className="mt-1 pt-1" style={{ borderTop: '1px solid #1e222d' }}>
                {recommendation.warnings.map((w, i) => (
                  <div key={i} className="text-[9px] leading-3 mt-0.5" style={{ color: '#ff5d00' }}>⚠ {w}</div>
                ))}
              </div>
            )}
            {recommendation.marketStructureExplanation && (
              <div className="mt-1 text-[9px] leading-3" style={{ color: '#5d6070' }}>
                {recommendation.marketStructureExplanation.length > 80
                  ? recommendation.marketStructureExplanation.slice(0, 80) + '...'
                  : recommendation.marketStructureExplanation}
              </div>
            )}
          </div>

          {/* Order Book */}
          <div className="px-2 py-1 text-[9px] font-bold uppercase flex items-center justify-between" style={{ color: '#5d6070', borderBottom: '1px solid #1e222d' }}>
            <span>Order Book</span>
            <span style={{ color: '#787b86' }}>{selected}</span>
          </div>
          <div className="flex items-center justify-between px-2 py-0.5 text-[8px] uppercase" style={{ color: '#3d4050', borderBottom: '1px solid #1e222d' }}>
            <span className="w-[24%]">Price</span>
            <span className="w-[22%] text-right">Size</span>
            <span className="w-[22%] text-right">Total</span>
            <span className="w-[16%] text-right">Depth%</span>
            <span className="w-[16%] text-right">Wall</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: 'none' }}>
            {asks.map((l) => (
              <div key={`a-${l.price}`} className="flex items-center justify-between px-2 py-0.5 relative text-[10px]" style={{ color: '#ef5350' }}>
                <div className="absolute right-0 top-0 bottom-0" style={{ background: 'rgba(239,83,80,0.06)', width: `${(l.size / maxOrderSz) * 100}%` }} />
                <span className="relative z-10 w-[24%] font-medium">{l.price.toFixed(2)}</span>
                <span className="relative z-10 w-[22%] text-right">{fmt(l.size)}</span>
                <span className="relative z-10 w-[22%] text-right">${l.total.toFixed(1)}</span>
                <span className="relative z-10 w-[16%] text-right" style={{ color: '#5d6070' }}>{(l.size / (bidVol + askVol || 1) * 100).toFixed(1)}</span>
                <span className="relative z-10 w-[16%] text-right">{l.size > instAskThreshold ? '🏦' : ''}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-2 py-0.5 text-[9px] font-bold" style={{ color: '#d1d4dc', background: '#0a0e17', borderTop: '1px solid #1e222d', borderBottom: '1px solid #1e222d' }}>
              <span>Spread: ${spread.toFixed(2)}</span>
              <span>Bid: {fmt(bidVol)} / Ask: {fmt(askVol)}</span>
            </div>
            {bids.map((l) => (
              <div key={`b-${l.price}`} className="flex items-center justify-between px-2 py-0.5 relative text-[10px]" style={{ color: '#26a69a' }}>
                <div className="absolute right-0 top-0 bottom-0" style={{ background: 'rgba(38,166,154,0.06)', width: `${(l.size / maxOrderSz) * 100}%` }} />
                <span className="relative z-10 w-[24%] font-medium">{l.price.toFixed(2)}</span>
                <span className="relative z-10 w-[22%] text-right">{fmt(l.size)}</span>
                <span className="relative z-10 w-[22%] text-right">${l.total.toFixed(1)}</span>
                <span className="relative z-10 w-[16%] text-right" style={{ color: '#5d6070' }}>{(l.size / (bidVol + askVol || 1) * 100).toFixed(1)}</span>
                <span className="relative z-10 w-[16%] text-right">{l.size > instBidThreshold ? '🏦' : ''}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ===== BOTTOM ROW: Market Stats + OI + Funding + Liquidation ===== */}
        <div className="col-span-3 grid gap-1" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {/* Stats */}
          <div className="p-2 text-xs flex flex-col" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
            <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>Market Stats</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              <div><span style={{ color: '#5d6070' }}>H:</span> <span style={{ color: '#26a69a' }}>${hi.toFixed(2)}</span></div>
              <div><span style={{ color: '#5d6070' }}>L:</span> <span style={{ color: '#ef5350' }}>${lo.toFixed(2)}</span></div>
              <div><span style={{ color: '#5d6070' }}>Vol:</span> <span style={{ color: '#d1d4dc' }}>${fmt(vol)}</span></div>
              <div><span style={{ color: '#5d6070' }}>Chg:</span> <span style={{ color: isBull ? '#26a69a' : '#ef5350' }}>{ch.toFixed(2)}%</span></div>
              <div className="col-span-2"><span style={{ color: '#5d6070' }}>Last:</span> <span className="font-bold" style={{ color: '#d1d4dc' }}>${fmt(lp)}</span></div>
            </div>
          </div>

          {/* Open Interest */}
          <div className="p-2 text-xs flex flex-col" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold uppercase" style={{ color: '#787b86' }}>Open Interest</span>
              <span className="text-[8px] px-1 py-0.5 rounded" style={{ background: '#ffeb3b15', color: '#ffeb3b' }}>Binance</span>
            </div>
            {oiData && oiData.currentOi ? (
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                <div className="col-span-2">
                  <span style={{ color: '#d1d4dc' }} className="text-sm font-bold">{oiData.currentOi.toFixed(1)} {baseAsset}</span>
                  <span className="text-[9px] ml-1" style={{ color: '#5d6070' }}>(${(oiData.currentOi * lp / 1e6).toFixed(1)}M)</span>
                </div>
                <div><span style={{ color: '#5d6070' }}>5m:</span> <span style={{ color: (oiData.oi5m || 0) >= 0 ? '#26a69a' : '#ef5350' }}>{(oiData.oi5m || 0) >= 0 ? '+' : ''}{(oiData.oi5m || 0).toFixed(2)}%</span></div>
                <div><span style={{ color: '#5d6070' }}>1h:</span> <span style={{ color: (oiData.oi1h || 0) >= 0 ? '#26a69a' : '#ef5350' }}>{(oiData.oi1h || 0) >= 0 ? '+' : ''}{(oiData.oi1h || 0).toFixed(2)}%</span></div>
                <div className="col-span-2 flex gap-1 mt-0.5">
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${oiData.longBuildUp ? '' : 'opacity-30'}`} style={{ background: '#26a69a18', color: '#26a69a' }}>Long↑</span>
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${oiData.shortBuildUp ? '' : 'opacity-30'}`} style={{ background: '#ef535018', color: '#ef5350' }}>Short↑</span>
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${oiData.shortCovering ? '' : 'opacity-30'}`} style={{ background: '#26a69a18', color: '#26a69a' }}>Cover</span>
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${oiData.longUnwinding ? '' : 'opacity-30'}`} style={{ background: '#ef535018', color: '#ef5350' }}>Unwind</span>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-lg font-bold" style={{ color: '#787b86' }}>UNKNOWN</div>
                <div className="text-[9px] mt-1" style={{ color: '#5d6070' }}>Binance OI unavailable</div>
              </div>
            )}
          </div>

          {/* Funding Rate (CoinDCX Futures) */}
          <div className="p-2 text-xs flex flex-col" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
            <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>Funding</div>
            {fundingData?.currentRate !== undefined && fundingData?.currentRate !== null ? (
              <>
                <div className="text-lg font-bold" style={{ color: fundingData.currentRate > 0 ? '#ef5350' : '#26a69a' }}>
                  {(fundingData.currentRate * 100).toFixed(4)}%
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: '#5d6070' }}>
                  Expected: {fundingData.predictedRate !== null ? `${(fundingData.predictedRate * 100).toFixed(4)}%` : 'N/A'}
                </div>
                <div className="text-[9px]" style={{ color: '#787b86' }}>
                  {fundingData.currentRate > 0.0001 ? 'Longs paying' : fundingData.currentRate < -0.0001 ? 'Shorts paying' : 'Neutral'}
                </div>
              </>
            ) : (
              <>
                <div className="text-lg font-bold" style={{ color: '#787b86' }}>N/A</div>
                <div className="text-[9px] mt-1" style={{ color: '#5d6070' }}>Futures data pending</div>
              </>
            )}
          </div>

          {/* Sessions / Status */}
          <div className="p-2 text-xs flex flex-col" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
            <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>Active Session</div>
            {activeSession ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold" style={{ color: activeSession[1].color }}>{activeSession[1].label}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: activeSession[1].color + '18', color: activeSession[1].color }}>
                  {baseAsset} PERP
                </span>
              </div>
            ) : (
              <div className="text-xs" style={{ color: '#787b86' }}>Outside major sessions</div>
            )}
            <div className="flex gap-1 mt-1">
              {Object.entries(SESSION_WINDOWS).map(([k, w]) => (
                <div key={k} className="px-1.5 py-0.5 text-[8px] font-bold rounded" style={{ background: '#0a0e17', color: w.color, border: `1px solid ${w.color}30` }}>
                  {w.label.slice(0, 3)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
