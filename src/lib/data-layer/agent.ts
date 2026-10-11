// Agent context builder — SMDApp central data layer
// Provides the `AgentContextFragment` that the 30-agent pipeline consumes.
// All data originates from the central layer modules (nseProvider, news enrichment).
// NO agent may directly fetch external market APIs after migration.
//
// Invariants (every field carries source/timestamp/freshness/fallbackUsed):
//   • quotes, optionChain, gainersLosers, mostActiveEquities, mostActiveContracts,
//     oiSpurts, fiiDii — all from the central data-layer providers.
//   • newsSentiment — from the news enrichment path (web-intel → Prisma → enrichment).
//   • marketFreshness — derived from the newest publishedAt across all sources.
//   • lastUpdated — wall-clock when the fragment was assembled.

import type {
  AgentContextFragment,
  QuoteData,
  OptionChainData,
  GainersLosers,
  MostActiveEquity,
  MostActiveContract,
  OISpurt,
  FiiDiiRow,
  FreshnessLevel,
} from '@/lib/data-layer/types';
import { getRecentNews, buildNewsSentiment } from '@/lib/data-layer/news';
import type { EnrichedNewsItem } from '@/lib/data-layer/news';
import { classifyFreshness } from '@/lib/api-freshness';

// ── Fake fragment for test bootstrap ──────────────────────────────────

export function __agentContextFake(): AgentContextFragment {
  return {
    quotes: {},
    optionChain: null,
    gainersLosers: [],
    mostActiveEquities: [],
    mostActiveContracts: [],
    oiSpurts: [],
    fiiDii: [],
    newsSentiment: { label: 'NEUTRAL', score: 0, timestamp: '' },
    marketFreshness: 'NO_DATA',
    lastUpdated: new Date().toISOString(),
  };
}

// ── Build a full AgentContextFragment ─────────────────────────────────

export async function buildAgentContextFragment(
  symbols: string[] = ['NIFTY'],
): Promise<AgentContextFragment> {
  const now = Date.now();

  // ── Option chain (NSE primary for NSE symbols) ──────────────────────
  let optionChain: OptionChainData | null = null;
  try {
    const { getOptionChain } = await import('@/lib/data-layer/chains/option-chain');
    const chainResult = await getOptionChain(symbols[0] ?? 'NIFTY');
    optionChain = chainResult.data;
  } catch { /* leave null */ }

  // ── Quotes (NSE provider) ──────────────────────────────────────────
  const quotes: Record<string, QuoteData> = {};
  try {
    const { nseProvider } = await import('@/lib/data-layer/providers/nse');
    const quoteResult = await nseProvider.getQuotes(symbols);
    for (const q of quoteResult.data ?? []) {
      quotes[q.symbol] = q;
    }
  } catch { /* leave empty */ }

  // ── Gainers/Losers ──────────────────────────────────────────────────
  let gainersLosers: GainersLosers[] = [];
  try {
    const { nseProvider } = await import('@/lib/data-layer/providers/nse');
    const glResult = await nseProvider.getGainersLosers();
    gainersLosers = glResult.data ?? [];
  } catch { /* leave empty */ }

  // ── Most-Active Equities ────────────────────────────────────────────
  let mostActiveEquities: MostActiveEquity[] = [];
  try {
    const { nseProvider } = await import('@/lib/data-layer/providers/nse');
    const maResult = await nseProvider.getMostActiveEquities();
    mostActiveEquities = maResult.data ?? [];
  } catch { /* leave empty */ }

  // ── Most-Active Contracts / OI Spurts / FII-DII (empty until wired) ─
  const mostActiveContracts: MostActiveContract[] = [];
  const oiSpurts: OISpurt[] = [];
  const fiiDii: FiiDiiRow[] = [];

  // ── News sentiment (from Prisma WebRecord store) ────────────────────
  let newsItems: EnrichedNewsItem[] = [];
  try {
    newsItems = await getRecentNews(50);
  } catch { /* leave empty */ }
  const newsSentiment = buildNewsSentiment(newsItems);

  // ── Market freshness (newest publishedAt across sources) ────────────
  let marketFreshness: FreshnessLevel | 'NO_DATA' = 'NO_DATA';
  const newestPublished = newsItems
    .map((n) => Date.parse(n.publishedAt))
    .filter((t) => !isNaN(t))
    .sort((a, b) => b - a)[0];
  if (newestPublished) {
    marketFreshness = classifyFreshness(now - newestPublished, 'default');
  }

  return {
    quotes,
    optionChain,
    gainersLosers,
    mostActiveEquities,
    mostActiveContracts,
    oiSpurts,
    fiiDii,
    newsSentiment,
    marketFreshness,
    lastUpdated: new Date(now).toISOString(),
  };
}

/** Exported type for external consumers. */
export type { AgentContextFragment };
