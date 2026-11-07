// TrackRecordPanel — cost & honesty panel embedded in the EXISTING Backtest
// tab (TheTradeCartel "Track Record" equivalent: what actually got recorded,
// after costs, with what is NOT claimed).
//
// Read-only. Two inputs:
//   1. `stats` (AggregateStats) — passed from the parent's 5s poll. Every
//      figure here is the sidecar's own ledger aggregate (net of fees).
//   2. A one-shot walk of closed trades to sum `fees` (stats has no fee
//      field). Refetched only when the closed-trade count changes, never on
//      the 5s tick.
//
// Honesty rules (non-negotiable):
//   - Gross = net + fees; fees are shown, never hidden.
//   - If the fee walk is truncated (pageSize cap), the panel says so.
//   - Replay P&L below is PROVISIONAL (known points-vs-rupees issue) — stated.
//   - No walk-forward / out-of-sample claim — these are recorded trades.

"use client";

import { useEffect, useState } from "react";
import { Receipt, Info, ShieldAlert } from "lucide-react";
import {
  AggregateStats,
  TradeRecord,
  getTrades,
  TRADE_AUDIT_BASE,
} from "@/lib/trade-audit-client";

export interface CostInput {
  status?: string | null;
  fees?: number | null;
  netPnl?: number | null;
}

export interface CostSummary {
  closedCount: number;
  totalFees: number;
  netPnl: number;
  grossPnl: number;
  costDragPct: number;
  complete: boolean;
}

/**
 * Sum fees / net over a trade list. Pure — tested in tests/track-record.test.ts.
 * Only rows with status !== "open" count; missing numbers are 0, never NaN.
 * `total` (optional) = full closed-trade count so callers can flag truncation.
 */
export function costSummary(
  trades: CostInput[],
  opts?: { total?: number }
): CostSummary {
  const closed = (Array.isArray(trades) ? trades : []).filter(
    (t) => t && t.status !== "open"
  );
  const totalFees = closed.reduce((s, t) => s + (Number(t.fees) || 0), 0);
  const netPnl = closed.reduce((s, t) => s + (Number(t.netPnl) || 0), 0);
  const grossPnl = netPnl + totalFees;
  const denom = Math.abs(grossPnl);
  const costDragPct = denom > 0 ? (totalFees / denom) * 100 : 0;
  const total = opts?.total;
  return {
    closedCount: closed.length,
    totalFees,
    netPnl,
    grossPnl,
    costDragPct,
    complete: total === undefined ? true : closed.length >= total,
  };
}

const rupee = (n: number | null | undefined, d = 0) =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d })}`;

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(d);

/** Walk closed trades (pageSize 500, ≤4 pages) and return the cost summary. */
async function fetchCosts(): Promise<{
  summary: CostSummary | null;
  error: string | null;
}> {
  try {
    const pageSize = 500;
    const maxPages = 4;
    const all: TradeRecord[] = [];
    let total = 0;
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(
        `${TRADE_AUDIT_BASE}/api/trades?status=closed&pageSize=${pageSize}&page=${page}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) throw new Error(`trades ${res.status}`);
      const json = await res.json();
      const items: TradeRecord[] = Array.isArray(json?.items) ? json.items : [];
      all.push(...items);
      total = typeof json?.total === "number" ? json.total : all.length;
      if (all.length >= total || items.length === 0) break;
    }
    return { summary: costSummary(all, { total }), error: null };
  } catch (e: any) {
    return { summary: null, error: e?.message || "cost walk failed" };
  }
}

function Card({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {hint && (
          <span className="text-[9px] text-muted-foreground" title={hint}>
            <Info size={10} />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1 border-b border-[#2a2e39]/60 last:border-0">
      <span className="text-[10px] text-muted-foreground">{k}</span>
      <span className={`font-mono text-[11px] font-bold ${color ?? "text-white"}`}>{v}</span>
    </div>
  );
}

export default function TrackRecordPanel({
  stats,
  connected,
}: {
  stats: AggregateStats;
  connected: boolean;
}) {
  // `key` ties the cached walk to the closed-trade count it reflects; a
  // mismatch renders as "loading" without any synchronous setState in the
  // effect (react-hooks set-state-in-effect).
  const [costs, setCosts] = useState<{
    summary: CostSummary | null;
    error: string | null;
    key: string;
  } | null>(null);
  const closedTrades = stats?.closedTrades ?? 0;
  const wantKey = connected && closedTrades > 0 ? String(closedTrades) : null;
  const costsLoading = wantKey !== null && costs?.key !== wantKey;

  // Walk fees only when the closed-trade count moves (not on the 5s tick).
  useEffect(() => {
    if (wantKey === null) return;
    let alive = true;
    (async () => {
      const r = await fetchCosts();
      if (alive) setCosts({ ...r, key: wantKey });
    })();
    return () => {
      alive = false;
    };
  }, [wantKey]);

  const fresh = wantKey !== null && costs?.key === wantKey ? costs : null;
  const c = fresh?.summary ?? null;
  const costsError = fresh?.error ?? null;
  const net = stats?.netPnl ?? 0;
  const gross = c ? c.grossPnl : null;
  const costDrag =
    c && Math.abs(c.grossPnl) > 0
      ? (c.totalFees / Math.abs(c.grossPnl)) * 100
      : null;

  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Receipt className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[12px] font-bold">Track Record — costs &amp; what is (not) claimed</span>
        <span
          className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
            connected ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
          }`}
        >
          {connected ? "ledger live" : "disconnected"}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* ── Costs ── */}
        <Card
          title="Costs (brokerage + charges)"
          hint="Fees recorded per trade by the audit engine; gross = net + fees"
        >
          {!connected ? (
            <div className="text-[10px] text-muted-foreground py-3 text-center">
              Engine offline — start with{" "}
              <code className="bg-[#2a2e39] px-1 rounded">cd trade-audit &amp;&amp; ./start.sh</code>
            </div>
          ) : closedTrades <= 0 ? (
            <div className="text-[10px] text-muted-foreground py-3 text-center">
              No closed trades yet — costs appear once trades close.
            </div>
          ) : costsLoading && !c ? (
            <div className="text-[10px] text-muted-foreground py-3 text-center animate-pulse">
              Walking closed trades for fees…
            </div>
          ) : c ? (
            <>
              <KV
                k={`Total fees (${c.closedCount} closed${c.complete ? "" : ` of ${closedTrades}`})`}
                v={rupee(c.totalFees)}
                color="text-amber-400"
              />
              <KV
                k="Gross P&L (before costs)"
                v={rupee(gross)}
                color={(gross ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}
              />
              <KV
                k="Net P&L (after costs)"
                v={rupee(net)}
                color={net >= 0 ? "text-emerald-400" : "text-red-400"}
              />
              <KV
                k="Cost drag (fees ÷ |gross|)"
                v={costDrag === null ? "—" : `${fmt(costDrag, 1)}%`}
                color="text-amber-400"
              />
              {!c.complete && (
                <div className="text-[9px] text-amber-400/90 mt-1.5 leading-snug">
                  Fee sum covers first {c.closedCount} of {closedTrades} closed trades (walk capped) —
                  totals slightly understated.
                </div>
              )}
              {costsError && (
                <div className="text-[9px] text-red-400 mt-1.5">{costsError}</div>
              )}
            </>
          ) : (
            <div className="text-[10px] text-muted-foreground py-3 text-center">
              Fee walk unavailable.
              {costsError && (
                <div className="text-[9px] text-red-400 mt-1">{costsError}</div>
              )}
            </div>
          )}
          <div className="text-[9px] text-muted-foreground mt-2 leading-snug">
            Fee model: ~₹40 flat + ~1.5 bps of round-trip turnover per trade (estimate from{" "}
            <code className="bg-[#2a2e39] px-0.5 rounded">sizing.ts</code>). Exact per-trade{" "}
            <code className="bg-[#2a2e39] px-0.5 rounded">fees</code> column is the source of truth.
          </div>
        </Card>

        {/* ── Quality ── */}
        <Card title="Ledger quality (recorded trades)">
          <KV
            k="Expectancy / trade"
            v={`${(stats.expectancy ?? 0) >= 0 ? "+" : ""}${fmt(stats.expectancy, 2)}R`}
            color={(stats.expectancy ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <KV
            k="Win rate"
            v={`${fmt(stats.winRate, 1)}%  (${stats.wins}W / ${stats.losses}L)`}
            color={(stats.winRate ?? 0) >= 50 ? "text-emerald-400" : "text-amber-400"}
          />
          <KV
            k="Profit factor"
            v={stats.profitFactor === null ? "—" : fmt(stats.profitFactor, 2)}
            color={(stats.profitFactor ?? 0) >= 1 ? "text-emerald-400" : "text-red-400"}
          />
          <KV
            k="Best strategy"
            v={
              stats.bestStrategy
                ? `${stats.bestStrategy.strategyId} ${rupee(stats.bestStrategy.netPnl)}`
                : "—"
            }
            color="text-emerald-400"
          />
          <KV
            k="Worst strategy"
            v={
              stats.worstStrategy
                ? `${stats.worstStrategy.strategyId} ${rupee(stats.worstStrategy.netPnl)}`
                : "—"
            }
            color="text-red-400"
          />
        </Card>

        {/* ── Honesty notes ── */}
        <Card title="Honesty notes">
          <ul className="space-y-1.5">
            {[
              `All P&L figures are NET of recorded fees — the ledger's netPnl column, never a gross number dressed up.`,
              `Replay tab P&L is PROVISIONAL: a known points-vs-rupees conversion issue is pending a fix; trust the recorded ledger here, not the replay delta.`,
              `These are RECORDED strategy signals, not walk-forward or out-of-sample results — no statistical edge claim is made from this panel.`,
              `Empty = empty: no trades closed yet shows zeros/—, never an optimistic default.`,
            ].map((n, i) => (
              <li key={i} className="flex gap-1.5 text-[10px] text-muted-foreground leading-snug">
                <ShieldAlert className="h-3 w-3 shrink-0 text-amber-400/80 mt-0.5" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
