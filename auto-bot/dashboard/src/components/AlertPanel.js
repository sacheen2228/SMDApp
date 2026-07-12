import React from 'react';

function AlertPanel({ alerts }) {
  return (
    <div className="card h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
          Awaiting Your Call
        </h2>
        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400">
          {alerts.length} pending
        </span>
      </div>

      <div className="space-y-3 max-h-[600px] overflow-y-auto">
        {alerts.length === 0 && (
          <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
            No pending alerts. Scan running...
          </div>
        )}

        {alerts.map((alert) => (
          <div
            key={alert.id}
            className="p-4 rounded-lg border-l-2 border-yellow-500"
            style={{ backgroundColor: 'var(--bg-hover)' }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-white text-lg">{alert.ticker}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                {alert.market} · {alert.time}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>Broke</div>
                <div className="font-mono text-green-400">{alert.broke}</div>
              </div>
              <div>
                <div className="text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>Stop</div>
                <div className="font-mono text-red-400">{alert.stop}</div>
              </div>
              <div>
                <div className="text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>Target</div>
                <div className="font-mono text-green-400">{alert.target}</div>
              </div>
            </div>

            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {alert.touches} touches · volume {alert.volume} average · qty {alert.qty}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AlertPanel;
