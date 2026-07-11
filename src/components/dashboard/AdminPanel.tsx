"use client";

import { useState } from "react";
import SystemHealth from "./admin/SystemHealth";
import TradeJournal from "./admin/TradeJournal";
import ConnectionManager from "./admin/ConnectionManager";
import ConfigProfiles from "./admin/ConfigProfiles";
import StrategyConfig from "./admin/StrategyConfig";

interface AdminPanelProps {
  onConfigChange?: (config: any) => void;
}

export function AdminPanel({ onConfigChange }: AdminPanelProps) {
  const [section, setSection] = useState("dashboard");

  const sections = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "trades", label: "Trades", icon: "📋" },
    { id: "connections", label: "Connections", icon: "🔌" },
    { id: "profiles", label: "Profiles", icon: "💾" },
    { id: "strategy", label: "Strategy", icon: "⚙️" },
  ];

  return (
    <div className="space-y-4 text-xs">
      {/* Section Navigation */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {sections.map(sec => (
          <button
            key={sec.id}
            onClick={() => setSection(sec.id)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all ${
              section === sec.id
                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                : "bg-[#131722] text-muted-foreground border border-[#2a2e39] hover:border-cyan-500/30"
            }`}
          >
            <span>{sec.icon}</span>
            <span>{sec.label}</span>
          </button>
        ))}
      </div>

      {/* Section Content */}
      <div className="min-h-[400px]">
        {section === "dashboard" && <SystemHealth />}
        {section === "trades" && <TradeJournal />}
        {section === "connections" && <ConnectionManager />}
        {section === "profiles" && <ConfigProfiles />}
        {section === "strategy" && <StrategyConfig />}
      </div>
    </div>
  );
}
