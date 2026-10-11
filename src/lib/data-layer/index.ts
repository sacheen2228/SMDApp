// Central Data Layer — SMDApp
// Provider priority: NSE/BSE (primary) → MOAPI (fallback) → NO_DATA
// Yahoo must NEVER enter the option-chain path.
// Scrapling/Web Intel = evidenceOnly, never overrides structured data.

// ── Public types (canonical — defined in ./types.ts) ─────────────────
export type {
  FreshnessLevel,
  DataProvenance,
  OptionStrike,
  OptionLeg,
  OptionChainData,
  QuoteData,
  GainersLosers,
  MostActiveEquity,
  MostActiveContract,
  OISpurt,
  FiiDiiRow,
  EnrichedNewsItem,
  HistoricalCandle,
  ProviderResult,
  ProviderModule,
  AgentContextFragment,
} from '@/lib/data-layer/types';

// ── Freshness classifier (re-exported from api-freshness) ────────────
export { classifyFreshness } from '@/lib/api-freshness';

// ── Provider modules ─────────────────────────────────────────────────
export { nseProvider } from '@/lib/data-layer/providers/nse';
export { moProvider } from '@/lib/data-layer/providers/mo';
export { bseProvider } from '@/lib/data-layer/providers/bse';

// ── Option chain (canonical entry point) ────────────────────────────
export { normalizeOptionChain, getOptionChain } from '@/lib/data-layer/chains/option-chain';

// ── Cache ────────────────────────────────────────────────────────────
export { TtlCache } from '@/lib/data-layer/cache';

// ── Health ───────────────────────────────────────────────────────────
export { freshnessFromProvenance, quickHealthCheck } from '@/lib/data-layer/health';

// ── News ─────────────────────────────────────────────────────────────
export { getRecentNews, enrichNewsItem, buildNewsSentiment } from '@/lib/data-layer/news';

// ── Agent ────────────────────────────────────────────────────────────
export { buildAgentContextFragment, __agentContextFake } from '@/lib/data-layer/agent';
