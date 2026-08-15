'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';
import { ChartToolbar } from './ChartToolbar';

type IChartApi = ReturnType<typeof createChart>;
type ICandleSeries = ReturnType<ReturnType<typeof createChart>['addSeries']>;

interface Props {
  symbol?: string; // NIFTY, BANKNIFTY, etc.
}

const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d', '1w', '1M'];

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

function tfMs(tf: string): number {
  const m = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600,
    '1d': 86400, '1w': 604800, '1M': 2592000,
  } as Record<string, number>;
  return (m[tf] || 300) * 1000;
}

export function IndiaMarketChart({ symbol = 'NIFTY' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ICandleSeries | null>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  const changeRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const lastCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);

  const [activeSymbol, setActiveSymbol] = useState(symbol);
  const [timeframe, setTimeframe] = useState('1m');
  const [live, setLive] = useState(false);
  const [spot, setSpot] = useState(0);
  const [dayOpen, setDayOpen] = useState(0);
  const [bars, setBars] = useState<Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>([]);
  const liveRef = useRef(live);

  useEffect(() => { liveRef.current = live; }, [live]);

  // ── Historical candles (seeded from Breeze real data) ──
  const fetchCandles = useCallback(async (sym: string, tf: string) => {
    try {
      const res = await fetch(`/api/breeze/candles?symbol=${sym}&interval=${tf}&limit=300`);
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
          if (candles.length > 0) setDayOpen(candles[0].open);
          setBars(candles);
        }
      }
    } catch {}
  }, []);

  // ── Live tick via SSE bridge to Breeze WebSocket ──
  useEffect(() => {
    let es: EventSource | null = null;
    setLive(false);
    setSpot(0);

    es = new EventSource(`/api/breeze/stream?symbol=${activeSymbol}`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'tick' && msg.tick) {
          const ltp = Number(msg.tick.ltp ?? msg.tick.close ?? 0);
          if (!ltp) return;
          setSpot(ltp);
          setLive(true);
          if (!dayOpen && msg.tick.open) setDayOpen(Number(msg.tick.open));

          // Animate forming candle
          const series = seriesRef.current;
          const last = lastCandleRef.current;
          if (series && last) {
            const intervalMs = tfMs(timeframe);
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec - last.time <= intervalMs) {
              series.update({
                time: last.time as any,
                open: last.open,
                high: Math.max(last.high, ltp),
                low: Math.min(last.low, ltp),
                close: ltp,
              });
            }
          }
        } else if (msg.type === 'error') {
          setLive(false);
        }
      } catch {}
    };
    es.onerror = () => { setLive(false); };

    return () => { es?.close(); };
  }, [activeSymbol, timeframe, dayOpen]);

  // ── Chart init ──
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

    fetchCandles(activeSymbol, timeframe);

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [activeSymbol, timeframe, fetchCandles]);

  // ── Header price/change ──
  useEffect(() => {
    if (priceRef.current && spot > 0) {
      priceRef.current.textContent = spot.toLocaleString('en-IN', { maximumFractionDigits: 2 });
      priceRef.current.style.color = dayOpen > 0 && spot >= dayOpen ? '#26a69a' : '#ef5350';
    }
    if (changeRef.current && dayOpen > 0 && spot > 0) {
      const pct = ((spot - dayOpen) / dayOpen) * 100;
      changeRef.current.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      changeRef.current.style.color = pct >= 0 ? '#26a69a' : '#ef5350';
    }
  }, [spot, dayOpen]);

  return (
    <div className="relative flex flex-col h-full" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid #1e222d' }}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#787b86' }}>India · Breeze Live</span>
          <span className="text-sm font-bold" style={{ color: '#d1d4dc' }} ref={priceRef} id="india-price">---</span>
          <span className="text-[10px]" ref={changeRef} id="india-change" style={{ color: '#787b86' }} />
          <span ref={statusRef}
            className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider"
            style={{ background: live ? '#26a69a18' : '#787b8618', color: live ? '#26a69a' : '#787b86', border: `1px solid ${live ? '#26a69a40' : '#787b8640'}` }}>
            {live ? '● LIVE' : '○ CLOSED'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {SYMBOLS.map(s => (
            <button key={s}
              onClick={() => setActiveSymbol(s)}
              className="px-2 py-0.5 text-[9px] font-bold rounded transition-all cursor-pointer"
              style={{ background: s === activeSymbol ? '#1e3a5f' : 'transparent', color: s === activeSymbol ? '#d1d4dc' : '#787b86', border: `1px solid ${s === activeSymbol ? '#2157f3' : '#1e222d'}` }}>
              {s.replace('NIFTY', 'NIFTY')}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {TFS.map(tf => (
            <button key={tf}
              onClick={() => setTimeframe(tf)}
              className="px-2 py-0.5 text-[10px] font-bold rounded transition-all cursor-pointer"
              style={{ background: tf === timeframe ? '#1e3a5f' : 'transparent', color: tf === timeframe ? '#d1d4dc' : '#787b86', border: `1px solid ${tf === timeframe ? '#2157f3' : '#1e222d'}` }}>
              {tf.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <ChartToolbar chart={chartRef.current} candleSeries={seriesRef.current} bars={bars} />
      <div className="flex-1 relative" style={{ minHeight: 280 }}>
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}