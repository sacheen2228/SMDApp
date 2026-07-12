import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import StatsBand from './components/StatsBand';
import AlertPanel from './components/AlertPanel';
import PositionPanel from './components/PositionPanel';
import WinLossChart from './components/WinLossChart';
import ClosedTrades from './components/ClosedTrades';

const API_BASE = window.location.origin;
const WS_URL = API_BASE.replace('http', 'ws') + '/ws';

function App() {
  const [data, setData] = useState({
    stats: { today_pnl: 0, win_rate: 0, trades_today: 0, open_count: 0, alltime_pnl: 0 },
    alerts: [],
    positions: [],
    closed: [],
    winners_vs_losers: { wins: 0, losses: 0 },
  });
  const [connected, setConnected] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, alertsRes, positionsRes, closedRes] = await Promise.all([
        fetch(`${API_BASE}/api/stats`),
        fetch(`${API_BASE}/api/alerts`),
        fetch(`${API_BASE}/api/positions`),
        fetch(`${API_BASE}/api/closed`),
      ]);
      const stats = await statsRes.json();
      const alerts = await alertsRes.json();
      const positions = await positionsRes.json();
      const closed = await closedRes.json();

      setData({
        stats: {
          today_pnl: stats.today_pnl,
          win_rate: stats.win_rate,
          trades_today: stats.today_trades,
          open_count: stats.open_positions,
          alltime_pnl: stats.alltime_pnl,
        },
        alerts,
        positions,
        closed,
        winners_vs_losers: { wins: stats.wins || 0, losses: stats.losses || 0 },
      });
    } catch (e) {
      console.error('Fetch error:', e);
    }
  }, []);

  useEffect(() => {
    fetchData();

    let ws;
    let pollInterval;

    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const newData = JSON.parse(event.data);
        setData(newData);
      };
      ws.onerror = () => setConnected(false);
      ws.onclose = () => {
        setConnected(false);
        pollInterval = setInterval(fetchData, 5000);
      };
    } catch (e) {
      pollInterval = setInterval(fetchData, 5000);
    }

    return () => {
      if (ws) ws.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [fetchData]);

  return (
    <div className="min-h-screen p-6 max-w-[1600px] mx-auto">
      <Header connected={connected} />
      <StatsBand stats={data.stats} />

      <div className="grid grid-cols-12 gap-5 mt-5">
        <div className="col-span-12 lg:col-span-4">
          <AlertPanel alerts={data.alerts} />
        </div>

        <div className="col-span-12 lg:col-span-8 space-y-5">
          <PositionPanel positions={data.positions} />

          <div className="grid grid-cols-2 gap-5">
            <WinLossChart data={data.winners_vs_losers} />
            <ClosedTrades trades={data.closed} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
