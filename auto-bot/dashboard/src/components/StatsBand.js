import React from 'react';

function StatsBand({ stats }) {
  const fmt = (val) => {
    const prefix = val >= 0 ? '+' : '';
    return `${prefix}${(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <div className="card">
        <div className="label mb-2">Today's P/L</div>
        <div className={`stat-value ${stats.today_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {fmt(stats.today_pnl)}
        </div>
      </div>

      <div className="card">
        <div className="label mb-2">Win Rate</div>
        <div className="stat-value text-white">{(stats.win_rate || 0).toFixed(0)}%</div>
      </div>

      <div className="card">
        <div className="label mb-2">Trades Today</div>
        <div className="stat-value text-white">{stats.trades_today || 0}</div>
      </div>

      <div className="card">
        <div className="label mb-2">Open Positions</div>
        <div className="stat-value text-blue-400">{stats.open_count || 0}</div>
      </div>

      <div className="card">
        <div className="label mb-2">All-Time P/L</div>
        <div className={`stat-value ${stats.alltime_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {fmt(stats.alltime_pnl)}
        </div>
      </div>
    </div>
  );
}

export default StatsBand;
