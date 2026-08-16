// Market Session Engine
// Indian market session awareness for trade timing and confidence adjustment.
// Instrument-aware so the CAS (Closing Auction Session) timeline for F&O-eligible
// cash stocks differs from the index/derivative timeline.
//
// CAS timeline (from 2026-08-03, per SEBI/NSE):
//   F&O-eligible cash stocks: continuous trading ends 15:15, then
//     15:15-15:20 Transition (no orders)
//     15:20-15:25 Order entry I (market + limit)
//     15:25-15:30 Order entry II (limit only, random close 15:28-15:30)
//     15:30-15:35 Matching -> equilibrium price = closing price
//   Non-CAS cash stocks: trade until 15:30, close = 15:00-15:30 VWAP
//   Index + stock derivatives: trade until 15:40
//   Post-close cash session: 15:50-16:00

export type MarketInstrument = 'index' | 'fno-stock' | 'cash-stock';

export type MarketSession =
  | 'pre_open'          // 09:00 - 09:15
  | 'opening'           // 09:15 - 09:30
  | 'trend_form'        // 09:30 - 10:30
  | 'primary'           // 10:30 - 12:30
  | 'low_liq'           // 12:30 - 13:45
  | 'afternoon'         // 13:45 - 15:00
  | 'closing'           // 15:00 - 15:30 (index: still trading; non-CAS cash: last VWAP window)
  | 'cas_reference'     // 15:00 - 15:15 (CAS reference price VWAP window)
  | 'cas_transition'    // 15:15 - 15:20 (no orders accepted)
  | 'cas_order_entry'   // 15:20 - 15:25 (market + limit orders)
  | 'cas_limit_only'    // 15:25 - 15:30 (limit orders only, random close)
  | 'cas_matching'      // 15:30 - 15:35 (matching -> equilibrium closing price)
  | 'derivatives_open'  // 15:35 - 15:40 (F&O derivatives still trading)
  | 'post_close'        // 15:50 - 16:00 (cash trades at closing price)
  | 'closed';           // after session ends

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

function timeStr(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ─── Session Lookup Helpers ──────────────────────────────────────
function baseSession(minutes: number): SessionInfo {
  const t = timeStr(minutes);

  if (minutes < 555) { // before / 09:00 - 09:15
    return {
      session: 'pre_open',
      label: 'Pre-Market',
      description: 'Market not open yet. No live data available.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Market opens at 09:15 IST', 'Pre-open auction runs 09:00-09:15', 'Final auction price becomes opening price'],
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

  return { session: 'closed', label: 'Market Closed', description: '', confidenceMultiplier: 0, allowedActions: ['WAIT'], notes: [] };
}

// ─── CAS Timeline for F&O-eligible Cash Stocks (15:00 - 15:35) ────
function casStockSession(minutes: number): SessionInfo {
  const t = timeStr(minutes);

  if (minutes < 915) { // 15:00 - 15:15
    return {
      session: 'cas_reference',
      label: 'CAS Reference',
      description: 'Continuous trading still open. VWAP of this window becomes the CAS reference price.',
      confidenceMultiplier: 0.3,
      allowedActions: ['WAIT'],
      notes: [
        'Reference price = VWAP of trades 15:00-15:15',
        'Continuous trading ends at 15:15',
        'No new entries for cash stocks',
      ],
    };
  }

  if (minutes < 920) { // 15:15 - 15:20
    return {
      session: 'cas_transition',
      label: 'CAS Transition',
      description: 'Continuous trading ended. No new orders accepted during transition.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: [
        'No orders accepted 15:15-15:20',
        'Open limit orders carried into auction',
        '±3% price band vs reference price',
      ],
    };
  }

  if (minutes < 925) { // 15:20 - 15:25
    return {
      session: 'cas_order_entry',
      label: 'CAS Order Entry',
      description: 'Auction order entry — market and limit orders accepted. Indicative equilibrium price published.',
      confidenceMultiplier: 0.2,
      allowedActions: ['WAIT'],
      notes: [
        'Market + limit orders accepted',
        'Indicative equilibrium price live',
        '±3% band vs reference price',
      ],
    };
  }

  if (minutes < 930) { // 15:25 - 15:30
    return {
      session: 'cas_limit_only',
      label: 'CAS Limit Only',
      description: 'Only limit orders accepted. Market orders frozen. Window closes randomly 15:28-15:30.',
      confidenceMultiplier: 0.2,
      allowedActions: ['WAIT'],
      notes: [
        'Limit orders only',
        'No modify/cancel on market orders',
        'Random close between 15:28-15:30',
      ],
    };
  }

  if (minutes < 935) { // 15:30 - 15:35
    return {
      session: 'cas_matching',
      label: 'CAS Matching',
      description: 'Matching phase. All eligible orders execute at the single equilibrium price = official closing price.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: [
        'Equilibrium price = closing price',
        'Fallback: reference price -> LTP -> prev close',
        'Trades settle at closing price',
      ],
    };
  }

  return { session: 'closed', label: 'Market Closed', description: '', confidenceMultiplier: 0, allowedActions: ['WAIT'], notes: [] };
}

// ─── Determine Market Session (instrument-aware) ─────────────────
export function getCurrentSession(instrument: MarketInstrument = 'index'): SessionInfo {
  const minutes = getISTMinutes();

  // All instruments share the same pre-15:00 schedule
  if (minutes < 900) return baseSession(minutes);

  // Index / derivatives: trade until 15:40
  if (instrument === 'index') {
    if (minutes < 940) { // 15:00 - 15:40
      return {
        session: 'closing',
        label: 'Closing Session',
        description: 'Derivatives trade until 15:40. Manage exits carefully.',
        confidenceMultiplier: 0.3,
        allowedActions: ['WAIT'],
        notes: [
          'Index + stock derivatives open until 15:40',
          'Focus on managing existing positions',
          'Avoid new entries — volatility spikes',
        ],
      };
    }
    if (minutes < 950) { // 15:40 - 15:50
      return {
        session: 'closed',
        label: 'Market Closed',
        description: 'Derivatives closed. Cash post-close pending.',
        confidenceMultiplier: 0,
        allowedActions: ['WAIT'],
        notes: ['Next session starts at 09:15 IST'],
      };
    }
    if (minutes < 960) { // 15:50 - 16:00
      return {
        session: 'post_close',
        label: 'Post-Close Session',
        description: 'Cash segment post-close trades at closing price. Derivatives stay closed.',
        confidenceMultiplier: 0,
        allowedActions: ['WAIT'],
        notes: ['Cash trades at CAS/closing price', 'Not for new F&O positions'],
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

  // F&O-eligible cash stock: enters CAS at 15:15
  if (instrument === 'fno-stock') {
    if (minutes < 915) return casStockSession(minutes); // 15:00-15:15 reference
    if (minutes < 935) return casStockSession(minutes); // CAS phases
    if (minutes < 950) {
      return {
        session: 'closed',
        label: 'Market Closed',
        description: 'CAS done. Stock closed.',
        confidenceMultiplier: 0,
        allowedActions: ['WAIT'],
        notes: ['Closing price set by CAS auction'],
      };
    }
    if (minutes < 960) {
      return {
        session: 'post_close',
        label: 'Post-Close Session',
        description: 'Cash post-close trades at the CAS closing price.',
        confidenceMultiplier: 0,
        allowedActions: ['WAIT'],
        notes: ['Trades execute at CAS closing price'],
      };
    }
    return {
      session: 'closed',
      label: 'Market Closed',
      description: 'Market closed. Use EOD data for review and learning.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['No live trading possible', 'Use this time for trade journal review'],
    };
  }

  // Non-CAS cash stock: trade until 15:30, close = 15:00-15:30 VWAP
  if (minutes < 930) {
    return {
      session: 'closing',
      label: 'Closing Session',
      description: 'Final 30 minutes of continuous trading. Closing price = VWAP of this window.',
      confidenceMultiplier: 0.3,
      allowedActions: ['WAIT'],
      notes: [
        'Closing price = VWAP 15:00-15:30',
        'Focus on managing existing positions',
        'Square off before 15:30',
      ],
    };
  }
  if (minutes < 950) {
    return {
      session: 'closed',
      label: 'Market Closed',
      description: 'Market closed.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Closing price set by VWAP 15:00-15:30'],
    };
  }
  if (minutes < 960) {
    return {
      session: 'post_close',
      label: 'Post-Close Session',
      description: 'Cash post-close trades at closing price.',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Trades execute at closing price'],
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
    case 'cas_reference': return 85;
    case 'cas_order_entry': return 90;
    case 'cas_limit_only': return 90;
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
    case 'cas_reference': return 0;
    case 'cas_transition': return 0;
    case 'cas_order_entry': return 0;
    case 'cas_limit_only': return 0;
    case 'cas_matching': return 0;
    default: return 0;
  }
}
