// TradingView Lightweight Chart — candlestick + volume + indicators

"use client";

import { useEffect, useRef, memo } from "react";
import { createChart, ColorType, CandlestickData, HistogramData, LineData } from "lightweight-charts";

interface TVChartProps {
  data: CandlestickData[];
  volume?: HistogramData[];
  ema20?: LineData[];
  ema50?: LineData[];
  height?: number;
  autoScroll?: boolean;
}

export const TVChart = memo(function TVChart({
  data,
  volume,
  ema20,
  ema50,
  height = 300,
  autoScroll = true,
}: TVChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "hsl(240 3.7% 44.9%)",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "hsl(240 3.7% 15% / 0.3)" },
        horzLines: { color: "hsl(240 3.7% 15% / 0.3)" },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "hsl(240 3.7% 44.9% / 0.4)", width: 1, style: 2 },
        horzLine: { color: "hsl(240 3.7% 44.9% / 0.4)", width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: "hsl(240 3.7% 15% / 0.5)",
        scaleMargins: { top: 0.1, bottom: volume && volume.length ? 0.25 : 0.1 },
      },
      timeScale: {
        borderColor: "hsl(240 3.7% 15% / 0.5)",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height,
    });

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor: "hsl(142 76% 36%)",
      downColor: "hsl(0 84% 60%)",
      borderDownColor: "hsl(0 84% 60%)",
      borderUpColor: "hsl(142 76% 36%)",
      wickDownColor: "hsl(0 84% 60% / 0.6)",
      wickUpColor: "hsl(142 76% 36% / 0.6)",
    });
    candleSeries.setData(data);

    // Volume histogram
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

    // EMA 20
    if (ema20 && ema20.length) {
      const ema20Series = chart.addLineSeries({
        color: "hsl(262 83% 58% / 0.7)",
        lineWidth: 1,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ema20Series.setData(ema20);
    }

    // EMA 50
    if (ema50 && ema50.length) {
      const ema50Series = chart.addLineSeries({
        color: "hsl(38 92% 50% / 0.7)",
        lineWidth: 1,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ema50Series.setData(ema50);
    }

    // Auto-scroll to last candle
    if (autoScroll) {
      chart.timeScale().scrollToRealTime();
    }

    chartRef.current = chart;

    // Resize observer
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, volume, ema20, ema50, height, autoScroll]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded overflow-hidden"
      style={{ height: `${height}px` }}
    />
  );
});
