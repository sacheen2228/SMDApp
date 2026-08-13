'use client';

import { useEffect, useState } from 'react';

interface Props {
  market: string;
}

function toPair(market: string): string {
  const base = market.replace(/USDT$/, '').replace(/INR$/, '').replace(/BTC$/, '');
  const quote = market.endsWith('INR') ? 'INR' : market.endsWith('BTC') ? 'BTC' : 'USDT';
  return `B-${base}_${quote}`;
}

export function OrderBookPanel({ market }: Props) {
  const [asks, setAsks] = useState<[string, string][]>([]);
  const [bids, setBids] = useState<[string, string][]>([]);
  const [trades, setTrades] = useState<Array<{ p: number; q: number; s: string; T: number; m: boolean }>>([]);

  useEffect(() => {
    if (!market) return;
    const fetchData = async () => {
      try {
        const pair = toPair(market);
        const [obRes, tradesRes] = await Promise.all([
          fetch(`/api/coindcx/market?action=orderbook&pair=${pair}`),
          fetch(`/api/coindcx/market?action=trades&pair=${pair}&limit=20`),
        ]);
        const ob = await obRes.json();
        const tr = await tradesRes.json();
        if (ob.success && ob.data) {
          const asksArr = Object.entries(ob.data.asks || {}).map(([p, q]) => [p, q as string] as [string, string]);
          const bidsArr = Object.entries(ob.data.bids || {}).map(([p, q]) => [p, q as string] as [string, string]);
          setAsks(asksArr.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 8));
          setBids(bidsArr.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 8));
        }
        if (tr.success) setTrades((tr.data || []).slice(0, 15));
      } catch {}
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [market]);

  const maxAskVol = Math.max(...asks.map(a => parseFloat(a[1])), 0.001);
  const maxBidVol = Math.max(...bids.map(b => parseFloat(b[1])), 0.001);

  return (
    <div className="p-3 text-xs" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", height: '100%' }}>
      <div className="text-[#787b86] uppercase tracking-wider mb-2">Order Book & Trades</div>

      <div className="text-[#787b86] text-[10px] flex justify-between mb-1 px-1">
        <span>PRICE</span>
        <span>SIZE</span>
        <span>TOTAL</span>
      </div>

      {/* Asks */}
      <div className="mb-1">
        {asks.map(([price, qty]) => (
          <div key={price} className="flex items-center justify-between py-0.5 px-1 relative" style={{ color: '#ef5350' }}>
            <div className="absolute right-0 top-0 bottom-0" style={{ background: 'rgba(239,83,80,0.1)', width: `${(parseFloat(qty) / maxAskVol) * 100}%` }} />
            <span className="relative z-10">{parseFloat(price).toFixed(2)}</span>
            <span className="relative z-10">{parseFloat(qty).toFixed(4)}</span>
            <span className="relative z-10">{(parseFloat(price) * parseFloat(qty)).toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Spread */}
      <div className="text-center py-1 font-bold text-[#d1d4dc] border-y border-[#1e222d] my-1 text-xs">
        {asks.length > 0 && bids.length > 0
          ? `Spread: $${(parseFloat(asks[asks.length - 1][0]) - parseFloat(bids[0][0])).toFixed(2)}`
          : '---'}
      </div>

      {/* Bids */}
      <div className="mb-2">
        {bids.map(([price, qty]) => (
          <div key={price} className="flex items-center justify-between py-0.5 px-1 relative" style={{ color: '#26a69a' }}>
            <div className="absolute right-0 top-0 bottom-0" style={{ background: 'rgba(38,166,154,0.1)', width: `${(parseFloat(qty) / maxBidVol) * 100}%` }} />
            <span className="relative z-10">{parseFloat(price).toFixed(2)}</span>
            <span className="relative z-10">{parseFloat(qty).toFixed(4)}</span>
            <span className="relative z-10">{(parseFloat(price) * parseFloat(qty)).toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Recent Trades */}
      <div className="text-[#787b86] text-[10px] mb-1 uppercase tracking-wider mt-2">Recent Trades</div>
      <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
        {trades.map((t, i) => (
          <div key={i} className="flex justify-between text-[10px] px-1" style={{ color: t.m ? '#ef5350' : '#26a69a' }}>
            <span>{new Date(t.T).toLocaleTimeString()}</span>
            <span>{t.m ? 'SELL' : 'BUY'}</span>
            <span>{t.q.toFixed(4)}</span>
            <span>${t.p.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
