'use client';

import { FuturesDashboard } from '@/components/futures/FuturesDashboard';
import { IndiaMarketChart } from '@/components/futures/IndiaMarketChart';

export default function FuturesPage() {
  return (
    <div className="min-h-screen" style={{ background: '#0a0e17' }}>
      <FuturesDashboard />
      <div className="px-1 pb-1">
        <div className="flex items-center gap-1 px-2 py-1" style={{ background: '#0d1321', border: '1px solid #1e222d', borderBottom: 'none', borderRadius: '4px 4px 0 0' }}>
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#787b86' }}>🇮🇳 India Indices</span>
        </div>
        <div style={{ height: 420 }}>
          <IndiaMarketChart symbol="NIFTY" />
        </div>
      </div>
    </div>
  );
}
