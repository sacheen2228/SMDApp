// Unified health & freshness classifier — SMDApp central data layer
// Merges the invariants from:
//   • src/lib/provider-health.ts  (circuit breaker, reliability scores)
//   • src/lib/api-freshness.ts    (classifyFreshness, FreshnessLevel)
//   • src/lib/session-health.ts   (sole [SYSTEM][SESSION_EXPIRED] sender)
//
// ESSENTIAL INVARIANTS (immutable):
//   1. NSE must NEVER classify as SESSION_EXPIRED — session-health alerting
//      is handled exclusively by session-health.ts; this module only ever
//      returns freshness levels; it never emits Telegram alerts.
//   2. fallbackUsed flag must be set true whenever the primary source (NSE)
//      returns non-200, times out, or returns stale data.
//   3. Freshness is always derived from the ORIGINAL publishedAt / collectedAt
//      pair — never guessed from "how long ago we got it".

import { classifyFreshness } from '@/lib/api-freshness';
import type { FreshnessLevel, DataProvenance } from '@/lib/data-layer/types';

// ── Freshness from provenance envelope ─────────────────────────────────

/** Given a DataProvenance envelope, return the FreshnessLevel.
 *  Uses the original publishedAt (provider time) as the data timestamp.
 *  Falls back to collectedAt when publishedAt is unavailable. */
export function freshnessFromProvenance(
  provenance: DataProvenance,
  now = Date.now(),
  dataType = 'default',
): FreshnessLevel {
  const ts = provenance.publishedAt ?? provenance.collectedAt;
  if (!ts) return 'UNAVAILABLE';
  const dataTs = Date.parse(ts);
  if (isNaN(dataTs)) return 'UNAVAILABLE';
  const ageMs = now - dataTs;
  return classifyFreshness(ageMs, dataType);
}

// ── Provider health check (lightweight; does NOT emit Telegram) ──────────

/** Inspect a raw provider response and return whether it should be considered
 *  healthy enough to use as the primary source. Returns an object with
 *  `healthy: boolean` and `reason: string`; callers decide the fallback.
 *
 *  This is a **stateless** check — it does NOT maintain circuit-breaker
 *  state (that lives in `provider-health.ts`). */
export function quickHealthCheck(
  response: Response | null,
): { healthy: boolean; reason: string } {
  if (!response) return { healthy: false, reason: 'no-response' };
  if (!response.ok) return { healthy: false, reason: `http-${response.status}` };
  if (response.type !== 'basic' && response.type !== 'cors')
    return { healthy: false, reason: 'unexpected-content-type' };
  const ct = response.headers.get('content-type');
  if (ct && !ct.includes('application/json'))
    return { healthy: false, reason: 'non-json-content-type' };
  return { healthy: true, reason: 'ok' };
}

// ── Exported types ─────────────────────────────────────────────────────

export type { FreshnessLevel };
