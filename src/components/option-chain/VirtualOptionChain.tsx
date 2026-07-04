// Virtualized Option Chain Table — react-window v2

"use client";

import { useRef, useMemo, useEffect, useState } from "react";
import { List } from "react-window";
import { Button } from "@/components/ui/button";
import { Activity } from "lucide-react";

type OptionSide = {
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  ltp: number;
  chg: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
};

type OptionData = {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
};

interface VirtualOptionChainProps {
  data: OptionData[];
  maxOI: number;
  maxCallOI: number;
  maxPutOI: number;
  atmStrike: number;
  spot: number;
  showGreeks: boolean;
  onTrade: (strike: number, type: "call" | "put", side: "buy" | "sell") => void;
  scrollToATM?: boolean;
}

function formatIndian(num: number): string {
  if (num >= 10000000) return (num / 10000000).toFixed(2) + " Cr";
  if (num >= 100000) return (num / 100000).toFixed(2) + " L";
  if (num >= 1000) return num.toLocaleString("en-IN");
  return num.toString();
}

function fmt(num: number, d: number = 2): string {
  return num.toFixed(d);
}

function oiHeat(oi: number, maxOI: number, isCall: boolean): React.CSSProperties {
  const pct = Math.min(oi / maxOI, 1);
  if (isCall) {
    return { background: `linear-gradient(to left, rgba(239,68,68,${pct * 0.35}), transparent)` };
  }
  return { background: `linear-gradient(to right, rgba(34,197,94,${pct * 0.35}), transparent)` };
}

const ROW_HEIGHT = 32;

// Row component — react-window v2 spreads rowProps as individual props
function ChainRow(props: any) {
  const { style, index, chainData, maxOI, maxCallOI, maxPutOI, atmStrike, spot, showGreeks, onTrade } = props;
  const row = chainData?.[index];
  if (!row) return null;

  const isATM = row.strike === atmStrike;
  const isITMCall = row.strike < spot;
  const isITMPut = row.strike > spot;

  return (
    <div
      style={style}
      className={`flex items-center border-b border-border/30 transition-colors hover:bg-accent/20 text-[11px] ${
        isATM ? "bg-primary/8 ring-1 ring-inset ring-primary/20" : ""
      }`}
    >
      {/* CALL Side */}
      <div className="w-[72px] px-1 text-right font-mono tabular-nums cursor-pointer shrink-0"
        style={row.ce ? oiHeat(row.ce.oi, maxOI, true) : undefined}
        onClick={() => row.ce && onTrade(row.strike, "call", "buy")}>
        <span className={row.ce && row.ce.oi > maxCallOI * 0.7 ? "font-bold text-red-600 dark:text-red-400" : ""}>
          {row.ce ? formatIndian(row.ce.oi) : "—"}
        </span>
      </div>
      <div className={`w-[52px] px-1 text-right font-mono tabular-nums text-xs shrink-0 ${row.ce?.oiChg > 0 ? "text-red-500" : row.ce?.oiChg < 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
        {row.ce ? (row.ce.oiChg > 0 ? "+" : "") + formatIndian(row.ce.oiChg) : "—"}
      </div>
      <div className="w-[52px] px-1 text-right font-mono tabular-nums text-muted-foreground shrink-0">
        {row.ce ? formatIndian(row.ce.volume) : "—"}
      </div>
      <div className={`w-[52px] px-1 text-right font-mono tabular-nums font-semibold shrink-0 ${isITMCall ? "bg-red-500/8" : ""}`}>
        {row.ce ? fmt(row.ce.ltp) : "—"}
      </div>
      {showGreeks && (
        <>
          <div className="w-[48px] px-1 text-right font-mono text-muted-foreground/60 shrink-0">{row.ce ? fmt(row.ce.delta) : "—"}</div>
          <div className="w-[48px] px-1 text-right font-mono text-muted-foreground/60 shrink-0">{row.ce ? fmt(row.ce.theta) : "—"}</div>
          <div className="w-[48px] px-1 text-right font-mono text-muted-foreground/60 shrink-0">{row.ce ? fmt(row.ce.gamma, 4) : "—"}</div>
        </>
      )}

      {/* STRIKE */}
      <div className={`w-[72px] px-2 text-center font-bold font-mono tabular-nums bg-muted/50 shrink-0 ${isATM ? "bg-primary/15 text-primary text-[12px]" : ""}`}>
        {row.strike}
        {isATM && <span className="ml-1 text-[8px] font-medium text-primary/70">ATM</span>}
      </div>

      {/* PUT Side */}
      {showGreeks && (
        <>
          <div className="w-[48px] px-1 text-left font-mono text-muted-foreground/60 shrink-0">{row.pe ? fmt(row.pe.gamma, 4) : "—"}</div>
          <div className="w-[48px] px-1 text-left font-mono text-muted-foreground/60 shrink-0">{row.pe ? fmt(row.pe.theta) : "—"}</div>
          <div className="w-[48px] px-1 text-left font-mono text-muted-foreground/60 shrink-0">{row.pe ? fmt(row.pe.delta) : "—"}</div>
        </>
      )}
      <div className={`w-[52px] px-1 text-left font-mono tabular-nums font-semibold shrink-0 ${isITMPut ? "bg-emerald-500/8" : ""}`}
        onClick={() => row.pe && onTrade(row.strike, "put", "buy")}>
        {row.pe ? fmt(row.pe.ltp) : "—"}
      </div>
      <div className="w-[52px] px-1 text-left font-mono tabular-nums text-muted-foreground shrink-0">
        {row.pe ? formatIndian(row.pe.volume) : "—"}
      </div>
      <div className={`w-[52px] px-1 text-left font-mono tabular-nums text-xs shrink-0 ${row.pe?.oiChg > 0 ? "text-red-500" : row.pe?.oiChg < 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
        {row.pe ? (row.pe.oiChg > 0 ? "+" : "") + formatIndian(row.pe.oiChg) : "—"}
      </div>
      <div className="w-[72px] px-1 text-left font-mono tabular-nums cursor-pointer shrink-0"
        style={row.pe ? oiHeat(row.pe.oi, maxOI, false) : undefined}
        onClick={() => row.pe && onTrade(row.strike, "put", "buy")}>
        <span className={row.pe && row.pe.oi > maxPutOI * 0.7 ? "font-bold text-emerald-600 dark:text-emerald-400" : ""}>
          {row.pe ? formatIndian(row.pe.oi) : "—"}
        </span>
      </div>

      {/* Buy/Sell Buttons */}
      <div className="w-[52px] px-1 shrink-0">
        <div className="flex gap-0.5">
          {row.ce && (
            <Button size="sm" className="h-5 w-8 text-[8px] px-0 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onTrade(row.strike, "call", "buy")}>
              B
            </Button>
          )}
          {row.pe && (
            <Button size="sm" className="h-5 w-8 text-[8px] px-0 bg-red-600 hover:bg-red-700"
              onClick={() => onTrade(row.strike, "put", "sell")}>
              S
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function VirtualOptionChain({
  data,
  maxOI,
  maxCallOI,
  maxPutOI,
  atmStrike,
  spot,
  showGreeks,
  onTrade,
  scrollToATM,
}: VirtualOptionChainProps) {
  const [containerHeight, setContainerHeight] = useState(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<any>(null);

  const atmIndex = useMemo(() => {
    return data.findIndex((row) => row.strike === atmStrike);
  }, [data, atmStrike]);

  useEffect(() => {
    if (containerRef.current) {
      const obs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerHeight(entry.contentRect.height);
        }
      });
      obs.observe(containerRef.current);
      return () => obs.disconnect();
    }
  }, []);

  // Pass data as rowProps — react-window v2 spreads these onto each row
  const sharedProps = useMemo(
    () => ({ chainData: data, maxOI, maxCallOI, maxPutOI, atmStrike, spot, showGreeks, onTrade }),
    [data, maxOI, maxCallOI, maxPutOI, atmStrike, spot, showGreeks, onTrade]
  );

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Column Headers */}
      <div className="shrink-0">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 z-40">
            <tr>
              <th colSpan={showGreeks ? 7 : 5} className="py-1.5 text-center bg-red-500/10 dark:bg-red-500/20 border-b-2 border-red-500/30">
                <span className="text-red-600 dark:text-red-400 font-bold text-xs tracking-widest">CALLS</span>
              </th>
              <th className="py-1.5 text-center bg-muted border-b-2 border-border">
                <span className="font-bold text-xs"><Activity className="h-3 w-3 inline" /> STRIKE</span>
              </th>
              <th colSpan={showGreeks ? 7 : 5} className="py-1.5 text-center bg-emerald-500/10 dark:bg-emerald-500/20 border-b-2 border-emerald-500/30">
                <span className="text-emerald-600 dark:text-emerald-400 font-bold text-xs tracking-widest">PUTS</span>
              </th>
              <th className="py-1.5 border-b-2 border-border" />
            </tr>
            <tr className="text-[9px] font-semibold text-muted-foreground bg-muted/70">
              <th className="px-1 py-1 text-right w-[72px]">OI</th>
              <th className="px-1 py-1 text-right w-[52px]">Chg</th>
              <th className="px-1 py-1 text-right w-[52px]">Vol</th>
              <th className="px-1 py-1 text-right w-[52px]">LTP</th>
              {showGreeks && <>
                <th className="px-1 py-1 text-right w-[48px]">Delta</th>
                <th className="px-1 py-1 text-right w-[48px]">Theta</th>
                <th className="px-1 py-1 text-right w-[48px]">Gamma</th>
              </>}
              <th className="px-1 py-1 text-center font-bold w-[72px]">₹</th>
              {showGreeks && <>
                <th className="px-1 py-1 text-left w-[48px]">Gamma</th>
                <th className="px-1 py-1 text-left w-[48px]">Theta</th>
                <th className="px-1 py-1 text-left w-[48px]">Delta</th>
              </>}
              <th className="px-1 py-1 text-left w-[52px]">LTP</th>
              <th className="px-1 py-1 text-left w-[52px]">Vol</th>
              <th className="px-1 py-1 text-left w-[52px]">Chg</th>
              <th className="px-1 py-1 text-left w-[72px]">OI</th>
              <th className="px-1 py-1 w-[52px]" />
            </tr>
          </thead>
        </table>
      </div>

      {/* Virtualized Rows */}
      <div className="flex-1 min-h-0">
        <List
          ref={listRef}
          rowComponent={ChainRow}
          rowCount={data.length}
          rowHeight={ROW_HEIGHT}
          rowProps={sharedProps}
          overscanCount={10}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
