// TradingView-style Chart — dynamic real-time updates, candles, volume, price line

"use client";

import { useEffect, useRef, memo } from "react";
import { createChart, ColorType, CandlestickSeries, HistogramSeries } from "lightweight-charts";
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

interface TVChartProps {
  data: any[];
  volume?: any[];
  height?: number;
}

export const TVChart = memo(function TVChart({
  data,
  volume,
  height = 500,
}: TVChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const priceLineRef = useRef<any>(null);
  const lastDataLenRef = useRef(0);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#131722" },
        textColor: "#d1d4dc",
        fontSize: 11,
        fontFamily: "'Trebuchet MS', sans-serif",
      },
      grid: {
        vertLines: { color: "#1e222d" },
        horzLines: { color: "#1e222d" },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "#758696", width: 1, style: 2, labelBackgroundColor: "#363a45" },
        horzLine: { color: "#758696", width: 1, style: 2, labelBackgroundColor: "#363a45" },
      },
      rightPriceScale: {
        borderColor: "#2a2e39",
        scaleMargins: { top: 0.05, bottom: 0.22 },
      },
      timeScale: {
        borderColor: "#2a2e39",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderDownColor: "#ef5350",
      borderUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      wickUpColor: "#26a69a",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    lastDataLenRef.current = 0;

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (chartRef.current && e.contentRect.width > 0) {
          chartRef.current.applyOptions({ width: e.contentRect.width });
        }
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
      }
    };
  }, [height]);

  // Update data dynamically — incremental update for speed
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;
    if (!data || data.length === 0) return;

    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const prevLen = lastDataLenRef.current;

    if (prevLen === 0) {
      // Initial load — set all data
      candleSeries.setData(data);
      if (volumeSeries && volume?.length) {
        volumeSeries.setData(volume);
      }
    } else if (data.length > prevLen) {
      // New candles added — update last existing + add new ones
      if (data.length > 1) {
        candleSeries.update(data[data.length - 2]);
      }
      candleSeries.update(data[data.length - 1]);
      if (volumeSeries && volume?.length && volume.length > 1) {
        volumeSeries.update(volume[volume.length - 2]);
        volumeSeries.update(volume[volume.length - 1]);
      }
    } else if (data.length === prevLen) {
      // Same length — just update last candle (live price tick)
      const last = data[data.length - 1];
      candleSeries.update(last);
      if (volumeSeries && volume?.length) {
        volumeSeries.update(volume[volume.length - 1]);
      }
    } else {
      // Data reset (different symbol etc.) — full reload
      candleSeries.setData(data);
      if (volumeSeries && volume?.length) {
        volumeSeries.setData(volume);
      }
    }

    lastDataLenRef.current = data.length;

    // Update price line
    if (priceLineRef.current) {
      candleSeries.removePriceLine(priceLineRef.current);
    }
    const lastPrice = data[data.length - 1]?.close || 0;
    priceLineRef.current = candleSeries.createPriceLine({
      price: lastPrice,
      color: lastPrice >= data[0]?.open ? "#26a69a" : "#ef5350",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "",
    });

    chartRef.current.timeScale().fitContent();
  }, [data, volume]);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-xs bg-[#131722] rounded" style={{ height }}>
        No candle data available
      </div>
    );
  }

  return (
    <div className="relative rounded overflow-hidden border border-[#2a2e39]">
      <div ref={containerRef} />
      <div className="absolute bottom-2 left-3 pointer-events-none opacity-20">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 3h7v7H3V3zm0 11h7v7H3v-7zm11-11h7v7h-7V3zm0 11h7v7h-7v-7z" fill="#d1d4dc"/>
        </svg>
      </div>
    </div>
  );
});
