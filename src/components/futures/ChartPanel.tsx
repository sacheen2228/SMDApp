'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

type IChartApi = ReturnType<typeof createChart>;
type ICandleSeries = ReturnType<ReturnType<typeof createChart>['addSeries']>;

interface Props {
  market: string;
  timeframe?: string;
  onTimeframeChange?: (tf: string) => void;
}

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];

function toPair(market: string): string {
  const base = market.replace(/USDT$/, '').replace(/INR$/, '').replace(/BTC$/, '');
  const quote = market.endsWith('INR') ? 'INR' : market.endsWith('BTC') ? 'BTC' : 'USDT';
  return `B-${base}_${quote}`;
}

export function ChartPanel({ market, timeframe = '15m', onTimeframeChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ICandleSeries | null>(null);

  const fetchCandles = useCallback(async () => {
    if (!market) return;
    try {
      const pair = toPair(market);
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
    const interval = setInterval(fetchCandles, 30000);

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
    };
  }, [market, timeframe, fetchCandles]);

  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const activeSession = h >= 18.5 && h < 27.5 ? 'NEW YORK' : h >= 13.5 && h < 22.5 ? 'LONDON' : h >= 7.5 && h < 16.5 ? 'TOKYO' : h >= 5.5 && h < 12.5 ? 'SYDNEY' : '';

  return (
    <div className="relative flex flex-col h-full" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid #1e222d' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: '#d1d4dc' }} id="chart-price">---</span>
          <span className="text-[10px]" id="chart-change" style={{ color: '#787b86' }} />
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
