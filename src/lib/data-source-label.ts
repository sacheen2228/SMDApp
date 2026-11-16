// Data-source badge/label mapping for the dashboard.
// The old inline ternary in page.tsx mapped EVERY non-Breeze/non-simulation
// source to the word "Yahoo" — wrong since the chain went NSE-primary
// (2026-10-19 user report). Yahoo is never a data source (SOP §1); live
// exchange/broker feeds all show LIVE with a friendly provider name.

export interface DataSourceBadge {
  /** Short badge text: LIVE / DEMO / NO DATA */
  label: string;
  /** Friendly provider name for the Simple Mode "Data" row */
  display: string;
  isLive: boolean;
}

/**
 * Provider display names. A provider name is NOT a freshness claim — the
 * exchange-aware freshness label (LIVE | FRESH | DELAYED | STALE |
 * UNAVAILABLE) decides whether the data is actually live.
 */
const LIVE_DISPLAY: Record<string, string> = {
  "nse-api": "NSE",
  nse: "NSE",
  "bse-api": "BSE",
  bse: "BSE",
  "motilal-api": "MO",
  mo: "MO",
  motilal: "MO",
  "icici-breeze": "Breeze",
  breeze: "Breeze",
};

/**
 * Build the badge for a provider + the exchange-aware freshness label.
 *
 * Without a freshness label (older payloads / offline callers) the provider
 * name is still shown, but the badge never claims LIVE on its own — a real
 * provider can serve a closed-market snapshot.
 */
export function dataSourceBadge(
  ds: string | null | undefined,
  freshness?: string | null,
): DataSourceBadge {
  if (!ds) return { label: "NO DATA", display: "NO DATA", isLive: false };
  const key = ds.toLowerCase();
  if (key === "simulation" || key === "demo") {
    return { label: "DEMO", display: "DEMO", isLive: false };
  }
  if (key === "no_data" || key === "none" || key === "unavailable") {
    return { label: "NO DATA", display: "NO DATA", isLive: false };
  }
  // Daily FII/DII feed — a real source, but T-1 by construction, never "LIVE".
  if (key === "fii-dii") {
    return { label: "FII/DII", display: "FII/DII", isLive: false };
  }
  const provider = LIVE_DISPLAY[key] ?? ds;
  if (freshness) {
    const f = freshness.toUpperCase();
    return {
      label: f,
      display: f === "LIVE" ? provider : `${provider} · ${f}`,
      isLive: f === "LIVE",
    };
  }
  // Unknown/future provider — show as-is, never a hardcoded "Yahoo".
  // No freshness → the provider name only; claiming LIVE would be a guess.
  return { label: provider.toUpperCase(), display: provider, isLive: false };
}
