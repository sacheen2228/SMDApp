// Positions Tracker Component
// Shows open positions with live PnL

'use client';

import React, { useEffect, useState } from 'react';
import { useTradingStore } from '@/stores/useTradingStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';

export function PositionTracker() {
  const { positions, holdings, funds, setPositions, setHoldings, setFunds } = useTradingStore();
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'positions' | 'holdings' | 'funds'>('positions');
  
  const fetchPositions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      if (data.success) {
        setPositions(data.data.positions || []);
        setHoldings(data.data.holdings || []);
        setFunds(data.data.funds || null);
      }
    } catch (error) {
      console.error('Failed to fetch positions:', error);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, []);
  
  const totalPnL = positions.reduce((sum, pos) => sum + parseFloat(pos.pnl || '0'), 0);
  
  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(val);
  };
  
  return (
    <div className="border rounded-lg bg-card">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold">Portfolio</h3>
          {totalPnL !== 0 && (
            <Badge className={`text-[10px] ${totalPnL >= 0 ? 'bg-emerald-600' : 'bg-red-600'}`}>
              {totalPnL >= 0 ? '+' : ''}{formatCurrency(totalPnL)}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={fetchPositions} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      
      {/* Tabs */}
      <div className="flex border-b">
        {(['positions', 'holdings', 'funds'] as const).map(t => (
          <button
            key={t}
            className={`flex-1 py-2 text-xs font-medium capitalize ${
              tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      
      {/* Content */}
      <div className="max-h-[300px] overflow-auto">
        {/* Positions */}
        {tab === 'positions' && (
          positions.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">No open positions</div>
          ) : (
            positions.map((pos, i) => {
              const pnl = parseFloat(pos.pnl || '0');
              const isProfit = pnl >= 0;
              return (
                <div key={i} className="flex items-center justify-between p-3 border-b last:border-0">
                  <div>
                    <p className="text-xs font-bold">{pos.stockCode}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {pos.quantity} @ ₹{pos.averagePrice}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold">₹{pos.ltp}</p>
                    <p className={`text-[10px] font-medium ${isProfit ? 'text-emerald-500' : 'text-red-500'}`}>
                      {isProfit ? <TrendingUp className="inline h-2.5 w-2.5" /> : <TrendingDown className="inline h-2.5 w-2.5" />}
                      {' '}{isProfit ? '+' : ''}{formatCurrency(pnl)}
                    </p>
                  </div>
                </div>
              );
            })
          )
        )}
        
        {/* Holdings */}
        {tab === 'holdings' && (
          holdings.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">No holdings</div>
          ) : (
            holdings.map((hold, i) => {
              const pnl = parseFloat(hold.pnl || '0');
              const isProfit = pnl >= 0;
              return (
                <div key={i} className="flex items-center justify-between p-3 border-b last:border-0">
                  <div>
                    <p className="text-xs font-bold">{hold.stockCode}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {hold.quantity} @ ₹{hold.averagePrice}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold">₹{hold.ltp}</p>
                    <p className={`text-[10px] font-medium ${isProfit ? 'text-emerald-500' : 'text-red-500'}`}>
                      {isProfit ? '+' : ''}{formatCurrency(pnl)}
                    </p>
                  </div>
                </div>
              );
            })
          )
        )}
        
        {/* Funds */}
        {tab === 'funds' && funds && (
          <div className="p-3 space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Available Balance</span>
              <span className="text-xs font-bold">{formatCurrency(funds.unallocatedBalance)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">F&O Allocated</span>
              <span className="text-xs">{formatCurrency(funds.allocatedFno)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">F&O Blocked</span>
              <span className="text-xs">{formatCurrency(funds.blockByTradeFno)}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-xs font-bold">Total Balance</span>
              <span className="text-xs font-bold">{formatCurrency(funds.totalBankBalance)}</span>
            </div>
          </div>
        )}
        
        {tab === 'funds' && !funds && (
          <div className="p-4 text-center text-xs text-muted-foreground">Unable to fetch funds</div>
        )}
      </div>
    </div>
  );
}
