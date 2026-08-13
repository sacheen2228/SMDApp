'use client';

// IST session windows (UTC+5:30)
const SESSION_WINDOWS: Record<string, { start: number; end: number; label: string; color: string }> = {
  sydney: { start: 5.5, end: 12.5, label: 'SYDNEY', color: '#ffeb3b' },
  tokyo: { start: 7.5, end: 16.5, label: 'TOKYO', color: '#e91e63' },
  london: { start: 13.5, end: 22.5, label: 'LONDON', color: '#2157f3' },
  newyork: { start: 18.5, end: 27.5, label: 'NEW YORK', color: '#ff5d00' },
};

function getRegimeDisplay(confidence: number) {
  if (confidence >= 0.75) return { text: 'STRONG BULL', color: '#26a69a' };
  if (confidence >= 0.60) return { text: 'BULLISH', color: '#26a69a' };
  if (confidence >= 0.45) return { text: 'NEUTRAL', color: '#787b86' };
  if (confidence >= 0.30) return { text: 'BEARISH', color: '#ef5350' };
  return { text: 'STRONG BEAR', color: '#ef5350' };
}

function SessionPill({ name, active, color }: { name: string; active: boolean; color: string }) {
  return (
    <div className="px-2 py-1 text-[10px] font-bold rounded border transition-all" style={{ background: active ? `${color}18` : 'transparent', borderColor: active ? color : '#1e222d', color: active ? color : '#2a2d35' }}>
      {name}
    </div>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.min(Math.max(value, 0), 1) * 100;
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="w-16 text-[10px] font-medium" style={{ color: '#787b86' }}>{label}</span>
      <div className="flex-1 h-1.5 bg-[#1e222d] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-8 text-right text-[10px]" style={{ color: '#d1d4dc' }}>{value.toFixed(2)}</span>
    </div>
  );
}

interface Props {
  lastPrice: number;
  change24h: number;
  cumDelta: number;
  microTrend: number;
  rawConfidence: number;
  sessions: Record<string, boolean>;
}

export function AiRegimePanel({ lastPrice, change24h, cumDelta, microTrend, rawConfidence, sessions }: Props) {
  const regime = getRegimeDisplay(rawConfidence);
  const isBull = change24h >= 0;

  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const active = Object.entries(SESSION_WINDOWS).find(([, s]) => {
    const start = s.start;
    const end = s.end;
    if (end > 24) return h >= start || h < end - 24;
    return h >= start && h < end;
  });

  const driverText = microTrend > 0.4 ? 'CHoCH + BOS Breakout'
    : microTrend < -0.4 ? 'Distribution / Sell Pressure'
    : 'Range / Indecision';

  return (
    <div className="p-3 text-xs flex flex-col h-full" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: '#787b86' }}>AI Regime</span>
        {active && (
          <span className="text-[9px] font-bold px-2 py-0.5 rounded uppercase" style={{ background: `${active[1].color}15`, color: active[1].color, border: `1px solid ${active[1].color}40` }}>
            {active[1].label}
          </span>
        )}
      </div>

      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>MARKET STATE</div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-sm font-bold" style={{ color: regime.color }}>{regime.text}</span>
          <span className="text-[10px]" style={{ color: '#787b86' }}>{(rawConfidence * 100).toFixed(1)}%</span>
        </div>
        <div className="h-1.5 bg-[#1e222d] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${rawConfidence * 100}%`, background: regime.color }} />
        </div>
      </div>

      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>PRIMARY DRIVER</div>
        <div className="text-xs" style={{ color: '#d1d4dc' }}>{driverText}</div>
      </div>

      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>SESSIONS</div>
        <div className="grid grid-cols-2 gap-1">
          {Object.entries(SESSION_WINDOWS).map(([k, s]) => (
            <SessionPill key={k} name={s.label} active={sessions[k]} color={s.color} />
          ))}
        </div>
      </div>

      <div className="mt-auto border-t border-[#1e222d] pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold" style={{ color: '#d1d4dc' }}>SCORE: {rawConfidence.toFixed(2)}</span>
          <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: regime.color + '18', color: regime.color, border: `1px solid ${regime.color}40` }}>
            {rawConfidence >= 0.6 ? 'LONG' : rawConfidence <= 0.4 ? 'SHORT' : 'FLAT'}
          </span>
        </div>
        <ScoreBar label="STRUCTURE" value={rawConfidence * 0.95} color="#2157f3" />
        <ScoreBar label="FLOW" value={Math.min(1, Math.max(0, cumDelta / 10 + 0.5))} color="#26a69a" />
        <ScoreBar label="TREND" value={rawConfidence} color={isBull ? '#26a69a' : '#ef5350'} />
        <ScoreBar label="MICRO" value={(microTrend + 1) / 2} color={microTrend > 0 ? '#26a69a' : '#ef5350'} />
      </div>
    </div>
  );
}
