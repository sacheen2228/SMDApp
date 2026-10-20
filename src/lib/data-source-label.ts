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

export function dataSourceBadge(ds: string | null | undefined): DataSourceBadge {
  if (!ds) return { label: "NO DATA", display: "NO DATA", isLive: false };
  const key = ds.toLowerCase();
  if (key === "simulation" || key === "demo") {
    return { label: "DEMO", display: "DEMO", isLive: false };
  }
  if (key === "no_data" || key === "none" || key === "unavailable") {
    return { label: "NO DATA", display: "NO DATA", isLive: false };
  }
  const live = LIVE_DISPLAY[key];
  if (live) return { label: "LIVE", display: live, isLive: true };
  // Unknown/future provider — show as-is, never a hardcoded "Yahoo"
  return { label: ds.toUpperCase(), display: ds, isLive: false };
}
