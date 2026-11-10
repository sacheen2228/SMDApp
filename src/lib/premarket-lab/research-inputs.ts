// Phase 11 research inputs — READ-ONLY external snapshots for shadow validation.
// Never mutates production trade paths. Fail-closed: missing → null + missing[].
// asOf is always the fetch timestamp — never claimed as pre-open unless collected then.

import type { ResearchInputs, DataQuality } from "./types";

export interface ResearchInputOptions {
  symbol: string;
  /** ISO — when features must be valid. Defaults to now. */
  asOf?: string;
  includeOptions?: boolean;
  includeFiiDii?: boolean;
  includeVix?: boolean;
  includeBreadth?: boolean;
  /** Injectables for offline tests — no network when provided. */
  deps?: {
    getNSEIndiaVIX?: () => Promise<{ value: number; change?: number } | null>;
    fetchFiiDiiData?: () => Promise<{
      available: boolean;
      latest?: { fiiNet: number; diiNet: number; date: string };
      history?: Array<{ date: string; fiiNet: number; diiNet: number }>;
    }>;
    getMotilalOptionChain?: (symbol: string) => Promise<any | null>;
    getBreadthData?: () => Promise<{ advances: number; declines: number; unchanged: number; total: number }>;
  };
}

function q(ok: boolean, degraded = false): DataQuality {
  if (!ok) return "MISSING";
  return degraded ? "DEGRADED" : "OK";
}

/**
 * Snapshot research inputs for shadow features.
 * Production SDM/veto/risk never import this for trade decisions.
 */
export async function collectResearchInputs(opts: ResearchInputOptions): Promise<ResearchInputs> {
  const asOf = opts.asOf || new Date().toISOString();
  const missing: string[] = [];
  const deps = opts.deps || {};

  // VIX
  let vix: ResearchInputs["vix"] = null;
  if (opts.includeVix !== false) {
    try {
      const fn = deps.getNSEIndiaVIX || (await import("@/lib/nse-api")).getNSEIndiaVIX;
      const v = await fn();
      if (v && Number.isFinite(v.value) && v.value > 0) {
        vix = { value: v.value, change: v.change ?? null, quality: "OK", source: "NSE_INDIA_VIX" };
      } else {
        missing.push("vix");
        vix = { value: null, quality: "MISSING", source: "NSE_INDIA_VIX" };
      }
    } catch {
      missing.push("vix");
      vix = { value: null, quality: "MISSING", source: "NSE_INDIA_VIX" };
    }
  }

  // FII/DII — latest published day only (publication lag respected)
  let fiiDii: ResearchInputs["fiiDii"] = null;
  if (opts.includeFiiDii !== false) {
    try {
      const fn = deps.fetchFiiDiiData || (await import("@/lib/fii-dii")).fetchFiiDiiData;
      const r = await fn();
      if (r?.available && r.latest) {
        fiiDii = {
          fiiNet: r.latest.fiiNet,
          diiNet: r.latest.diiNet,
          date: r.latest.date || null,
          available: true,
          quality: "OK",
        };
      } else {
        missing.push("fii_dii");
        fiiDii = { fiiNet: null, diiNet: null, date: null, available: false, quality: "MISSING" };
      }
    } catch {
      missing.push("fii_dii");
      fiiDii = { fiiNet: null, diiNet: null, date: null, available: false, quality: "MISSING" };
    }
  }

  // Option chain PCR / OI imbalance via the central engine
  // (Breeze → MOAPI → NSE → BSE parallel race; exchange archives only off-hours).
  let options: ResearchInputs["options"] = null;
  if (opts.includeOptions !== false) {
    try {
      const { getOptionChain } = await import("@/lib/data-layer/chains/option-chain");
      const result = await getOptionChain(opts.symbol);
      const chain = result.data;
      if (chain?.strikes?.length) {
        let ceOi = 0;
        let peOi = 0;
        for (const row of chain.strikes) {
          ceOi += row.ce?.oi || 0;
          peOi += row.pe?.oi || 0;
        }
        const pcr = ceOi > 0 ? peOi / ceOi : null;
        options = {
          symbol: opts.symbol,
          pcr: pcr != null && Number.isFinite(pcr) ? Number(pcr.toFixed(4)) : null,
          ceOi: ceOi || null,
          peOi: peOi || null,
          quality: pcr != null ? "OK" : "DEGRADED",
          source: result.source,
          asOf: chain.providerTimestamp || chain.fetchedAt || asOf,
        };
      } else {
        missing.push("options");
        options = {
          symbol: opts.symbol, pcr: null, ceOi: null, peOi: null,
          quality: "MISSING", source: result.source || "NO_DATA", asOf,
        };
      }
    } catch {
      missing.push("options");
      options = {
        symbol: opts.symbol, pcr: null, ceOi: null, peOi: null,
        quality: "MISSING", source: "NO_DATA", asOf,
      };
    }
  }

  // Breadth
  let breadth: ResearchInputs["breadth"] = null;
  if (opts.includeBreadth !== false) {
    try {
      const fn = deps.getBreadthData || (await import("@/lib/nse-stock-data")).getBreadthData;
      const b = await fn();
      if (b && b.total > 0) {
        breadth = {
          adv: b.advances, dec: b.declines, unchanged: b.unchanged,
          quality: q(true),
        };
      } else {
        missing.push("breadth");
        breadth = { adv: 0, dec: 0, unchanged: 0, quality: "MISSING" };
      }
    } catch {
      missing.push("breadth");
      breadth = { adv: 0, dec: 0, unchanged: 0, quality: "MISSING" };
    }
  }

  return { asOf, vix, fiiDii, options, breadth, missing };
}

/** Map research inputs → numeric feature keys (null when unavailable). */
export function researchFeatures(r: ResearchInputs | null): Record<string, number | null> {
  if (!r) {
    return {
      options_pcr: null, options_oi_imbalance: null, options_confirm_pct: null,
      fii_net: null, breadth_net: null, vix_level: null,
    };
  }
  const pcr = r.options?.pcr ?? null;
  const oiImb =
    r.options?.ceOi != null && r.options?.peOi != null && (r.options.ceOi + r.options.peOi) > 0
      ? (r.options.peOi - r.options.ceOi) / (r.options.ceOi + r.options.peOi)
      : null;
  // options_confirm_pct: pe heavy → bearish lean for index (puts bid) → −1..1
  const confirm = pcr != null ? Math.max(-1, Math.min(1, (pcr - 1) / 2)) : null;
  const breadthNet =
    r.breadth && r.breadth.adv + r.breadth.dec > 0
      ? (r.breadth.adv - r.breadth.dec) / (r.breadth.adv + r.breadth.dec)
      : null;
  return {
    options_pcr: pcr,
    options_oi_imbalance: oiImb,
    options_confirm_pct: confirm,
    fii_net: r.fiiDii?.available ? r.fiiDii.fiiNet : null,
    breadth_net: breadthNet,
    vix_level: r.vix?.value ?? null,
  };
}
