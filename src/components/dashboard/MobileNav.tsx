// Mobile Navigation — bottom tab bar for mobile devices.
// ONE source of truth: every entry here MUST have a render branch in
// page.tsx (verified Oct 2026 — previously 9 fake tabs fell through
// silently to the chain view and 5 real views were unreachable).

"use client";

import { useEffect, useRef } from "react";
import {
  Activity, Bot, CalendarClock, Scan, Newspaper, Settings2, BarChart3,
  LineChart, TrendingUp, Flame, LayoutGrid, Crosshair, Shield, Target,
  FileText, Zap, Gem, Map, Landmark, Handshake,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type MobileViewMode =
  | "terminal" | "chain" | "zerohero" | "scanner" | "btst" | "daily"
  | "backtest" | "expiry" | "gap" | "news" | "institutional" | "futures"
  | "commodity" | "india" | "intelligence" | "credit" | "challenge"
  | "agent" | "agent-intel" | "paper" | "admin";

interface MobileNavProps {
  viewMode: MobileViewMode;
  onViewChange: (mode: MobileViewMode) => void;
}

const TABS: { mode: MobileViewMode; label: string; icon: any; color: string }[] = [
  // Primary trading views first
  { mode: "terminal", label: "Terminal", icon: Zap, color: "text-emerald-500" },
  { mode: "chain", label: "Chain", icon: Activity, color: "text-cyan-500" },
  { mode: "zerohero", label: "Zero", icon: Crosshair, color: "text-amber-500" },
  { mode: "scanner", label: "Scan", icon: Scan, color: "text-teal-500" },
  { mode: "btst", label: "BTST", icon: Flame, color: "text-cyan-500" },
  { mode: "daily", label: "Daily", icon: CalendarClock, color: "text-violet-500" },
  { mode: "backtest", label: "Audit", icon: LineChart, color: "text-amber-500" },
  { mode: "expiry", label: "Plan", icon: Target, color: "text-amber-600" },
  { mode: "gap", label: "Gap", icon: CalendarClock, color: "text-amber-500" },
  { mode: "news", label: "News", icon: Newspaper, color: "text-orange-500" },
  // Market intel
  { mode: "institutional", label: "FII", icon: Landmark, color: "text-sky-500" },
  { mode: "futures", label: "Futures", icon: TrendingUp, color: "text-emerald-500" },
  { mode: "commodity", label: "MCX", icon: Gem, color: "text-yellow-500" },
  { mode: "india", label: "India", icon: Map, color: "text-orange-500" },
  { mode: "intelligence", label: "Intel", icon: LayoutGrid, color: "text-emerald-500" },
  { mode: "credit", label: "Credit", icon: Handshake, color: "text-rose-500" },
  { mode: "challenge", label: "Chal", icon: Shield, color: "text-red-500" },
  // Agent + misc
  { mode: "agent", label: "Chat", icon: Bot, color: "text-purple-600" },
  { mode: "agent-intel", label: "AIM", icon: BarChart3, color: "text-purple-500" },
  { mode: "paper", label: "Paper", icon: FileText, color: "text-yellow-500" },
  { mode: "admin", label: "Admin", icon: Settings2, color: "text-gray-500" },
];

export function MobileNav({ viewMode, onViewChange }: MobileNavProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Keep the active tab visible in the scrollable strip
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [viewMode]);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t border-border lg:hidden pb-[env(safe-area-inset-bottom)]"
      aria-label="Mobile navigation"
    >
      <div className="flex items-stretch gap-0.5 px-1 py-1 overflow-x-auto overscroll-x-contain scrollbar-none -webkit-overflow-scrolling:touch">
        {TABS.map((tab) => {
          const active = viewMode === tab.mode;
          return (
            <Button
              key={tab.mode}
              ref={active ? activeRef : undefined}
              variant="ghost"
              size="sm"
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-0 h-auto py-1.5 px-2 min-w-[52px] min-h-[48px] shrink-0 rounded-md ${
                active ? `${tab.color} font-bold bg-muted/60` : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onViewChange(tab.mode)}
            >
              <tab.icon className="h-4 w-4" />
              <span className="text-[8px] leading-none whitespace-nowrap">{tab.label}</span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
