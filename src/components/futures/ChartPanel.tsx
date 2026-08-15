'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

type IChartApi = ReturnType<typeof createChart>;
type ICandleSeries = ReturnType<ReturnType<typeof createChart>['addSeries']>;

interface Props {
  market: string;
  timeframe?: string;
  onTimeframeChange?: (tf: string) => void;
  ticker?: any;
  livePrice?: number | null;
  liveConnected?: boolean;
}

const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

function toPair(market: string): string {
  if (!market) return '';
  const quote = market.endsWith('INR') ? 'INR' : market.endsWith('BTC') ? 'BTC' : 'USDT';
  const base = quote === 'INR' ? market.slice(0, -3) : quote === 'BTC' ? market.slice(0, -3) : market.slice(0, -4);
  if (!base) return '';
  return `B-${base}_${quote}`;
}

export function ChartPanel({ market, timeframe = '15m', onTimeframeChange, ticker, livePrice, liveConnected }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ICandleSeries | null>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  const changeRef = useRef<HTMLSpanElement>(null);
  // Last candle known to the chart (for live-forming animation).
  const lastCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);

  // Live price header — wired to the ticker feed.
  const lp = ticker ? parseFloat(ticker.last_price || ticker.lastPrice || '0') : 0;
  const ch = ticker ? parseFloat(ticker.change_24_hour || ticker.priceChange || '0') : 0;
  const isBull = ch >= 0;

  useEffect(() => {
    if (priceRef.current && lp > 0) {
      priceRef.current.textContent = lp.toLocaleString(undefined, { maximumFractionDigits: 2 });
      priceRef.current.style.color = isBull ? '#26a69a' : '#ef5350';
    }
    if (changeRef.current) {
      changeRef.current.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
      changeRef.current.style.color = isBull ? '#26a69a' : '#ef5350';
    }
  }, [lp, ch, isBull]);

  // Animate the last (forming) candle using the live price, so the chart
  // visibly moves between candle polls. Two live sources feed this:
  //   - livePrice: CoinDCX WebSocket tick-by-tick (preferred, sub-second)
  //   - ticker:    REST poll every 10s (fallback)
  // CoinDCX's candle feed only returns closed bars and can lag by minutes —
  // this fills the gap.
  const animPrice = livePrice && livePrice > 0 ? livePrice : lp;

  useEffect(() => {
    if (!seriesRef.current || animPrice <= 0) return;
    const last = lastCandleRef.current;
    if (!last) return;
    // Only animate if the price is inside the current forming bar's time window.
    const intervalMs = tfMs(timeframe);
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - last.time > intervalMs) return; // bar already closed, wait for fetch
    seriesRef.current.update({
      time: last.time as any,
      open: last.open,
      high: Math.max(last.high, animPrice),
      low: Math.min(last.low, animPrice),
      close: animPrice,
    });
  }, [animPrice, timeframe]);

  const fetchCandles = useCallback(async () => {
    if (!market) return;
    try {
      const pair = toPair(market);
      if (!pair) return;
      const res = await fetch(`/api/coindcx/market?action=candles&pair=${pair}&interval=${timeframe}&limit=300`);
      const json = await res.json();
      if (json.success && json.data) {
        const candles = json.data
          .filter((c: any) => c.time)
          .map((c: any) => ({
            time: Math.floor(c.time / 1000) as any,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
          .sort((a: any, b: any) => a.time - b.time);
        if (candles.length > 0) {
          seriesRef.current?.setData(candles);
          lastCandleRef.current = candles[candles.length - 1];
        }
      }
    } catch {}
  }, [market, timeframe]);

  useEffect(() => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lastCandleRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0e17' },
        textColor: '#787b86',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: 0 },
      timeScale: { borderColor: '#1e222d', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1e222d', scaleMargins: { top: 0.1, bottom: 0.25 } },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderDownColor: '#ef5350',
      borderUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      wickUpColor: '#26a69a',
    });
    seriesRef.current = series;

    fetchCandles();
    // Poll closed candles more frequently (10s) for fresh bar prints.
    const interval = setInterval(fetchCandles, 10000);

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lastCandleRef.current = null;
    };
  }, [market, timeframe, fetchCandles]);

  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const activeSession = h >= 18.5 && h < 27.5 ? 'NEW YORK' : h >= 13.5 && h < 22.5 ? 'LONDON' : h >= 7.5 && h < 16.5 ? 'TOKYO' : h >= 5.5 && h < 12.5 ? 'SYDNEY' : '';

  return (
    <div className="relative flex flex-col h-full" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid #1e222d' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: '#d1d4dc' }} ref={priceRef} id="chart-price">---</span>
          <span className="text-[10px]" ref={changeRef} id="chart-change" style={{ color: '#787b86' }} />
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider"
            style={{ background: liveConnected ? '#26a69a18' : '#787b8618', color: liveConnected ? '#26a69a' : '#787b86', border: `1px solid ${liveConnected ? '#26a69a40' : '#787b8640'}` }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: liveConnected ? '#26a69a' : '#787b86', boxShadow: liveConnected ? '0 0 6px #26a69a' : 'none', animation: liveConnected ? 'liveblink 1s infinite' : 'none' }} />
            {liveConnected ? 'LIVE' : 'POLL'}
          </span>
          <style>{`@keyframes liveblink { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>
        </div>
        <div className="flex gap-1">
          {TFS.map(tf => (
            <button key={tf}
              onClick={() => onTimeframeChange?.(tf)}
              className="px-2 py-0.5 text-[10px] font-bold rounded transition-all cursor-pointer"
              style={{ background: tf === timeframe ? '#1e3a5f' : 'transparent', color: tf === timeframe ? '#d1d4dc' : '#787b86', border: `1px solid ${tf === timeframe ? '#2157f3' : '#1e222d'}` }}>
              {tf.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 relative" style={{ minHeight: 280 }}>
        <div ref={containerRef} className="w-full h-full" />
        {activeSession && (
          <div className="absolute top-2 right-3 text-[9px] font-bold uppercase px-2 py-0.5 rounded" style={{ background: '#ff5d0015', color: '#ff5d00', border: '1px solid #ff5d0040' }}>
            {activeSession} SESSION
          </div>
        )}
      </div>
    </div>
  );
}

function tfMs(tf: string): number {
  const m = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 } as Record<string, number>;
  return (m[tf] || 900) * 1000;
}