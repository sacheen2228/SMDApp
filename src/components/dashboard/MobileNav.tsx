// Mobile Navigation — bottom tab bar for mobile devices

"use client";

import { BarChart3, RefreshCw, Settings2, Sun, Moon, Activity, Zap, Brain, Timer, CalendarClock, Bot, Scan, Newspaper, Target, TrendingUp, Flame, LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ViewMode = 'chain' | 'sdm' | 'gap' | 'agent' | 'scanner' | 'news' | 'strategy' | 'strategies' | 'greeks' | 'admin' | 'correlation' | 'ivSurface' | 'backtest' | 'terminal' | 'btst';

interface MobileNavProps {
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
}

const TABS: { mode: ViewMode; label: string; icon: any; color: string }[] = [
  { mode: "chain", label: "Chain", icon: Activity, color: "text-cyan-500" },
  { mode: "sdm", label: "SDM", icon: Brain, color: "text-violet-500" },
  { mode: "strategy", label: "Strategy", icon: TrendingUp, color: "text-indigo-500" },
  { mode: "greeks", label: "Greeks", icon: Flame, color: "text-orange-500" },
  { mode: "scanner", label: "Scan", icon: Scan, color: "text-teal-500" },
  { mode: "news", label: "News", icon: Newspaper, color: "text-orange-500" },
  { mode: "admin", label: "Admin", icon: Settings2, color: "text-gray-500" },
  { mode: "correlation", label: "Corr", icon: BarChart3, color: "text-teal-500" },
  { mode: "backtest", label: "BT", icon: LineChart, color: "text-amber-500" },
  { mode: "gap", label: "Gap", icon: CalendarClock, color: "text-amber-500" },
  { mode: "agent", label: "Chat", icon: Bot, color: "text-purple-600" },
];

export function MobileNav({ viewMode, onViewChange }: MobileNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t border-border lg:hidden">
      <div className="flex items-center justify-around px-1 py-1 overflow-x-auto">
        {TABS.map((tab) => (
          <Button
            key={tab.mode}
            variant="ghost"
            size="sm"
            className={`flex flex-col items-center gap-0 h-auto py-1 px-1.5 min-w-[44px] ${
              viewMode === tab.mode
                ? `${tab.color} font-bold`
                : "text-muted-foreground"
            }`}
            onClick={() => onViewChange(tab.mode)}
          >
            <tab.icon className="h-4 w-4" />
            <span className="text-[8px]">{tab.label}</span>
          </Button>
        ))}
      </div>
    </nav>
  );
}
