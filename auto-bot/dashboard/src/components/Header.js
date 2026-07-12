import React from 'react';

function Header({ connected }) {
  return (
    <header className="flex items-center justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          BREAKOUT<span className="text-gray-500">/</span>DESK
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          S&amp;P 500 · NIFTY 100 · 1H BREAKOUT SCREENER
        </p>
      </div>

      <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`}></span>
          <span>{connected ? 'LIVE' : 'POLLING'}</span>
        </div>
      </div>
    </header>
  );
}

export default Header;
