// Market Status Component
// Shows market status, spot price, VIX, and connection status

'use client';

import React, { useEffect, useState } from 'react';
import { useTradingStore } from '@/stores/useTradingStore';
import { Badge } from '@/components/ui/badge';
import { Wifi, WifiOff, Clock, TrendingUp, TrendingDown } from 'lucide-react';

export function MarketStatus() {
  const { spotPrice, selectedSymbol, isConnected } = useTradingStore();
  const [marketOpen, setMarketOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState('');
  
  useEffect(() => {
    const checkMarketStatus = () => {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const day = now.getDay();
      
      // Market hours: Mon-Fri, 9:15 AM - 3:30 PM IST
      const isWeekday = day >= 1 && day <= 5;
      const timeMinutes = hours * 60 + minutes;
      const marketOpenTime = 9 * 60 + 15; // 9:15 AM
      const marketCloseTime = 15 * 60 + 30; // 3:30 PM
      
      setMarketOpen(isWeekday && timeMinutes >= marketOpenTime && timeMinutes <= marketCloseTime);
      setCurrentTime(now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };
    
    checkMarketStatus();
    const interval = setInterval(checkMarketStatus, 1000);
    return () => clearInterval(interval);
  }, []);
  
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
      
      <Badge className={`text-[9px] ${marketOpen ? 'bg-emerald-600' : 'bg-red-600'}`}>
        {marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
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
