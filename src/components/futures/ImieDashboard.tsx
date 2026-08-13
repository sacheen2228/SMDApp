"use client';

import type { MarketPlaybook } from '@/engines/imie/types';

interface ImieDashboardProps {
  playbook: MarketPlaybook | null;
}

export function ImieDashboard({ playbook }: ImieDashboardProps) {
  if (!playbook) {
    return (
      <div className="col-span-3 p-4 rounded text-center" style={{ background: '#0a0e17', border: '1px solid #1e222d' }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: '#5d6070' }}>INSTRUMENT MARKET INTELLIGENCE ENGINE</div>
        <div className="text-xl font-bold mt-2" style={{ color: '#787b86' }}>Awaiting Market Data...</div>
        <div className="text-[10px] mt-1" style={{ color: '#5d6070' }}>Load 15m+ candles, order book, and market state to generate playbook</div>
      </div>
    );
  }

  const gradeColors = {
    'A': '#26a69a', 'B': '#ff5d00', 'C': '#ef5350', 'D': '#ef5350', 'F': '#e53935',
  };

  const convictionColors = {
    'STRONG': '#26a69a', 'MODERATE': '#ff5d00', 'WEAK': '#ef5350', 'AVOID': '#e53935',
  };

  return (
    <div className="col-span-3 space-y-2">
      {/* ===== TOP ROW: AI SCORE + GRADE + CONVICTION + STATE ===== */}
      <div className="grid gap-1 p-2 rounded" style={{ background: '#0d1321', border: '1px solid #1e222d', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr' }}>
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>IMIE AI Score</div>
          <div className="text-lg font-bold" style={{ color: gradeColors[playbook.summary.grade] }}>{playbook.aiScore}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Conviction</div>
          <div className="text-sm font-bold" style={{ color: convictionColors[playbook.summary.conviction] }}>{playbook.summary.conviction}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Market State</div>
          <div className="text-sm font-bold" style={{ color: '#d1d4dc' }}>{playbook.marketState.state}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Auction</div>
          <div className="text-sm font-bold" style={{ color: playbook.auction.acceptance ? '#26a69a' : playbook.auction.rejection ? '#ef5350' : '#787b86' }}>{playbook.auction.acceptance ? 'Acceptance' : playbook.auction.rejection ? 'Rejection' : 'Testing'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#5d6070' }}>Intent</div>
          <div className="text-sm font-bold" style={{ color: playbook.intent.primaryProbability > 70 ? '#26a69a' : playbook.intent.primaryProbability > 50 ? '#ff5d00' : '#ef5350' }}>{playbook.intent.primary.replace(/_/g, ' ')}</div>
        </div>
      </div>

      {/* ===== MIDDLE ROW: DESTINATION & PATH ===== */}
      <div className="grid gap-2 p-2 rounded" style={{ background: '#0d1321', border: '1px solid #1e222d', gridTemplateColumns: '1.5fr 1fr 1fr' }}>
        {/* LEFT: Primary Destination */}
        <div>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>PRIMARY DESTINATION</div>
          {playbook.destinations.topDestination ? (
            <div className="p-2 rounded" style={{ background: '#0a0e17' }}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-bold" style={{ color: '#d1d4dc' }}>{playbook.destinations.topDestination.nodeType}</div>
                <div className="text-xs" style={{ color: playbook.destinations.topDestination.probability > 70 ? '#26a69a' : playbook.destinations.topDestination.probability > 50 ? '#ff5d00' : '#ef5350' }}>{playbook.destinations.topDestination.probability}%</div>
              </div>
              <div className="text-xs" style={{ color: '#5d6070' }}>Expected: ${playbook.destinations.topDestination.price.toFixed(2)}</div>
              <div className="text-xs" style={{ color: '#5d6070' }}>Path: {playbook.destinations.topDestination.expectedMinutes}</div>
              <div className="text-xs" style={{ color: playbook.destinations.topDestination.expectedReaction === 'acceleration' ? '#26a69a' : playbook.destinations.topDestination.expectedReaction === 'continuation' ? '#ff5d00' : playbook.destinations.topDestination.expectedReaction === 'absorption' ? '#5d6070' : '#e53935' }}>
                Reaction: {playbook.destinations.topDestination.expectedReaction}
              </div>
              <div className="text-[10px] mt-1" style={{ color: '#5d6070' }}>{playbook.destinations.topDestination.node.source}</div>
            </div>
          ) : (
            <div className="p-2 rounded text-center text-xs" style={{ background: '#0a0e17', color: '#5d6070' }}>
              No primary destination identified
            </div>
          )}
        </div>

        {/* CENTER: TRADE PLAN */}
        <div>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>TRADE PLAN</div>
          {playbook.plan ? (
            <div className="p-2 rounded" style={{ background: '#0a0e17' }}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-bold" style={{ color: playbook.plan.direction === 'long' ? '#26a69a' : '#ef5350' }}>{playbook.plan.direction.toUpperCase()}</div>
                <div className="text-[10px]" style={{ color: playbook.plan.confidence > 0.7 ? '#26a69a' : playbook.plan.confidence > 0.5 ? '#ff5d00' : '#ef5350' }}>{(playbook.plan.confidence * 100).toFixed(0)}% Conf</div>
              </div>
              <div className="text-xs" style={{ color: '#5d6070' }}>Entry: ${playbook.plan.entry.price.toFixed(2)}</div>
              <div className="text-xs" style={{ color: '#5d6070' }}>{playbook.plan.entry.source}</div>
              <div className="text-xs" style={{ color: '#5d6070' }}>SL: ${playbook.plan.stop.price.toFixed(2)}</div>
              <div className="text-xs" style={{ color: '#5d6070' }}>{playbook.plan.stop.source}</div>
              <div className="text-xs mt-1" style={{ color: playbook.plan.riskReward > 2.0 ? '#26a69a' : playbook.plan.riskReward > 1.5 ? '#ff5d00' : '#ef5350' }}>
                RR: {playbook.plan.riskReward.toFixed(2)}
              </div>
              <div className="text-xs mt-1" style={{ color: '#5d6070' }}>Tps: {playbook.plan.tp.length}</div>
              <div className="text-xs" style={{ color: '#5d6070' }}>Explanation: {playbook.plan.explanation}</div>
            </div>
          ) : (
            <div className="p-2 rounded text-center text-xs" style={{ background: '#0a0e17', color: '#5d6070' }}>
              Trade plan rejected by validation
            </div>
          )}
        </div>

        {/* RIGHT: VALIDATION SUMMARY */}
        <div>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#787b86' }}>VALIDATION</div>
          {playbook.validation.approved ? (
            <div className="p-2 rounded" style={{ background: '#0a0e17', border: '1px solid #26a69a' }}>
              <div className="text-xs font-bold" style={{ color: '#26a69a' }}>APPROVED</div>
              <div className="text-[10px] mt-1" style={{ color: '#5d6070' }}>Reason: Trade passes all thresholds</div>
            </div>
          ) : (
            <div className="p-2 rounded" style={{ background: '#0a0e17', border: '1px solid #ef5350' }}>
              <div className="text-xs font-bold" style={{ color: '#ef5350' }}>REJECTED</div>
              <div className="text-[10px] mt-1 max-h-12 overflow-y-auto" style={{ color: '#ef5350' }}>
                {playbook.validation.rejectReasons.map((r, i) => (
                  <div key={i}>• {r}</div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2 text-[9px]" style={{ color: '#5d6070' }}>
            Data Quality: {playbook.validation.dataQuality}% | AI Score: {playbook.validation.aiScore} | RR: {playbook.validation.rr}
          </div>
        </div>
      </div>

      {/* ===== BOTTOM ROW: MARKET PLAYBOOK SUMMARY ===== */}
      <div className="p-2 rounded" style={{ background: '#0d1321', border: '1px solid #1e222d' }}>
        <div className="text-[10px] font-bold uppercase mb-2" style={{ color: '#787b86' }}>MARKET PLAYBOOK SUMMARY</div>
        <div className="space-y-1">
          {playbook.summary.playbook.map((line, i) => (
            <div key={i} className="text-xs" style={{ color: line.includes('STOPPED') || line.includes('REJECTION') || line.includes('AVOID') ? '#ef5350' : line.includes('STRONG') || line.includes('ACCEPTED') ? '#26a69a' : '#d1d4dc' }}>
              {line}
            </div>
          ))}
        </div>
        <div className="mt-2 pt-2 border-t" style={{ borderColor: '#1e222d' }}>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>ESTIMATED PATH</div>
          {playbook.summary.expectedPath.map((step, i) => (
            <div key={i} className="text-xs" style={{ color: '#5d6070' }}>{step}</div>
          ))}
        </div>
        <div className="mt-2 pt-2 border-t" style={{ borderColor: '#1e222d' }}>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>FAILURE CONDITION</div>
          <div className="text-xs" style={{ color: '#ef5350' }}>{playbook.summary.failureCondition}</div>
        </div>
        <div className="mt-2 pt-2 border-t" style={{ borderColor: '#1e222d' }}>
          <div className="text-[10px] font-bold uppercase mb-1" style={{ color: '#5d6070' }}>WINDOW</div>
          <div className="text-xs" style={{ color: '#d1d4dc' }}>{playbook.summary.estimatedWindow}</div>
        </div>
      </div>
    </div>
  );
}
