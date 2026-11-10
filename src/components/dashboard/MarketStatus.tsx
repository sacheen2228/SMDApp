// Market Status Component
// Shows market status, spot price, VIX, and connection status

'use client';

import React, { useEffect, useState } from 'react';
import { useTradingStore } from '@/stores/useTradingStore';
import { Badge } from '@/components/ui/badge';
import { Wifi, WifiOff, Clock, TrendingUp, TrendingDown } from 'lucide-react';
import { getTradingSession } from '@/lib/expiry-liquidity/market-session-config';

export function MarketStatus() {
  const { spotPrice, selectedSymbol, isConnected } = useTradingStore();
  const [session, setSession] = useState<ReturnType<typeof getTradingSession>>('CLOSED');
  const [currentTime, setCurrentTime] = useState('');

  useEffect(() => {
    const checkMarketStatus = () => {
      const now = new Date();
      // getTradingSession() reads the holiday calendar + IST clock — the same
      // source every other session consumer uses, so this badge can never
      // disagree with the rest of the app about whether the exchange is open.
      setSession(getTradingSession(now));
      setCurrentTime(now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };

    checkMarketStatus();
    const interval = setInterval(checkMarketStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const marketOpen = session === 'OPEN' || session === 'REGULAR';
  const sessionLabel =
    session === 'PRE_OPEN' ? 'PRE-OPEN'
      : session === 'POST_MARKET' ? 'POST-MARKET'
        : marketOpen ? 'MARKET OPEN'
          : 'MARKET CLOSED';
  
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Connection Status */}
      <div className="flex items-center gap-1">
        {isConnected ? (
          <Wifi className="h-3 w-3 text-emerald-500" />
        ) : (
          <WifiOff className="h-3 w-3 text-amber-500" />
        )}
        <span className={`text-[10px] font-medium ${isConnected ? 'text-emerald-500' : 'text-amber-500'}`}>
          {isConnected ? 'ICICI Connected' : 'Simulation'}
        </span>
      </div>
      
      <div className="w-px h-4 bg-border" />
      
      {/* Market Status */}
      <div className="flex items-center gap-1">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-medium tabular-nums">{currentTime}</span>
      </div>
      
      <Badge className={`text-[9px] ${marketOpen ? 'bg-emerald-600' : session === 'CLOSED' ? 'bg-red-600' : 'bg-amber-600'}`}>
        {sessionLabel}
      </Badge>
      
      <div className="w-px h-4 bg-border" />
      
      {/* Spot Price */}
      {spotPrice > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">{selectedSymbol}</span>
          <span className="text-xs font-bold tabular-nums">₹{spotPrice.toLocaleString('en-IN')}</span>
        </div>
      )}
    </div>
  );
}
