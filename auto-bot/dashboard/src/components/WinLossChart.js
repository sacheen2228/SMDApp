import React from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from 'recharts';

function WinLossChart({ data }) {
  const wins = data.wins || 0;
  const losses = data.losses || 0;
  const chartData = [
    { name: 'Wins', value: wins, color: '#00d084' },
    { name: 'Losses', value: losses, color: '#ff4757' },
  ];
  const total = wins + losses;

  return (
    <div className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white mb-4">
        Winners vs Losers
      </h2>

      <div className="flex items-center justify-between mb-3 text-sm">
        <span className="text-green-400 font-medium">{wins} WINS</span>
        <span className="text-red-400 font-medium">{losses} LOSSES</span>
      </div>

      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical">
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" hide />
            <Bar dataKey="value" radius={[4, 4, 4, 4]} barSize={24}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 h-8 rounded-lg overflow-hidden flex">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${total > 0 ? (wins / total) * 100 : 50}%` }}></div>
        <div className="h-full bg-red-500 transition-all" style={{ width: `${total > 0 ? (losses / total) * 100 : 50}%` }}></div>
      </div>
    </div>
  );
}

export default WinLossChart;
