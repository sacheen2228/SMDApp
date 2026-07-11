"use client";

import { useState } from "react";
import {
  PanelLeftClose,
  PanelRightClose,
  Maximize2,
  Minimize2,
  Monitor,
} from "lucide-react";
import { MarketStatusBar } from "./MarketStatusBar";
import { LiveOptionChain } from "./LiveOptionChain";
import { OIHeatmapECharts } from "./OIHeatmapECharts";
import { SmartMoneyPanel } from "./SmartMoneyPanel";
import { GreekHeatmapECharts } from "./GreekHeatmapECharts";
import { AIRecommendation } from "./AIRecommendation";
import { ZeroHeroScanner } from "./ZeroHeroScanner";
import { TradeHistory } from "./TradeHistory";
import { FIIDIIFlowPanel } from "./FIIDIIFlowPanel";

function PanelCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-[#0d1117] border border-white/5 rounded-md overflow-hidden flex flex-col ${className}`}
    >
      {children}
    </div>
  );
}

export function TerminalPro() {
  return (
    <div className="flex flex-col h-screen w-full bg-[#0a0e17] overflow-hidden">
      {/* Top: Market Status Bar */}
      <div className="shrink-0">
        <MarketStatusBar />
      </div>

      {/* Main Grid */}
      <div className="flex-1 grid grid-cols-[40fr_35fr_25fr] gap-px bg-white/[0.03] min-h-0">
        {/* ── Left Column: LiveOptionChain (60%) + OIHeatmapECharts (40%) ── */}
        <div className="flex flex-col min-h-0 gap-px bg-[#0a0e17]">
          <div className="flex-[3] min-h-0 overflow-hidden">
            <LiveOptionChain />
          </div>
          <div className="flex-[2] min-h-0 overflow-hidden">
            <OIHeatmapECharts />
          </div>
        </div>

        {/* ── Center Column: SmartMoney + FII/DII + GreekHeatmap + AI ── */}
        <div className="flex flex-col min-h-0 gap-px bg-[#0a0e17]">
          <div className="flex-[1] min-h-0 overflow-hidden">
            <SmartMoneyPanel />
          </div>
          <div className="flex-[1] min-h-0 overflow-hidden">
            <FIIDIIFlowPanel />
          </div>
          <div className="flex-[1] min-h-0 overflow-hidden">
            <GreekHeatmapECharts />
          </div>
          <div className="flex-[1] min-h-0 overflow-hidden">
            <AIRecommendation />
          </div>
        </div>

        {/* ── Right Column: ZeroHeroScanner (55%) + TradeHistory (45%) ── */}
        <div className="flex flex-col min-h-0 gap-px bg-[#0a0e17]">
          <div className="flex-[11] min-h-0 overflow-hidden">
            <ZeroHeroScanner />
          </div>
          <div className="flex-[9] min-h-0 overflow-hidden">
            <TradeHistory />
          </div>
        </div>
      </div>
    </div>
  );
}
