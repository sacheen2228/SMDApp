'use client';

// TradingView-style chart toolbar: indicator toggles (SMA/EMA/Bollinger/RSI/
// VWAP/Volume), horizontal price-line drawing, crosshair mode, reset zoom and
// fullscreen. Works on top of any lightweight-charts instance that exposes the
// chart + candle series + the raw bars.

import { useEffect, useRef, useState } from 'react';
import {
  LineSeries,
  HistogramSeries,
  createChart,
} from 'lightweight-charts';
import { sma, ema, bollinger, rsi, vwap, type Bar } from '@/lib/indicators';

type IChartApi = ReturnType<typeof createChart>;
type ISeries = ReturnType<ReturnType<typeof createChart>['addSeries']>;

interface Props {
  chart: IChartApi | null;
  candleSeries: ISeries | null;
  bars: Bar[];
}

type IndicatorId = 'SMA' | 'EMA' | 'BB' | 'RSI' | 'VWAP' | 'VOL';

interface SeriesRef {
  series: ISeries;
  kind: 'overlay' | 'pane' | 'hist';
}

export function ChartToolbar({ chart, candleSeries, bars }: Props) {
  const [indicators, setIndicators] = useState<Record<IndicatorId, boolean>>({
    SMA: false, EMA: false, BB: false, RSI: false, VWAP: false, VOL: false,
  });
  const [crosshair, setCrosshair] = useState<'cross' | 'normal' | 'off'>('cross');
  const [lineMode, setLineMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [vLines, setVLines] = useState<Array<{ id: string; price: number }>>([]);

  const overlaySeriesRef = useRef<Map<IndicatorId, SeriesRef>>(new Map());
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lineStateRef = useRef<{ start: number; startPrice: number } | null>(null);

  // When the host chart instance changes (timeframe/market switch recreates it),
  // any overlay series held here belong to the old chart — drop them.
  useEffect(() => {
    overlaySeriesRef.current.clear();
  }, [chart]);

  // Rebuild all active indicator series whenever bars change.
  useEffect(() => {
    if (!chart || !bars || bars.length === 0) return;
    const active = Object.entries(indicators).filter(([, v]) => v).map(([k]) => k as IndicatorId);
    for (const [k, entry] of overlaySeriesRef.current) {
      if (!active.includes(k)) {
        try { chart.removeSeries(entry.series); } catch {}
        overlaySeriesRef.current.delete(k);
      }
    }
    for (const id of active) {
      let entry = overlaySeriesRef.current.get(id);
      if (!entry) {
        if (id === 'RSI' || id === 'VOL') {
          const series = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'custom', formatter: (v: any) => v == null ? '-' : Number(v).toFixed(id === 'RSI' ? 1 : 0) },
          });
          if (id === 'RSI') {
            series.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, autoScale: true });
          } else {
            series.priceScale().applyOptions({ scaleMargins: { top: 0.9, bottom: 0 } });
          }
          entry = { series, kind: id === 'RSI' ? 'pane' : 'hist' };
        } else {
          const series = chart.addSeries(LineSeries, {
            color: id === 'SMA' ? '#f5a623' : id === 'EMA' ? '#e040fb' : id === 'BB' ? '#64b5f6' : '#26c6da',
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          entry = { series, kind: 'overlay' };
        }
        overlaySeriesRef.current.set(id, entry);
      }
      const s = entry.series;
      if (id === 'SMA') s.setData(sma(bars, 20));
      else if (id === 'EMA') s.setData(ema(bars, 50));
      else if (id === 'VWAP') s.setData(vwap(bars));
      else if (id === 'BB') {
        const bb = bollinger(bars, 20, 2);
        const upper = chart.addSeries(LineSeries, { color: '#64b5f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const lower = chart.addSeries(LineSeries, { color: '#64b5f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        upper.setData(bb.upper);
        lower.setData(bb.lower);
        s.setData(bb.middle);
        overlaySeriesRef.current.set('BB_L', { series: upper, kind: 'overlay' });
        overlaySeriesRef.current.set('BB_U', { series: lower, kind: 'overlay' });
      } else if (id === 'RSI') {
        const r = rsi(bars, 14);
        s.setData(r.map(({ time, value }) => ({ time, value, color: value >= 70 ? '#ef5350' : value <= 30 ? '#26a69a' : '#787b86' })));
      } else if (id === 'VOL') {
        s.setData(bars.map(b => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? '#26a69a66' : '#ef535066' })));
      }
    }
  }, [chart, bars, indicators]);

  const toggleIndicator = (id: IndicatorId) => {
    setIndicators(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const resetZoom = () => {
    if (!chart) return;
    chart.timeScale().resetTimeScale();
    chart.timeScale().fitContent();
  };

  const toggleFullscreen = () => {
    if (!hostRef.current) return;
    if (!document.fullscreenElement) {
      hostRef.current.requestFullscreen?.();
      setFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setFullscreen(false);
    }
  };

  // Horizontal / trend line drawing mode.
  const toggleLineMode = () => {
    setLineMode(m => !m);
    lineStateRef.current = null;
  };

  useEffect(() => {
    if (!chart || !lineMode) return;
    const sub = chart.subscribeClick(param => {
      const t = param?.time as any;
      const price = (param?.point as any)?.y != null && param?.seriesData ? (Object.values(param.seriesData as any)[0] as any)?.value ?? null : null;
      const bar = bars.find(b => b.time === t);
      const p = bar ? bar.close : price;
      if (p == null || t == null) return;
      const id = `vline-${Date.now()}`;
      setVLines(ls => [...ls, { id, price: p }]);
      candleSeries?.createPriceLine({ price: p, color: '#ff5d00', lineWidth: 1, lineStyle: 2 as any, axisLabelVisible: true, title: `P ${p.toFixed(2)}` });
    });
    return () => sub.unsubscribe();
  }, [chart, lineMode, bars, candleSeries]);

  useEffect(() => {
    if (!chart) return;
    chart.applyOptions({ crosshair: { mode: crosshair === 'cross' ? 0 : crosshair === 'normal' ? 1 : 2 } });
  }, [chart, crosshair]);

  const indBtn = (id: IndicatorId, label: string, color: string) => (
    <button
      key={id}
      onClick={() => toggleIndicator(id)}
      className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer"
      style={{
        background: indicators[id] ? `${color}22` : 'transparent',
        color: indicators[id] ? color : '#5d6070',
        border: `1px solid ${indicators[id] ? color + '55' : '#1e222d'}`,
      }}>
      {label}
    </button>
  );

  return (
    <div ref={hostRef} className="flex items-center gap-1 flex-wrap px-2 py-1" style={{ borderBottom: '1px solid #1e222d', background: '#0d1321' }}>
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Indicators</span>
      {indBtn('SMA', 'SMA 20', '#f5a623')}
      {indBtn('EMA', 'EMA 50', '#e040fb')}
      {indBtn('BB', 'BOLL 20', '#64b5f6')}
      {indBtn('VWAP', 'VWAP', '#26c6da')}
      {indBtn('RSI', 'RSI 14', '#ff7043')}
      {indBtn('VOL', 'VOL', '#7e57c2')}
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Draw</span>
      <button
        onClick={toggleLineMode}
        className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer"
        style={{ background: lineMode ? '#ff5d0022' : 'transparent', color: lineMode ? '#ff5d00' : '#5d6070', border: `1px solid ${lineMode ? '#ff5d0055' : '#1e222d'}` }}
        title="Click on chart to drop a price line">
        PRICE LINE
      </button>
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Crosshair</span>
      <select
        value={crosshair}
        onChange={e => setCrosshair(e.target.value as any)}
        className="text-[9px] font-bold rounded px-1 py-0.5 cursor-pointer outline-none"
        style={{ background: '#131722', color: '#787b86', border: '1px solid #1e222d' }}>
        <option value="cross">Cross</option>
        <option value="normal">Magnet</option>
        <option value="off">Off</option>
      </select>
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      <button onClick={resetZoom} className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer" style={{ background: 'transparent', color: '#787b86', border: '1px solid #1e222d' }} title="Reset zoom / fit">
        ⟲ FIT
      </button>
      <button onClick={toggleFullscreen} className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer" style={{ background: 'transparent', color: fullscreen ? '#ff5d00' : '#787b86', border: `1px solid ${fullscreen ? '#ff5d0055' : '#1e222d'}` }} title="Fullscreen">
        {fullscreen ? '⛶ EXIT' : '⛶ FULL'}
      </button>
    </div>
  );
}