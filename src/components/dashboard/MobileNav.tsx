// Mobile Navigation — bottom tab bar for mobile devices
// Types aligned with page.tsx viewMode so every tab has a render branch.

"use client";

import { Activity, Brain, CalendarClock, Bot, Scan, Newspaper, Settings2, BarChart3, LineChart, TrendingUp, Flame, LayoutGrid, Crosshair, Shield, Target, FileText, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type MobileViewMode =
  | 'chain' | 'sdm' | 'strategy' | 'strategies' | 'greeks' | 'ivSurface'
  | 'correlation' | 'scanner' | 'news' | 'admin' | 'agent' | 'agent-intel'
  | 'backtest' | 'gap' | 'intelligence' | 'zerohero'
  | 'hedge' | 'expiry' | 'paper' | 'btst' | 'daily' | 'challenge' | 'jarvis';

interface MobileNavProps {
  viewMode: MobileViewMode;
  onViewChange: (mode: MobileViewMode) => void;
}

const TABS: { mode: MobileViewMode; label: string; icon: any; color: string }[] = [
  { mode: "jarvis", label: "Jarvis", icon: Bot, color: "text-sky-500" },
  { mode: "chain", label: "Chain", icon: Activity, color: "text-cyan-500" },
  { mode: "sdm", label: "SDM", icon: Brain, color: "text-violet-500" },
  { mode: "strategy", label: "Strategy", icon: TrendingUp, color: "text-indigo-500" },
  { mode: "greeks", label: "Greeks", icon: Flame, color: "text-orange-500" },
  { mode: "scanner", label: "Scan", icon: Scan, color: "text-teal-500" },
  { mode: "zerohero", label: "Zero", icon: Crosshair, color: "text-amber-500" },
  { mode: "intelligence", label: "Intel", icon: LayoutGrid, color: "text-emerald-500" },
  { mode: "news", label: "News", icon: Newspaper, color: "text-orange-500" },
  { mode: "backtest", label: "BT", icon: LineChart, color: "text-amber-500" },
  { mode: "gap", label: "Gap", icon: CalendarClock, color: "text-amber-500" },
  { mode: "agent", label: "Chat", icon: Bot, color: "text-purple-600" },
  { mode: "correlation", label: "Corr", icon: BarChart3, color: "text-teal-500" },
  { mode: "hedge", label: "Hedge", icon: Shield, color: "text-orange-500" },
  { mode: "terminal", label: "Terminal", icon: Zap, color: "text-emerald-500" },
  { mode: "futures", label: "Futures", icon: Zap, color: "text-emerald-500" },
  { mode: "expiry", label: "Plan", icon: Target, color: "text-amber-600" },
  { mode: "paper", label: "Paper", icon: FileText, color: "text-yellow-500" },
  { mode: "btst", label: "BTST", icon: Flame, color: "text-cyan-500" },
  { mode: "daily", label: "Daily", icon: CalendarClock, color: "text-violet-500" },
  { mode: "admin", label: "Admin", icon: Settings2, color: "text-gray-500" },
];

export function MobileNav({ viewMode, onViewChange }: MobileNavProps) {
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
              variant="ghost"
              size="sm"
              aria-current={active ? 'page' : undefined}
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
