"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface IndexData {
  symbol: string;
  spot: number;
  change: number;
  changePct: number;
}

interface MarketStatusData {
  isOpen: boolean;
  vix: number;
  pcr: number;
  indices: IndexData[];
  trend: "bullish" | "bearish" | "neutral";
  timeToClose: string;
  lastUpdate: string;
}

function getISTTime(): Date {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
}

function isMarketOpen(): boolean {
  const ist = getISTTime();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeMinutes = hours * 60 + minutes;
  return timeMinutes >= 555 && timeMinutes <= 930; // 9:15 to 15:30
}

function getTimeToClose(): string {
  const ist = getISTTime();
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const seconds = ist.getSeconds();
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  const closeSeconds = 15 * 3600 + 30 * 60; // 15:30
  const diff = closeSeconds - totalSeconds;
  if (diff <= 0) return "CLOSED";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatIST(dateOrStr: Date | string): string {
  const ist = getISTTime();
  return ist.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatPrice(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ChangePill({ value, pct }: { value: number; pct: number }) {
  const isUp = value > 0;
  const isDown = value < 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums ${
        isUp ? "text-emerald-400" : isDown ? "text-red-400" : "text-zinc-400"
      }`}
    >
      {isUp ? <TrendingUp className="size-2.5" /> : isDown ? <TrendingDown className="size-2.5" /> : <Minus className="size-2.5" />}
      {isUp ? "+" : ""}
      {formatPrice(value)}
      <span className="text-[10px] opacity-70">
        ({isUp ? "+" : ""}
        {pct.toFixed(2)}%)
      </span>
    </span>
  );
}

function TrendBadge({ trend }: { trend: "bullish" | "bearish" | "neutral" }) {
  const colors =
    trend === "bullish"
      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
      : trend === "bearish"
      ? "bg-red-500/20 text-red-400 border-red-500/30"
      : "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
  return (
    <Badge variant="outline" className={`${colors} text-[10px] px-1.5 py-0 h-4 font-mono`}>
      {trend === "bullish" ? "▲ BULL" : trend === "bearish" ? "▼ BEAR" : "— FLAT"}
    </Badge>
  );
}

export function MarketStatusBar() {
  const [data, setData] = useState<MarketStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [countdown, setCountdown] = useState("00:00:00");
  const [now, setNow] = useState("");

  const fetchData = useCallback(async () => {
    try {
      // Fetch option chain for NIFTY (primary index with PCR/VIX data)
      const res = await fetch("/api/option-chain?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("API error");

      const summary = json.data?.summary || {};
      const strikes = json.data?.data || [];
      const spotPrice = summary.spotPrice || json.data?.spotPrice || 0;

      // Compute PCR from strikes
      let totalCallOI = 0;
      let totalPutOI = 0;
      for (const s of strikes) {
        totalCallOI += s.ce?.oi || 0;
        totalPutOI += s.pe?.oi || 0;
      }
      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : summary.pcr || 1;
      const vix = summary.indiaVIX || 15;

      // Derive trend from spot change
      const spotChange = summary.spotChange || 0;
      const spotChangePct = summary.spotChangePct || 0;

      // For multi-index display, we show NIFTY as primary and derive others from OI/proxy
      // In a real setup you'd fetch each index separately; here we use NIFTY data as the core
      const niftyChange = spotChange;
      const niftyChangePct = spotChangePct;

      setData({
        isOpen: isMarketOpen(),
        vix,
        pcr,
        indices: [
          { symbol: "NIFTY", spot: spotPrice, change: niftyChange, changePct: niftyChangePct },
          // Other indices would need separate API calls; show placeholder with NIFTY-derived context
        ],
        trend:
          niftyChangePct > 0.3 ? "bullish" : niftyChangePct < -0.3 ? "bearish" : "neutral",
        timeToClose: getTimeToClose(),
        lastUpdate: json.lastUpdate || new Date().toISOString(),
      });
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(getTimeToClose());
      setNow(formatIST(new Date()));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-4 h-10 px-4 bg-[#0a0e17] border-b border-white/5">
        <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
        <div className="h-3 w-24 bg-white/5 animate-pulse rounded" />
        <div className="h-3 w-20 bg-white/5 animate-pulse rounded" />
        <div className="h-3 w-32 bg-white/5 animate-pulse rounded" />
      </div>
    );
  }

  const status = data || {
    isOpen: false,
    vix: 0,
    pcr: 0,
    indices: [],
    trend: "neutral" as const,
    timeToClose: "CLOSED",
    lastUpdate: new Date().toISOString(),
  };

  return (
    <div className="flex items-center gap-3 h-10 px-3 bg-[#0a0e17] border-b border-white/5 text-[11px] font-mono overflow-x-auto scrollbar-none select-none">
      {/* Market Status */}
      <div className="flex items-center gap-1.5 shrink-0">
        {error ? (
          <WifiOff className="size-3 text-red-400" />
        ) : status.isOpen ? (
          <Wifi className="size-3 text-emerald-400" />
        ) : (
          <WifiOff className="size-3 text-zinc-500" />
        )}
        <Badge
          variant="outline"
          className={`text-[10px] px-1.5 py-0 h-4 font-mono ${
            error
              ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
              : status.isOpen
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
          }`}
        >
          {error ? "OFFLINE" : status.isOpen ? "OPEN" : "CLOSED"}
        </Badge>
      </div>

      {/* VIX */}
      <div className="flex items-center gap-1 shrink-0">
        <Zap className="size-2.5 text-amber-400" />
        <span className="text-zinc-500">VIX</span>
        <span className={`font-semibold tabular-nums ${status.vix > 20 ? "text-red-400" : status.vix > 15 ? "text-amber-400" : "text-emerald-400"}`}>
          {status.vix.toFixed(1)}
        </span>
      </div>

      <div className="w-px h-4 bg-white/5 shrink-0" />

      {/* PCR */}
      <div className="flex items-center gap-1 shrink-0">
        <Activity className="size-2.5 text-blue-400" />
        <span className="text-zinc-500">PCR</span>
        <span className={`font-semibold tabular-nums ${status.pcr > 1.2 ? "text-emerald-400" : status.pcr < 0.8 ? "text-red-400" : "text-zinc-300"}`}>
          {status.pcr.toFixed(2)}
        </span>
      </div>

      <div className="w-px h-4 bg-white/5 shrink-0" />

      {/* NIFTY (always present) */}
      {status.indices.map((idx) => (
        <div key={idx.symbol} className="flex items-center gap-1.5 shrink-0">
          <span className="text-zinc-500 font-semibold text-[10px]">{idx.symbol}</span>
          <span className="text-zinc-200 font-semibold tabular-nums">{formatPrice(idx.spot)}</span>
          <ChangePill value={idx.change} pct={idx.changePct} />
        </div>
      ))}

      <div className="w-px h-4 bg-white/5 shrink-0" />

      {/* Trend */}
      <TrendBadge trend={status.trend} />

      <div className="flex-1" />

      {/* Clock + Countdown */}
      <div className="flex items-center gap-3 shrink-0">
        <Clock className="size-3 text-zinc-500" />
        <span className="text-zinc-400 tabular-nums">{now || "--:--:--"}</span>
        {status.isOpen && (
          <span className="text-amber-400/80 tabular-nums text-[10px]">
            CLOSE {countdown}
          </span>
        )}
      </div>
    </div>
  );
}
