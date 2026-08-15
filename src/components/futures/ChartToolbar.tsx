'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  LineSeries,
  HistogramSeries,
  createChart,
  type SeriesApi,
  type IChartApi,
} from 'lightweight-charts';
import { sma, ema, bollinger, rsi, vwap, type Bar } from '@/lib/indicators';

type ISeries = SeriesApi<'Line'> | SeriesApi<'Histogram'>;

interface Props {
  chart: IChartApi | null;
  candleSeries: SeriesApi<'Candlestick'> | null;
  bars: Bar[];
}

type IndicatorId = 'SMA' | 'EMA' | 'BB' | 'RSI' | 'VWAP' | 'VOL';

interface SeriesEntry {
  series: ISeries;
  kind: 'overlay' | 'pane';
}

interface Drawing {
  id: string;
  type: 'hline' | 'trend';
  price?: number;
  points?: Array<{ time: number; price: number }>;
  priceLine?: ReturnType<SeriesApi<'Candlestick'>['createPriceLine']>;
  trendLine?: ReturnType<SeriesApi<'Candlestick'>['createPriceLine']>; // second line for trend
}

export function ChartToolbar({ chart, candleSeries, bars }: Props) {
  const [indicators, setIndicators] = useState<Record<IndicatorId, boolean>>({
    SMA: false, EMA: false, BB: false, RSI: false, VWAP: false, VOL: false,
  });
  const [crosshair, setCrosshair] = useState<'cross' | 'magnet' | 'off'>('cross');
  const [drawMode, setDrawMode] = useState<'none' | 'hline' | 'trend'>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [trendStart, setTrendStart] = useState<{ time: number; price: number } | null>(null);

  const overlayRef = useRef<Map<string, SeriesEntry>>(new Map());

  // ── Indicator overlay/pane management ──────────────────────────────
  useEffect(() => {
    if (!chart || !bars || bars.length === 0) return;
    const active = Object.entries(indicators).filter(([, v]) => v).map(([k]) => k as IndicatorId);
    const mainScale = candleSeries?.priceScale();

    // Remove deactivated
    for (const [k, entry] of overlayRef.current) {
      if (!active.includes(k as IndicatorId)) {
        try { chart.removeSeries(entry.series); } catch {}
        overlayRef.current.delete(k);
      }
    }

    // Add/update active - process panes first to reserve space
    const paneIds = active.filter(id => id === 'RSI' || id === 'VOL');
    const overlayIds = active.filter(id => id !== 'RSI' && id !== 'VOL');

    // Pane indicators: RSI takes bottom 25%, VOL takes next 15% (70-85%)
    // Only allow one pane at a time to avoid overlap issues in v5 free
    const paneToShow = paneIds[0]; // Priority: RSI > VOL
    for (const id of ['RSI', 'VOL']) {
      const shouldShow = id === paneToShow && active.includes(id as IndicatorId);
      let entry = overlayRef.current.get(id);
      if (shouldShow && !entry) {
        const series = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'custom', formatter: (v: any) => v == null ? '-' : Number(v).toFixed(id === 'RSI' ? 1 : 0) },
        });
        // RSI: bottom 25% (top: 0.75), VOL: 70-85% (top: 0.7, bottom: 0.15)
        series.priceScale().applyOptions({
          scaleMargins: { top: id === 'RSI' ? 0.75 : 0.7, bottom: id === 'RSI' ? 0 : 0.15 },
          autoScale: true,
        });
        entry = { series, kind: 'pane' };
        overlayRef.current.set(id, entry);
      } else if (!shouldShow && entry) {
        try { chart.removeSeries(entry.series); } catch {}
        overlayRef.current.delete(id);
      }
      if (entry && shouldShow) {
        if (id === 'RSI') {
          const r = rsi(bars, 14);
          entry.series.setData(r.map(({ time, value }) => ({ time, value, color: value >= 70 ? '#ef5350' : value <= 30 ? '#26a69a' : '#787b86' })));
        } else {
          entry.series.setData(bars.map(b => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? '#26a69a66' : '#ef535066' })));
        }
      }
    }

    // Overlay indicators share main price scale
    for (const id of overlayIds) {
      let entry = overlayRef.current.get(id);
      if (!entry) {
        const series = chart.addSeries(LineSeries, {
          color: id === 'SMA' ? '#f5a623' : id === 'EMA' ? '#e040fb' : id === 'BB' ? '#64b5f6' : '#26c6da',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceScale: mainScale,
        });
        entry = { series, kind: 'overlay' };
        overlayRef.current.set(id, entry);
      }
      const s = entry.series;
      if (id === 'SMA') s.setData(sma(bars, 20));
      else if (id === 'EMA') s.setData(ema(bars, 50));
      else if (id === 'VWAP') s.setData(vwap(bars));
      else if (id === 'BB') {
        const bb = bollinger(bars, 20, 2);
        if (!overlayRef.current.has('BB_U')) {
          const up = chart.addSeries(LineSeries, { color: '#64b5f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceScale: mainScale });
          const lo = chart.addSeries(LineSeries, { color: '#64b5f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceScale: mainScale });
          up.setData(bb.upper);
          lo.setData(bb.lower);
          overlayRef.current.set('BB_U', { series: up, kind: 'overlay' });
          overlayRef.current.set('BB_L', { series: lo, kind: 'overlay' });
        } else {
          overlayRef.current.get('BB_U')!.series.setData(bb.upper);
          overlayRef.current.get('BB_L')!.series.setData(bb.lower);
        }
        s.setData(bb.middle);
      }
    }
  }, [chart, bars, indicators]);

  // ── Crosshair mode ────────────────────────────────────────────────
  useEffect(() => {
    if (!chart) return;
    chart.applyOptions({ crosshair: { mode: crosshair === 'cross' ? 0 : crosshair === 'magnet' ? 1 : 2 } });
  }, [chart, crosshair]);

  // ── Drawing click handler ─────────────────────────────────────────
  useEffect(() => {
    if (!chart || !candleSeries || drawMode === 'none') return;
    const handler = (param: any) => {
      const t = param?.time as any;
      const bar = bars.find(b => b.time === t);
      if (!bar) return;
      const p = bar.close;
      if (drawMode === 'hline') {
        const id = `hline-${Date.now()}`;
        const pl = candleSeries.createPriceLine({
          price: p, color: '#ff5d00', lineWidth: 1.5, lineStyle: 2 as any,
          axisLabelVisible: true, title: `P ${p.toFixed(2)}`,
        });
        setDrawings(d => [...d, { id, type: 'hline', price: p, priceLine: pl }]);
        setDrawMode('none');
      } else if (drawMode === 'trend') {
        if (!trendStart) {
          setTrendStart({ time: t, price: p });
        } else {
          const id = `trend-${Date.now()}`;
          const pl1 = candleSeries.createPriceLine({
            price: trendStart.price, color: '#ff5d00', lineWidth: 1.5, lineStyle: 2 as any,
            axisLabelVisible: true, title: `T ${trendStart.price.toFixed(2)}`,
          });
          const pl2 = candleSeries.createPriceLine({
            price: p, color: '#ff5d00', lineWidth: 1.5, lineStyle: 2 as any,
            axisLabelVisible: true, title: `T ${p.toFixed(2)}`,
          });
          setDrawings(d => [...d, { id, type: 'trend', points: [trendStart, { time: t, price: p }], priceLine: pl1, trendLine: pl2 }]);
          setTrendStart(null);
          setDrawMode('none');
        }
      }
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [chart, candleSeries, drawMode, bars, trendStart]);

  // ── Delete drawing on double-click ────────────────────────────────
  useEffect(() => {
    if (!chart) return;
    const handler = (param: any) => {
      const t = param?.time as any;
      // Check if click is near a drawing
      for (const d of drawings) {
        if (d.type === 'hline' && d.priceLine) {
          const linePrice = d.priceLine.options().price;
          const bar = bars.find(b => b.time === t);
          if (bar && Math.abs(bar.close - linePrice) / linePrice < 0.001) {
            d.priceLine.remove();
            setDrawings(ds => ds.filter(x => x.id !== d.id));
            return;
          }
        } else if (d.type === 'trend' && d.points) {
          const [p1, p2] = d.points;
          const bar = bars.find(b => b.time === t);
          if (bar) {
            // Check if click is near the trend line
            const slope = (p2.price - p1.price) / (p2.time - p1.time);
            const expectedPrice = p1.price + slope * (t - p1.time);
            if (Math.abs(bar.close - expectedPrice) / expectedPrice < 0.002) {
              d.priceLine?.remove();
              d.trendLine?.remove();
              setDrawings(ds => ds.filter(x => x.id !== d.id && x.id !== `${d.id}b`));
              return;
            }
          }
        }
      }
    };
    chart.subscribeDblClick(handler);
    return () => chart.unsubscribeDblClick(handler);
  }, [chart, drawings, bars]);

  const toggleIndicator = (id: IndicatorId) => setIndicators(p => ({ ...p, [id]: !p[id] }));
  const startDraw = (type: 'hline' | 'trend') => { setDrawMode(type); setTrendStart(null); };
  const cancelDraw = () => { setDrawMode('none'); setTrendStart(null); };
  const clearDrawings = () => {
    drawings.forEach(d => { try { d.priceLine?.remove(); d.trendLine?.remove(); } catch {} });
    setDrawings([]);
  };
  const resetZoom = () => { if (chart) { chart.timeScale().resetTimeScale(); chart.timeScale().fitContent(); } };
  const toggleFull = () => {
    const host = document.getElementById('chart-host');
    if (!host) return;
    if (!document.fullscreenElement) host.requestFullscreen?.(); else document.exitFullscreen?.();
  };

  const indBtn = (id: IndicatorId, label: string, color: string) => (
    <button key={id} onClick={() => toggleIndicator(id)}
      className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer"
      style={{ background: indicators[id] ? `${color}22` : 'transparent', color: indicators[id] ? color : '#5d6070',
        border: `1px solid ${indicators[id] ? color + '55' : '#1e222d'}` }}>
      {label}
    </button>
  );

  const toolBtn = (label: string, active: boolean, onClick: () => void, color = '#5d6070') => (
    <button onClick={onClick}
      className="px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer"
      style={{ background: active ? `${color}22` : 'transparent', color: active ? color : '#5d6070',
        border: `1px solid ${active ? color + '55' : '#1e222d'}` }}>
      {label}
    </button>
  );

  return (
    <div id="chart-host" className="flex items-center gap-1 flex-wrap px-2 py-1" style={{ borderBottom: '1px solid #1e222d', background: '#0d1321' }}>
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Indicators</span>
      {indBtn('SMA', 'SMA 20', '#f5a623')}
      {indBtn('EMA', 'EMA 50', '#e040fb')}
      {indBtn('BB', 'BOLL 20', '#64b5f6')}
      {indBtn('VWAP', 'VWAP', '#26c6da')}
      {indBtn('RSI', 'RSI 14', '#ff7043')}
      {indBtn('VOL', 'VOL', '#7e57c2')}
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Draw</span>
      {toolBtn('H-LINE', drawMode === 'hline', () => startDraw('hline'), '#ff5d00')}
      {toolBtn('TREND', drawMode === 'trend', () => startDraw('trend'), '#ff5d00')}
      {drawMode !== 'none' && toolBtn('CANCEL', true, cancelDraw, '#ef5350')}
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      <span className="text-[8px] font-bold uppercase tracking-wider mr-1" style={{ color: '#5d6070' }}>Crosshair</span>
      <select value={crosshair} onChange={e => setCrosshair(e.target.value as any)}
        className="text-[9px] font-bold rounded px-1 py-0.5 cursor-pointer outline-none"
        style={{ background: '#131722', color: '#787b86', border: '1px solid #1e222d' }}>
        <option value="cross">Cross</option>
        <option value="magnet">Magnet</option>
        <option value="off">Off</option>
      </select>
      <span className="mx-1 h-4 w-px" style={{ background: '#1e222d' }} />
      {toolBtn('⟲ FIT', false, resetZoom)}
      {toolBtn('⛶ FULL', false, toggleFull)}
      {toolBtn('🗑 CLEAR', false, clearDrawings, '#ef5350')}
    </div>
  );
}