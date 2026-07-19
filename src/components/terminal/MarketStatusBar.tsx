"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Activity,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Wifi,
  WifiOff,
  Zap,
  ChevronDown,
  Search,
  X,
  Layers,
  Calendar,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTerminalStore, INDEX_INSTRUMENTS, EQUITY_INSTRUMENTS, ALL_INSTRUMENTS } from "@/stores/useTerminalStore";
import { getAllExpiries } from "@/lib/expiry-calculator";

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
  return timeMinutes >= 555 && timeMinutes <= 930;
}

function getTimeToClose(): string {
  const ist = getISTTime();
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const seconds = ist.getSeconds();
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  const closeSeconds = 15 * 3600 + 30 * 60;
  const diff = closeSeconds - totalSeconds;
  if (diff <= 0) return "CLOSED";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatIST(_dateOrStr: Date | string): string {
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

function ExpirySelector() {
  const { symbol, expiry, setExpiry } = useTerminalStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const allExpiries = getAllExpiries(symbol);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const upcoming = allExpiries.filter(e => e.dateObj >= today).slice(0, 12);

  const current = upcoming.find(e => e.date === expiry);
  const displayLabel = current
    ? `${current.date} (${current.daysToExpiry}d)`
    : "Nearest";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[11px] font-mono text-zinc-300 transition-colors"
      >
        <Calendar className="size-3 text-violet-400" />
        {displayLabel}
        <ChevronDown className={`size-3 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-[#161b22] border border-white/10 rounded-md shadow-xl z-50 overflow-hidden">
          <div className="p-1.5 border-b border-white/5">
            <div className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold px-1">
              {symbol} Expiries
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              onClick={() => { setExpiry(""); setOpen(false); }}
              className={`w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-mono transition-colors ${
                !expiry ? "bg-blue-500/20 text-blue-400" : "text-zinc-300 hover:bg-white/5"
              }`}
            >
              <span className="font-semibold">Nearest</span>
              <span className="text-zinc-500 text-[9px]">Auto-select</span>
            </button>
            {upcoming.map((e) => (
              <button
                key={e.date}
                onClick={() => { setExpiry(e.date); setOpen(false); }}
                className={`w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-mono transition-colors ${
                  expiry === e.date ? "bg-blue-500/20 text-blue-400" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-semibold">{e.date}</span>
                  <Badge
                    variant="outline"
                    className={`text-[7px] px-1 py-0 h-2.5 font-mono ${
                      e.type === "monthly"
                        ? "text-amber-400 border-amber-500/30"
                        : "text-zinc-500 border-zinc-600/30"
                    }`}
                  >
                    {e.type === "monthly" ? "M" : "W"}
                  </Badge>
                </span>
                <span className={`text-[9px] ${e.daysToExpiry === 0 ? "text-red-400 font-semibold" : e.daysToExpiry <= 3 ? "text-amber-400" : "text-zinc-500"}`}>
                  {e.daysToExpiry === 0 ? "TODAY" : `${e.daysToExpiry}d`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InstrumentSelector() {
  const { symbol, setSymbol, customSymbol, setCustomSymbol } = useTerminalStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const query = search.toUpperCase().trim();
  const filteredIndex = INDEX_INSTRUMENTS.filter(
    (i) => !query || i.symbol.includes(query) || i.label.includes(query)
  );
  const filteredEquity = EQUITY_INSTRUMENTS.filter(
    (i) => !query || i.symbol.includes(query) || i.label.includes(query)
  );

  const currentInstrument = ALL_INSTRUMENTS.find((i) => i.symbol === symbol);
  const displayName = currentInstrument
    ? currentInstrument.label
    : symbol;

  function handleSelect(sym: string) {
    setSymbol(sym);
    setCustomSymbol("");
    setSearch("");
    setOpen(false);
  }

  function handleCustomSubmit() {
    const val = customSymbol.toUpperCase().trim();
    if (val) {
      setSymbol(val);
      setSearch("");
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[11px] font-semibold text-zinc-200 font-mono transition-colors"
      >
        <Layers className="size-3 text-blue-400" />
        {displayName}
        <ChevronDown className={`size-3 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-[#161b22] border border-white/10 rounded-md shadow-xl z-50 overflow-hidden">
          <div className="p-2 border-b border-white/5">
            <div className="flex items-center gap-1.5 bg-white/5 rounded px-2 py-1">
              <Search className="size-3 text-zinc-500" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search instrument..."
                className="bg-transparent text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none flex-1 font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filteredIndex.length === 0 && filteredEquity.length === 0) {
                    handleCustomSubmit();
                  }
                  if (e.key === "Escape") setOpen(false);
                }}
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-zinc-500 hover:text-zinc-300">
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {filteredIndex.length > 0 && (
              <div>
                <div className="px-2 py-1 text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">
                  Indices
                </div>
                {filteredIndex.map((inst) => (
                  <button
                    key={inst.symbol}
                    onClick={() => handleSelect(inst.symbol)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-mono transition-colors ${
                      symbol === inst.symbol
                        ? "bg-blue-500/20 text-blue-400"
                        : "text-zinc-300 hover:bg-white/5"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold">{inst.symbol}</span>
                      <span className="text-zinc-500 text-[10px]">{inst.label}</span>
                    </span>
                    <span className="text-zinc-600 text-[9px]">
                      {inst.exchange} · Lot {inst.lotSize}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {filteredEquity.length > 0 && (
              <div>
                <div className="px-2 py-1 text-[9px] text-zinc-500 uppercase tracking-wider font-semibold border-t border-white/5">
                  Equity Options
                </div>
                {filteredEquity.map((inst) => (
                  <button
                    key={inst.symbol}
                    onClick={() => handleSelect(inst.symbol)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-mono transition-colors ${
                      symbol === inst.symbol
                        ? "bg-blue-500/20 text-blue-400"
                        : "text-zinc-300 hover:bg-white/5"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold">{inst.symbol}</span>
                      <span className="text-zinc-500 text-[10px]">{inst.label}</span>
                    </span>
                    <span className="text-zinc-600 text-[9px]">
                      {inst.exchange} · Lot {inst.lotSize}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Custom symbol search */}
            {query && filteredIndex.length === 0 && filteredEquity.length === 0 && (
              <div className="p-2 border-t border-white/5">
                <div className="text-[10px] text-zinc-500 mb-1.5">
                  No matches. Enter custom NSE/BSE symbol:
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={customSymbol}
                    onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
                    placeholder="e.g. TATAMOTORS"
                    className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none font-mono focus:border-blue-500/50"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCustomSubmit();
                    }}
                  />
                  <button
                    onClick={handleCustomSubmit}
                    className="px-2 py-1 bg-blue-500/20 text-blue-400 text-[10px] font-mono rounded hover:bg-blue-500/30 transition-colors"
                  >
                    GO
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function MarketStatusBar() {
  const { symbol, expiry, setSymbol } = useTerminalStore();
  const [data, setData] = useState<MarketStatusData | null>(null);
  const [indexPrices, setIndexPrices] = useState<IndexData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [countdown, setCountdown] = useState("00:00:00");
  const [now, setNow] = useState("");
  const [fiiDii, setFiiDii] = useState<{ fiiNet: number; diiNet: number } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      // Fetch all index spot prices in parallel
      const indexPromises = INDEX_INSTRUMENTS.map(async (inst) => {
        try {
          const params = new URLSearchParams({ symbol: inst.symbol });
          if (inst.symbol === symbol && expiry) params.set('expiry', expiry);
          const res = await fetch(`/api/option-chain?${params.toString()}`);
          if (!res.ok) return null;
          const json = await res.json();
          if (!json.success) return null;
          const summary = json.data?.summary || {};
          const strikes = json.data?.data || [];
          let totalCallOI = 0;
          let totalPutOI = 0;
          for (const s of strikes) {
            totalCallOI += s.ce?.oi || 0;
            totalPutOI += s.pe?.oi || 0;
          }
          return {
            symbol: inst.symbol,
            spot: summary.spotPrice || json.data?.spotPrice || 0,
            change: summary.spotChange || 0,
            changePct: summary.spotChangePct || 0,
            pcr: totalCallOI > 0 ? totalPutOI / totalCallOI : summary.pcr || 1,
            vix: summary.indiaVIX || 0,
          };
        } catch {
          return null;
        }
      });

      const results = await Promise.all(indexPromises);
      const valid = results.filter((r): r is (IndexData & { pcr: number; vix: number }) => r !== null);
      setIndexPrices(valid);

      // Use selected symbol data for main status (PCR, VIX)
      const selected = valid.find(i => i.symbol === symbol) || valid[0];

      setData({
        isOpen: isMarketOpen(),
        vix: selected?.vix || 15,
        pcr: selected?.pcr || 1,
        indices: valid.length > 0 ? valid : [{ symbol, spot: 0, change: 0, changePct: 0 }],
        trend:
          (selected?.changePct || 0) > 0.3 ? "bullish" : (selected?.changePct || 0) < -0.3 ? "bearish" : "neutral",
        timeToClose: getTimeToClose(),
        lastUpdate: new Date().toISOString(),
      });

      // Fetch FII/DII in parallel (non-blocking)
      fetch("/api/fii-dii").then(r => r.json()).then(d => {
        if (d.success) setFiiDii({ fiiNet: d.fiiNet, diiNet: d.diiNet });
      }).catch(() => {});

      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbol, expiry]);

  useEffect(() => {
    setLoading(true);
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

  const displayIndices = indexPrices.length > 0 ? indexPrices : status.indices;

  return (
    <div className="flex items-center gap-3 h-10 px-3 bg-[#0a0e17] border-b border-white/5 text-[11px] font-mono overflow-x-auto scrollbar-none select-none">
      {/* Instrument Selector */}
      <InstrumentSelector />

      <div className="w-px h-4 bg-white/5 shrink-0" />

      {/* Expiry Selector */}
      <ExpirySelector />

      <div className="w-px h-4 bg-white/5 shrink-0" />

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

      <div className="w-px h-4 bg-white/5 shrink-0" />

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

      {/* FII/DII Flows */}
      {fiiDii && (
        <>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[9px] text-zinc-500 font-semibold">FII</span>
            <span className={`font-semibold tabular-nums ${fiiDii.fiiNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {fiiDii.fiiNet >= 0 ? "+" : ""}{(fiiDii.fiiNet / 100).toFixed(0)}K
            </span>
          </div>
          <div className="w-px h-4 bg-white/5 shrink-0" />
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[9px] text-zinc-500 font-semibold">DII</span>
            <span className={`font-semibold tabular-nums ${fiiDii.diiNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {fiiDii.diiNet >= 0 ? "+" : ""}{(fiiDii.diiNet / 100).toFixed(0)}K
            </span>
          </div>
          <div className="w-px h-4 bg-white/5 shrink-0" />
        </>
      )}

      {/* Index Ticker — all indices */}
      {displayIndices.map((idx) => (
        <button
          key={idx.symbol}
          onClick={() => setSymbol(idx.symbol)}
          className={`flex items-center gap-1 shrink-0 px-1 py-0.5 rounded transition-colors cursor-pointer ${
            idx.symbol === symbol
              ? "bg-white/5"
              : "hover:bg-white/[0.03]"
          }`}
        >
          <span className={`text-[10px] font-semibold ${idx.symbol === symbol ? "text-blue-400" : "text-zinc-400"}`}>
            {idx.symbol.slice(0, 4)}
          </span>
          <span className="text-zinc-200 font-semibold tabular-nums">{formatPrice(idx.spot)}</span>
          <ChangePill value={idx.change} pct={idx.changePct} />
        </button>
      ))}

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
