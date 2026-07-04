// TradingView-style Chart — dark theme, candles, volume, price line

"use client";

import { useEffect, useRef, memo } from "react";
import { createChart, ColorType } from "lightweight-charts";
import type { IChartApi } from "lightweight-charts";

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

  useEffect(() => {
    if (!containerRef.current || !data || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

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
        scaleMargins: { top: 0.05, bottom: volume && volume.length ? 0.22 : 0.05 },
      },
      timeScale: {
        borderColor: "#2a2e39",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height,
    });

    // ── Candlestick Series ──
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderDownColor: "#ef5350",
      borderUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      wickUpColor: "#26a69a",
    });
    candleSeries.setData(data);

    // ── Last price line ──
    const lastPrice = data[data.length - 1]?.close || 0;
    candleSeries.createPriceLine({
      price: lastPrice,
      color: lastPrice >= data[0]?.open ? "#26a69a" : "#ef5350",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "",
    });

    // ── Volume Histogram ──
    if (volume && volume.length) {
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volumeSeries.setData(volume);
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

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
      }
    };
  }, [data, volume, height]);

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
      {/* TradingView watermark */}
      <div className="absolute bottom-2 left-3 pointer-events-none opacity-20">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 3h7v7H3V3zm0 11h7v7H3v-7zm11-11h7v7h-7V3zm0 11h7v7h-7v-7z" fill="#d1d4dc"/>
        </svg>
      </div>
    </div>
  );
});
