// Market Session Engine
// Indian market session awareness for trade timing and confidence adjustment

export type MarketSession =
  | 'pre_open'      // 09:00 - 09:15
  | 'opening'       // 09:15 - 09:30
  | 'trend_form'    // 09:30 - 10:30
  | 'primary'       // 10:30 - 12:30
  | 'low_liq'       // 12:30 - 13:45
  | 'afternoon'     // 13:45 - 15:00
  | 'closing'       // 15:00 - 15:30
  | 'closed';       // after 15:30

export interface SessionInfo {
  session: MarketSession;
  label: string;
  description: string;
  confidenceMultiplier: number;  // 0.0 - 1.0
  allowedActions: ('BUY_CALL' | 'BUY_PUT' | 'WAIT')[];
  notes: string[];
}

// ─── Get Current IST Time ────────────────────────────────────────
function getISTTime(): Date {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs);
}

function getISTMinutes(): number {
  const ist = getISTTime();
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// ─── Determine Market Session ────────────────────────────────────
export function getCurrentSession(): SessionInfo {
  const minutes = getISTMinutes();
  const hour = Math.floor(minutes / 60);
  const min = minutes % 60;
  const timeStr = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;

  if (minutes < 540) { // before 09:00
    return {
      session: 'pre_open',
      label: 'Pre-Market',
      description: 'Market not open yet. No live data available.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Market opens at 09:15 IST'],
    };
  }

  if (minutes < 555) { // 09:00 - 09:15
    return {
      session: 'pre_open',
      label: 'Pre-Market',
      description: 'Pre-opening session. No trading.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Orders can be placed but not executed'],
    };
  }

  if (minutes < 570) { // 09:15 - 09:30
    return {
      session: 'opening',
      label: 'Opening Volatility',
      description: 'High volatility. Avoid early entries unless exceptionally strong evidence.',
      confidenceMultiplier: 0.4,
      allowedActions: ['WAIT'],
      notes: [
        'Opening gap moves are often reversed',
        'Wait for 15-min candle to close',
        'Avoid chasing first move',
      ],
    };
  }

  if (minutes < 630) { // 09:30 - 10:30
    return {
      session: 'trend_form',
      label: 'Trend Formation',
      description: 'Market establishing direction. Best time for trend confirmation.',
      confidenceMultiplier: 0.8,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: [
        'First clear trend of the day',
        'Volume confirmation important',
        'Good for breakout/breakdown entries',
      ],
    };
  }

  if (minutes < 750) { // 10:30 - 12:30
    return {
      session: 'primary',
      label: 'Primary Window',
      description: 'Best trading window. Highest liquidity and clearest moves.',
      confidenceMultiplier: 1.0,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: [
        'Highest probability setups',
        'Best liquidity for entries/exits',
        'Institutional activity peaks',
      ],
    };
  }

  if (minutes < 825) { // 12:30 - 13:45
    return {
      session: 'low_liq',
      label: 'Low Liquidity',
      description: 'Reduced liquidity. Lunch hours. Lower confidence for marginal setups.',
      confidenceMultiplier: 0.65,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: [
        'Wider spreads possible',
        'Reduce position size',
        'Only take high-confidence setups',
      ],
    };
  }

  if (minutes < 900) { // 13:45 - 15:00
    return {
      session: 'afternoon',
      label: 'Afternoon Session',
      description: 'Trend continuation or reversal window. Watch for late-day moves.',
      confidenceMultiplier: 0.85,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: [
        'Position unwinding begins',
        'Can see strong moves in either direction',
        'Good for continuation trades',
      ],
    };
  }

  if (minutes < 930) { // 15:00 - 15:30
    return {
      session: 'closing',
      label: 'Closing Session',
      description: 'Final 30 minutes. Manage exits carefully. No new entries.',
      confidenceMultiplier: 0.3,
      allowedActions: ['WAIT'],
      notes: [
        'Focus on managing existing positions',
        'Avoid new entries — volatility spikes',
        'Square off before 15:30',
      ],
    };
  }

  return {
    session: 'closed',
    label: 'Market Closed',
    description: 'Market closed. Use EOD data for review and learning.',
    confidenceMultiplier: 0,
    allowedActions: ['WAIT'],
    notes: [
      'No live trading possible',
      'Use this time for trade journal review',
      'Analyze today\'s signals for learning',
    ],
  };
}

// ─── Adjust Confidence for Session ───────────────────────────────
export function adjustConfidenceForSession(
  baseConfidence: number,
  session?: SessionInfo
): number {
  const s = session || getCurrentSession();
  return Math.round(baseConfidence * s.confidenceMultiplier);
}

// ─── Check if Trade is Allowed ───────────────────────────────────
export function isTradeAllowed(
  direction: 'CALL' | 'PUT',
  session?: SessionInfo
): { allowed: boolean; reason: string } {
  const s = session || getCurrentSession();
  const action = direction === 'CALL' ? 'BUY_CALL' : 'BUY_PUT';

  if (s.allowedActions.includes(action)) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason: `${s.label}: ${s.description}`,
  };
}

// ─── Get Session-Adjusted Confidence Threshold ───────────────────
export function getConfidenceThreshold(session?: SessionInfo): number {
  const s = session || getCurrentSession();

  // Higher thresholds during risky sessions
  switch (s.session) {
    case 'opening': return 75;      // Very high bar during opening volatility
    case 'low_liq': return 70;     // High bar during low liquidity
    case 'closing': return 80;     // Almost no new entries in closing
    case 'trend_form': return 55;  // Normal threshold during trend formation
    case 'primary': return 50;     // Lowest threshold during best window
    case 'afternoon': return 55;   // Normal threshold
    default: return 60;
  }
}

// ─── Get Position Size Multiplier ────────────────────────────────
export function getPositionSizeMultiplier(session?: SessionInfo): number {
  const s = session || getCurrentSession();

  switch (s.session) {
    case 'opening': return 0.5;    // Half size during opening
    case 'trend_form': return 0.75; // 75% during trend formation
    case 'primary': return 1.0;    // Full size during primary window
    case 'low_liq': return 0.5;    // Half size during low liquidity
    case 'afternoon': return 0.75; // 75% during afternoon
    case 'closing': return 0;      // No new positions in closing
    default: return 0;
  }
}
