// ScannerView — Scanner tab wrapper
// Sub-tabs: Intraday (existing intraday scanner) and Weekly (weekly equity
// scanner). Lets the user switch between the two without leaving the tab.

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScannerPanel } from "@/components/dashboard/ScannerPanel";
import { WeeklyEquityScannerPanel } from "@/components/dashboard/WeeklyEquityScannerPanel";
import EquityUniversePanel from "@/components/dashboard/EquityUniversePanel";
import { Zap, Clock, Filter } from "lucide-react";

interface ScannerViewProps {
  symbol: string;
  spotPrice: number;
}

export default function ScannerView({ symbol, spotPrice }: ScannerViewProps) {
  const [mode, setMode] = useState<"intraday" | "weekly" | "universe">("intraday");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sub-toggle */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-3 py-1.5 flex items-center gap-1">
        <Button
          variant={mode === 'intraday' ? 'default' : 'ghost'}
          size="sm"
          className={`h-6 text-[10px] px-2 font-bold ${mode === 'intraday' ? 'bg-teal-600 text-white shadow-sm shadow-teal-500/25' : 'text-muted-foreground hover:text-teal-500'}`}
          onClick={() => setMode('intraday')}
        >
          <Zap className="h-3 w-3 mr-1" /> Intraday
        </Button>
        <Button
          variant={mode === 'weekly' ? 'default' : 'ghost'}
          size="sm"
          className={`h-6 text-[10px] px-2 font-bold ${mode === 'weekly' ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/25' : 'text-muted-foreground hover:text-violet-500'}`}
          onClick={() => setMode('weekly')}
        >
          <Clock className="h-3 w-3 mr-1" /> Weekly Swing
        </Button>
        <Button
          variant={mode === 'universe' ? 'default' : 'ghost'}
          size="sm"
          className={`h-6 text-[10px] px-2 font-bold ${mode === 'universe' ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/25' : 'text-muted-foreground hover:text-emerald-500'}`}
          onClick={() => setMode('universe')}
        >
          <Filter className="h-3 w-3 mr-1" /> Equity Universe
        </Button>
      </div>

      {/* Panel */}
      <div className="flex-1 overflow-hidden">
        {mode === 'intraday' ? (
          <ScannerPanel symbol={symbol} spotPrice={spotPrice} />
        ) : mode === 'weekly' ? (
          <WeeklyEquityScannerPanel />
        ) : (
          <EquityUniversePanel />
        )}
      </div>
    </div>
  );
}