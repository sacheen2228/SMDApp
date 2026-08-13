'use client';

import { Search } from 'lucide-react';

interface Props {
  selectedMarket: string;
  marketList: string[];
  onMarketChange: (m: string) => void;
  accountValue?: string;
  pnl?: string;
  pnlPercent?: string;
}

export function TerminalHeader({ selectedMarket, marketList, onMarketChange, accountValue = '$10,000.00', pnl = '+$0.00', pnlPercent = '0.00%' }: Props) {
  const base = selectedMarket?.replace(/_USDT.*$/, '').replace(/USDT$/, '') || 'BTC';

  return (
    <div className="flex items-center justify-between px-4 py-2 text-xs"
      style={{ background: '#0d1321', borderBottom: '1px solid #1e222d', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <div className="flex items-center gap-4">
        <span className="font-bold text-sm" style={{ color: '#d1d4dc' }}>NEXUS AI TERMINAL</span>
        <div className="flex items-center gap-1 relative">
          <Search className="h-3 w-3" style={{ color: '#787b86' }} />
          <select
            value={selectedMarket}
            onChange={e => onMarketChange(e.target.value)}
            className="bg-transparent text-xs font-mono cursor-pointer"
            style={{ color: '#d1d4dc', border: 'none', outline: 'none', appearance: 'none', paddingLeft: 4 }}
          >
            {marketList.map(m => (
              <option key={m} value={m} className="bg-[#0d1321]">{m}</option>
            ))}
          </select>
        </div>
        <span style={{ color: '#787b86' }}>{base} PERPETUAL</span>
      </div>
      <div className="flex items-center gap-4">
        <span style={{ color: '#d1d4dc' }}>Account: {accountValue}</span>
        <span style={{ color: '#26a69a' }}>{pnl} ({pnlPercent})</span>
        <span className="flex items-center gap-1" style={{ color: '#26a69a' }}>
          <span className="h-1.5 w-1.5 rounded-full bg-[#26a69a] animate-pulse" />
          WS CONNECTED
        </span>
      </div>
    </div>
  );
}
