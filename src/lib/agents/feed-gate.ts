// ═══════════════════════════════════════════════════════════════════════════
// Feed Gate — playbook rule "verify live data before analysing" as code.
// During market hours the pipeline must only produce trade levels when the
// Live Option Data Service (127.0.0.1:8765) reports all_live=true (spot/VIX
// and every chain LIVE). Service unreachable or not-all-live → engines are
// forced to NO_TRADE with an honest reason. After hours the gate never blocks
// (existing after-hours research behaviour is unchanged).
// ═══════════════════════════════════════════════════════════════════════════

import { getCurrentSession } from '@/lib/market-session';

export interface FeedGateResult {
  /** session clock says the market is open (time-based, IST) */
  marketOpen: boolean;
  /** the service answered /health successfully */
  checked: boolean;
  /** service reported all_live=true (spot/VIX + every chain LIVE) */
  allLive: boolean;
  /** market hours AND NOT (checked && allLive) → force NO_TRADE */
  blocked: boolean;
  /** /health "overall" field when checked (LIVE | CLOSED | DEGRADED | DEMO …) */
  overall?: string;
  /** honest one-liner when blocked */
  reason?: string;
}

export interface FeedGateDeps {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  isMarketOpen?: () => boolean;
  timeoutMs?: number;
  url?: string;
}

const DEFAULT_URL = 'http://127.0.0.1:8765/health';
const DEFAULT_TIMEOUT_MS = 1500;

function defaultIsMarketOpen(): boolean {
  try {
    return getCurrentSession('index').isMarketOpen;
  } catch {
    // Session config unavailable → behave as open so the feed check still
    // guards the decision (fail closed, never fail open).
    return true;
  }
}

export async function evaluateFeedGate(deps: FeedGateDeps = {}): Promise<FeedGateResult> {
  const url = deps.url ?? DEFAULT_URL;
  const isMarketOpen = deps.isMarketOpen ?? defaultIsMarketOpen;
  const fetchImpl = deps.fetchImpl ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const marketOpen = isMarketOpen();
  if (!marketOpen) {
    return { marketOpen: false, checked: false, allLive: false, blocked: false };
  }

  let checked = false;
  let allLive = false;
  let overall: string | undefined;
  let failNote = '';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (res.ok) {
        const body = (await res.json()) as { overall?: string; all_live?: boolean };
        overall = typeof body.overall === 'string' ? body.overall : undefined;
        allLive = body.all_live === true;
        checked = true;
      } else {
        failNote = `HTTP ${res.status}`;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    failNote = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err);
  }

  const blocked = !(checked && allLive);
  if (!blocked) {
    return { marketOpen: true, checked, allLive, blocked, overall };
  }

  const reason = checked
    ? `Live feeds not all fresh during market hours (all_live=false, overall=${overall})`
    : `Live data service unreachable at ${url} — ${failNote || 'no response'} (service not running?)`;
  return { marketOpen: true, checked, allLive, blocked, overall, reason };
}

/** Engine-shaped NO_TRADE used when the gate blocks — reasons carry the honest cause. */
export function feedGateNoTrade(gate: FeedGateResult) {
  return {
    action: 'NO_TRADE' as const,
    reasons: [`Feed gate: ${gate.reason || 'live feed verification failed'}`],
    risks: [
      'Playbook: trade levels only when meta.all_live=true — live feed verification failed',
    ],
    confidence: 0,
    grade: 'F',
  };
}
