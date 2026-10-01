// ═══════════════════════════════════════════════════════════════════════════
// Jarvis Bridge (v2 §2) — thin, fail-safe wrappers over frozen src/lib/jarvis/.
// src/lib/jarvis/ is NEVER modified; all reshaping/degradation happens here.
// Every bridge reads ctx.jarvisChain — a pure mapping of the ONE snapshot
// fetch — so wrapping jarvis adds ZERO outbound calls.
// Degradation contract: return null/0 on any problem; the calling agent
// falls back to its SMDApp-context inputs. Never throws into the registry.
// ═══════════════════════════════════════════════════════════════════════════

import { optionChainScore, fiiScore } from '../jarvis/scoring';
import { analyseGreeks } from '../jarvis/greeks';
import { buildLevels } from '../jarvis/levels';
import { signedNewsScore } from '../jarvis-adapters';
import type {
  OptionChain, GreeksResult, LevelsResult, FiiDiiRow,
} from '../jarvis/types';
import type { AgentContext } from './agent-contract';

type ChainScore = ReturnType<typeof optionChainScore>;

// jarvis parseExpiry expects NSE "25-Sep-2026"; anything else silently
// produces NaN inside analyseGreeks — reject up front instead.
const NSE_EXPIRY_RE = /^\d{1,3}-[A-Za-z]{3}-\d{4}$/;

export function validJarvisChain(ctx: AgentContext): OptionChain | null {
  const oc = ctx.jarvisChain;
  if (!oc || !Array.isArray(oc.data) || oc.data.length === 0) return null;
  if (!NSE_EXPIRY_RE.test(oc.expiryDates?.[0] || '')) return null;
  if (!Number.isFinite(oc.underlyingValue) || oc.underlyingValue <= 0) return null;
  return oc;
}

/** Agent 07 — canonical OI/PCR from jarvis scoring (pcr, OI-wall support/resistance, max pain). */
export function bridgeChainScore(ctx: AgentContext): ChainScore | null {
  try {
    const oc = validJarvisChain(ctx);
    return oc ? optionChainScore(oc) : null;
  } catch {
    return null;
  }
}

/** Agents 09/10/11/14/25 — full greeks pass: ATM IV, skew, net GEX, gamma flip, 1σ move, per-strike deltas. */
export function bridgeGreeks(ctx: AgentContext, indiaVix?: number): GreeksResult | null {
  try {
    const oc = validJarvisChain(ctx);
    if (!oc) return null;
    const r = analyseGreeks(oc, indiaVix !== undefined ? { indiaVix } : {});
    return Number.isFinite(r.atmIv) && Number.isFinite(r.netGex) ? r : null;
  } catch {
    return null;
  }
}

/** Agent 19 — level map: OI walls, max pain, expected-move bands, confluence zones, spreads. */
export function bridgeLevels(ctx: AgentContext): LevelsResult | null {
  try {
    const oc = validJarvisChain(ctx);
    return oc ? buildLevels(oc) : null;
  } catch {
    return null;
  }
}

/** Agent 02 — jarvis FII thresholds (-6..+6) over the snapshot's latest flow. */
export function bridgeFiiScore(ctx: AgentContext): number {
  try {
    const rows: FiiDiiRow[] = [];
    if (ctx.fiiNet) rows.push({ category: 'FII/FPI', netValue: ctx.fiiNet });
    if (ctx.diiNet) rows.push({ category: 'DII', netValue: ctx.diiNet });
    return fiiScore(rows);
  } catch {
    return 0;
  }
}

/** Agents 26/28 — jarvis signed news scale via the shared adapters helper (no second formula). */
export function bridgeNewsSigned(ctx: AgentContext): number | null {
  const feedPresent = ctx.headlines.length > 0 || (ctx.newsSentiment && ctx.newsSentiment !== 'NEUTRAL');
  if (!feedPresent) return null; // hermes stores score 0 when the feed is absent — don't read it as -100
  try {
    return signedNewsScore(ctx.newsScore);
  } catch {
    return null;
  }
}
