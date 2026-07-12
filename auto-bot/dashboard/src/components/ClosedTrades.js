import React from 'react';

function ClosedTrades({ trades }) {
  return (
    <div className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white mb-4">
        Closed Trades
      </h2>

      <div className="space-y-3 max-h-[260px] overflow-y-auto">
        {trades.length === 0 && (
          <div className="text-center py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            No closed trades yet
          </div>
        )}

        {trades.map((trade) => {
          const pnlPositive = trade.live_pnl >= 0;
          return (
            <div
              key={trade.id}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{ backgroundColor: 'var(--bg-hover)' }}
            >
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  pnlPositive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                  {trade.status === 'closed_win' ? 'TARGET' : 'STOP'}
                </span>
                <div>
                  <div className="font-semibold text-white text-sm">{trade.ticker}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {trade.market} · {trade.qty} SH
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className={`font-mono font-medium ${pnlPositive ? 'text-green-400' : 'text-red-400'}`}>
                  {pnlPositive ? '+' : ''}{trade.live_pnl?.toFixed(2)}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  in {trade.entry} → out {trade.last}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ClosedTrades;
