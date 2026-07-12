import React from 'react';

function PositionPanel({ positions }) {
  const getProgress = (stop, target, last) => {
    const range = target - stop;
    if (range <= 0) return 0;
    const progress = last - stop;
    return Math.max(0, Math.min(100, (progress / range) * 100));
  };

  const getProgressColor = (entry, stop, target, last) => {
    if (last >= target) return 'bg-green-500';
    if (last <= stop) return 'bg-red-500';
    if (last > entry) return 'bg-green-400';
    return 'bg-yellow-500';
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
          Open Positions
        </h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
              <th className="pb-3 font-medium uppercase text-xs">Ticker</th>
              <th className="pb-3 font-medium uppercase text-xs">Qty</th>
              <th className="pb-3 font-medium uppercase text-xs">Entry</th>
              <th className="pb-3 font-medium uppercase text-xs">Stop</th>
              <th className="pb-3 font-medium uppercase text-xs">Target</th>
              <th className="pb-3 font-medium uppercase text-xs">Last</th>
              <th className="pb-3 font-medium uppercase text-xs">Live P/L</th>
              <th className="pb-3 font-medium uppercase text-xs">Range</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr>
                <td colSpan="8" className="py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                  No open positions
                </td>
              </tr>
            )}

            {positions.map((pos) => {
              const progress = getProgress(pos.stop, pos.target, pos.last);
              const progressColor = getProgressColor(pos.entry, pos.stop, pos.target, pos.last);
              const pnlPositive = pos.live_pnl >= 0;

              return (
                <tr key={pos.id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                  <td className="py-3">
                    <div className="font-semibold text-white">{pos.ticker}</div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{pos.market}</div>
                  </td>
                  <td className="py-3 font-mono">{pos.qty}</td>
                  <td className="py-3 font-mono">{pos.entry}</td>
                  <td className="py-3 font-mono text-red-400">{pos.stop}</td>
                  <td className="py-3 font-mono text-green-400">{pos.target}</td>
                  <td className="py-3 font-mono">{pos.last}</td>
                  <td className={`py-3 font-mono font-medium ${pnlPositive ? 'text-green-400' : 'text-red-400'}`}>
                    {pnlPositive ? '+' : ''}{pos.live_pnl?.toFixed(2)}
                  </td>
                  <td className="py-3 w-32">
                    <div className="progress-rail">
                      <div className={`progress-fill ${progressColor}`} style={{ width: `${progress}%` }}></div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default PositionPanel;
