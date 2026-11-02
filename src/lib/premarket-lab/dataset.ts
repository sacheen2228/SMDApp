// Build labeled feature datasets from stored study days (post-session labeling).
// Features use asOf = capture/pre-open time; labels use day open/close — no leakage.

import { listStudyDays, saveFeatures, getLabDb } from "./storage";
import { buildFeatures, labelOutcomes, FEATURE_CALC_VERSION } from "./features";
import type { LabeledSample, FeatureRow } from "./types";

export interface BuildDatasetOptions {
  from?: string;
  to?: string;
  symbol?: string;
  /** Only rebuild when open data present (labels need open/close). */
  requireOpen?: boolean;
  persist?: boolean;
}

/**
 * Rebuild feature rows for all study days with open prints.
 * Returns samples ready for train/validation.
 */
export function buildFeatureDataset(opts: BuildDatasetOptions = {}): {
  features: FeatureRow[];
  samples: LabeledSample[];
  skippedNoOpen: number;
} {
  const days = listStudyDays({
    from: opts.from,
    to: opts.to,
    symbol: opts.symbol,
    limit: 5000,
  });

  const features: FeatureRow[] = [];
  const samples: LabeledSample[] = [];
  let skippedNoOpen = 0;

  for (const day of days) {
    if (opts.requireOpen !== false && !day.open?.spotOpen && !day.open?.futuresOpen) {
      skippedNoOpen++;
      continue;
    }
    const asOf = day.provenance?.fetchedAt || `${day.tradeDate}T09:10:00+05:30`;
    const row = buildFeatures({ day, asOf });
    features.push(row);
    if (opts.persist) saveFeatures(row);

    const labels = labelOutcomes(day);
    for (const [target, label] of Object.entries(labels)) {
      if (label == null) continue;
      samples.push({
        tradeDate: day.tradeDate,
        symbol: day.symbol,
        features: row.features,
        target,
        label: label as 0 | 1,
      });
      if (opts.persist) {
        saveFeatures({
          ...row,
          // stash target/label via extended save — storage accepts optional fields
          ...({ target, label } as any),
        });
      }
    }
  }

  return { features, samples, skippedNoOpen };
}

/** In-memory samples without persistence (tests / ad-hoc). */
export function samplesFromStudyDays(days = listStudyDays({ limit: 5000 })): LabeledSample[] {
  const out: LabeledSample[] = [];
  for (const day of days) {
    if (!day.open?.spotOpen && !day.open?.futuresOpen) continue;
    const row = buildFeatures({
      day,
      asOf: day.provenance?.fetchedAt || `${day.tradeDate}T09:10:00+05:30`,
    });
    const labels = labelOutcomes(day);
    for (const [target, label] of Object.entries(labels)) {
      if (label == null) continue;
      out.push({
        tradeDate: day.tradeDate,
        symbol: day.symbol,
        features: row.features,
        target,
        label: label as 0 | 1,
      });
    }
  }
  return out;
}

export function countLabeledByTarget(): Record<string, number> {
  const db = getLabDb();
  const rows = db.prepare("SELECT target, COUNT(*) n FROM premarket_features WHERE target IS NOT NULL AND label IS NOT NULL GROUP BY target").all() as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.target] = r.n;
  return out;
}

export { FEATURE_CALC_VERSION };
