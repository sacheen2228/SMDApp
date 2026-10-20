"use client";

import { AlertTriangle, Clock, Radio } from "lucide-react";

/**
 * The provenance badge every dashboard card shows next to its numbers:
 * WHERE the data came from, HOW OLD it is, and whether it is available at
 * all. A card that cannot say this is not allowed to show a number.
 */
export interface FreshnessMeta {
  status?: "AVAILABLE" | "STALE" | "UNAVAILABLE";
  source?: string;
  sourceLabel?: string;
  providerTimestamp?: string | null;
  collectedAt?: string;
  ageMs?: number | null;
  ageLabel?: string;
  stale?: boolean;
  reason?: string;
}

function ageText(meta: FreshnessMeta): string {
  if (meta.ageLabel && meta.ageLabel !== "unknown" && meta.ageLabel !== "unavailable") {
    return meta.ageLabel;
  }
  if (meta.ageMs == null) return "age unknown";
  const s = Math.floor(meta.ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DataFreshnessBadge({
  meta,
  className = "",
  showReason = false,
}: {
  meta?: FreshnessMeta | null;
  className?: string;
  showReason?: boolean;
}) {
  if (!meta) return null;
  const unavailable = meta.status === "UNAVAILABLE";
  const stale = meta.stale || meta.status === "STALE";
  const label = unavailable ? "NO DATA" : stale ? "STALE" : "LIVE";
  const source = meta.sourceLabel || meta.source || "unknown source";
  const Icon = unavailable ? AlertTriangle : stale ? Clock : Radio;
  const tone = unavailable
    ? "bg-red-500/15 text-red-300 border-red-500/30"
    : stale
    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
    : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${tone} ${className}`}
      title={
        showReason && meta.reason
          ? meta.reason
          : `${source}${meta.providerTimestamp ? ` · data as of ${meta.providerTimestamp}` : ""}`
      }
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
      <span className="opacity-70">· {source}</span>
      <span className="opacity-70">· {ageText(meta)}</span>
    </span>
  );
}

/**
 * The explicit "no data" panel. Shown INSTEAD of a card body when the feed
 * failed — never a zero, never a plausible-looking number.
 */
export function UnavailableCard({
  title,
  reason,
  meta,
  className = "",
}: {
  title: string;
  reason?: string | null;
  meta?: FreshnessMeta | null;
  className?: string;
}) {
  return (
    <div className={`rounded border border-red-500/25 bg-red-500/5 p-3 ${className}`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold text-red-300">
        <AlertTriangle className="h-3 w-3" />
        {title} — unavailable
      </div>
      <p className="mt-1 text-[10px] text-zinc-400">
        {reason || meta?.reason || "The data feed did not answer. No value is shown because no real value exists."}
      </p>
      {meta?.providerTimestamp ? (
        <p className="mt-1 text-[9px] text-zinc-500">
          Last data from {meta.sourceLabel || meta.source}: {meta.providerTimestamp}
        </p>
      ) : null}
    </div>
  );
}

/** Compact "N of M" coverage line (real coverage, never a guess). */
export function CoverageNote({
  coverage,
  className = "",
}: {
  coverage?: { quotes?: number; technicals?: number; requested?: number; complete?: boolean } | null;
  className?: string;
}) {
  if (!coverage || !coverage.requested) return null;
  const covered = coverage.technicals ?? coverage.quotes ?? 0;
  return (
    <span className={`text-[9px] text-zinc-500 ${className}`}>
      {covered}/{coverage.requested} symbols with real data
      {coverage.complete === false ? " (partial)" : ""}
    </span>
  );
}
