// SignalExplanationPanel — "why CE / why PE / why WAIT" explainer embedded
// as Row 3 of the Terminal Overview tab (TheTradeCartel equivalent).
//
// Read-only. Two sources, no new formulas:
//   1. Current signal — the live recommendation already fetched by the
//      terminal (`rec`: whyThisTrade bullets + qualityScore factors from
//      /api/sdm-signal). Passed in, never refetched.
//   2. Gate history — GET /api/signal-explain over the persisted
//      candidate_log (verdict, tier, warnings, fails, layer states), plus
//      the GATE_CONFIG thresholds returned by that route so the reader can
//      see WHY a row was WAIT/SKIP.
//
// Handles rec = null (WAIT / no signal) gracefully — that is a first-class
// answer here, not an error.

"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ShieldCheck, AlertTriangle, Clock } from "lucide-react";

interface QualityFactor {
  name: string;
  score: number;
  weight: number;
  weightedScore?: number;
  detail?: string;
  source?: string;
  direction?: string;
}

interface QualityScore {
  overall?: number;
  grade?: string;
  factors?: QualityFactor[];
  status?: string;
}

export interface SignalRec {
  action: string;
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  bias: string;
  rr: number;
  reason: string;
  confidence: number;
  whyThisTrade?: any[];
  qualityScore?: QualityScore | null;
}

interface ExplainRow {
  ts: string | null;
  source: string | null;
  direction: string | null;
  strike: number | null;
  confidence: number | null;
  calibratedConfidence: number | null;
  rr: number | null;
  regime: string | null;
  sessionWindow: string | null;
  gateVerdict: string | null;
  tier: string | null;
  warnings: string[];
  fails: string[];
  layerStates: Record<string, string> | null;
  sent: boolean;
  wouldBlock: boolean;
  simOutcomeR: number | null;
}

const verdictColor = (v: string | null): string => {
  if (v === "TRADE" || v === "PASS") return "text-[#2dd4a7]";
  if (v === "WAIT" || v === "WARN") return "text-[#e8a33d]";
  if (v === "SKIP" || v === "BLOCK") return "text-[#f2495c]";
  return "text-[#7d8ba0]";
};

const fmtTs = (ts: string | null): string => {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
};

const layerLabel: Record<string, string> = {
  flow: "Flow",
  structure: "Structure",
  oi: "OI",
  greeksVix: "Greeks/VIX",
  freshness: "Freshness",
};

export default function SignalExplanationPanel({
  symbol,
  rec,
}: {
  symbol: string;
  rec: SignalRec | null;
}) {
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["signal-explain", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/signal-explain?symbol=${encodeURIComponent(symbol)}&limit=12`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`signal-explain ${res.status}`);
      return res.json();
    },
    refetchInterval: 90_000,
    staleTime: 60_000,
    retry: false,
  });

  const rows: ExplainRow[] = Array.isArray(data?.candidates) ? data.candidates : [];
  const cfg = data?.gateConfig ?? null;

  const factors: QualityFactor[] =
    Array.isArray(rec?.qualityScore?.factors) && rec!.qualityScore!.factors!.length > 0
      ? rec!.qualityScore!.factors!
          .filter((f) => f && typeof f.score === "number")
          .slice()
          .sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0))
      : [];
  const why: any[] = Array.isArray(rec?.whyThisTrade) ? rec!.whyThisTrade! : [];

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden mt-3.5">
      <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={13} className="text-[#4f8ff7]" />
          Signal Explanation — why {rec ? rec.type : "WAIT"}
        </span>
        <span className="text-[#7d8ba0] font-mono text-[11px]">
          {symbol} · read-only
        </span>
      </div>

      <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {/* ── Left: current signal ── */}
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-[#7d8ba0] font-bold mb-2">
            Current recommendation
          </div>

          {!rec ? (
            <div className="text-[12.5px] text-[#e8a33d] flex items-start gap-1.5 py-1">
              <Clock size={13} className="mt-0.5 shrink-0" />
              <div>
                <b>WAIT</b> — no trade recommendation for {symbol} right now.
                <div className="text-[#7d8ba0] text-[11px] mt-0.5">
                  The engine returned no qualifying CE/PE setup (direction/strike
                  missing or gate held it back).
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                    rec.type === "CE"
                      ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]"
                      : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"
                  }`}
                >
                  BUY {rec.type} {rec.strike}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10.5px] bg-[#1f2733] text-[#7d8ba0] font-mono">
                  conf {rec.confidence}%
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10.5px] bg-[#1f2733] text-[#4f8ff7] font-mono">
                  R:R 1:{rec.rr}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10.5px] bg-[#1f2733] text-[#7d8ba0] font-mono">
                  bias {rec.bias}
                </span>
              </div>

              {why.length > 0 && (
                <ul className="mb-2.5 space-y-1">
                  {why.slice(0, 6).map((w: any, i: number) => (
                    <li key={i} className="text-[11.5px] text-[#c8d0dc] flex gap-1.5">
                      <span className="text-[#2dd4a7]">▸</span>
                      <span>{typeof w === "string" ? w : w?.text ?? JSON.stringify(w)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {why.length === 0 && rec.reason && (
                <div className="text-[11.5px] text-[#c8d0dc] mb-2.5">{rec.reason}</div>
              )}

              {factors.length > 0 && (
                <div className="mt-1">
                  <div className="text-[10.5px] uppercase tracking-wide text-[#7d8ba0] font-bold mb-1.5">
                    Quality score — top contributing factors
                    {rec.qualityScore?.overall != null && (
                      <span className="text-[#4f8ff7] ml-1 normal-case">
                        ({rec.qualityScore.overall}
                        {rec.qualityScore.grade ? ` · ${rec.qualityScore.grade}` : ""})
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {factors.slice(0, 7).map((f, i) => {
                      const pct = Math.max(0, Math.min(100, Math.round(f.score)));
                      const contrib = f.weightedScore ?? f.score * (f.weight ?? 0);
                      return (
                        <div key={`${f.name}-${i}`} className="flex items-center gap-2">
                          <span className="text-[10.5px] text-[#7d8ba0] w-[130px] shrink-0 truncate" title={f.detail || f.name}>
                            {f.name}
                          </span>
                          <div className="flex-1 h-[6px] bg-[#1f2733] rounded overflow-hidden">
                            <div
                              className={`h-full rounded ${
                                pct >= 70 ? "bg-[#2dd4a7]" : pct >= 40 ? "bg-[#e8a33d]" : "bg-[#f2495c]"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-mono text-[#c8d0dc] w-[64px] text-right shrink-0">
                            {f.score}/100 · {contrib >= 0 ? "+" : ""}
                            {contrib.toFixed(1)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {factors.length === 0 && (
                <div className="text-[11px] text-[#7d8ba0]">
                  No quality-score factors returned with this signal.
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right: gate history ── */}
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-[#7d8ba0] font-bold mb-2 flex items-center justify-between">
            <span>Gate history — candidate_log</span>
            <span className="normal-case font-normal text-[10px]">
              TRADE only after all gates pass
            </span>
          </div>

          {isLoading ? (
            <div className="text-[#7d8ba0] text-[11.5px] py-3">Loading gate history…</div>
          ) : error ? (
            <div className="text-[#e8a33d] text-[11.5px] py-3 flex gap-1.5 items-start">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>Gate history unavailable — {String((error as any)?.message || error)}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-[#7d8ba0] text-[11.5px] py-3">
              No candidates logged for {symbol} yet — the veto/gate writes a row per
              evaluated signal, so history appears once signals are generated.
            </div>
          ) : (
            <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="text-[#7d8ba0] text-[10px] uppercase">
                    <th className="text-left py-1 px-1">Time</th>
                    <th className="text-left py-1 px-1">Side</th>
                    <th className="text-right py-1 px-1">Conf</th>
                    <th className="text-right py-1 px-1">R:R</th>
                    <th className="text-left py-1 px-1">Verdict</th>
                    <th className="text-left py-1 px-1">Tier</th>
                    <th className="text-left py-1 px-1">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.ts}-${i}`} className="border-t border-[#1f2733] align-top">
                      <td className="py-1.5 px-1 text-[#7d8ba0]">{fmtTs(r.ts)}</td>
                      <td className="py-1.5 px-1">
                        {r.direction ? (
                          <span
                            className={`font-bold ${
                              /call|ce|buy_call/i.test(r.direction)
                                ? "text-[#1fbf75]"
                                : /put|pe|buy_put/i.test(r.direction)
                                ? "text-[#f2495c]"
                                : "text-[#e8a33d]"
                            }`}
                          >
                            {r.direction.toUpperCase()}
                          </span>
                        ) : (
                          <span className="text-[#e8a33d]">WAIT</span>
                        )}
                        {r.strike != null && (
                          <span className="text-[#7d8ba0] ml-1">{r.strike}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-1 text-right">
                        {r.confidence ?? "—"}
                        {r.calibratedConfidence != null && (
                          <span className="text-[#7d8ba0]">/{r.calibratedConfidence}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-1 text-right text-[#4f8ff7]">
                        {r.rr != null ? `1:${r.rr}` : "—"}
                      </td>
                      <td className={`py-1.5 px-1 font-bold ${verdictColor(r.gateVerdict)}`}>
                        {r.gateVerdict || "—"}
                        {r.sent && <span className="text-[#7d8ba0] ml-1">↗</span>}
                        {r.wouldBlock && (
                          <span className="text-[#f2495c] ml-1" title="shadow veto would have blocked">
                            ✕
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-1">
                        <span
                          className={`px-1 rounded ${
                            r.tier === "A"
                              ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]"
                              : r.tier === "B"
                              ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]"
                              : r.tier === "C"
                              ? "bg-[rgba(232,163,61,.15)] text-[#e8a33d]"
                              : "text-[#7d8ba0]"
                          }`}
                        >
                          {r.tier || "—"}
                        </span>
                      </td>
                      <td className="py-1.5 px-1 text-[10px]">
                        {r.fails.length > 0 && (
                          <div className="text-[#f2495c]" title={r.fails.join(" · ")}>
                            fail: {r.fails[0]}
                            {r.fails.length > 1 ? ` +${r.fails.length - 1}` : ""}
                          </div>
                        )}
                        {r.warnings.length > 0 && (
                          <div className="text-[#e8a33d]" title={r.warnings.join(" · ")}>
                            warn: {r.warnings[0]}
                            {r.warnings.length > 1 ? ` +${r.warnings.length - 1}` : ""}
                          </div>
                        )}
                        {r.fails.length === 0 && r.warnings.length === 0 && (
                          <span className="text-[#7d8ba0]">—</span>
                        )}
                        {r.layerStates && (
                          <div className="flex gap-0.5 mt-0.5 flex-wrap">
                            {Object.entries(r.layerStates).map(([k, v]) => (
                              <span
                                key={k}
                                title={`${layerLabel[k] || k}: ${v}`}
                                className={`px-1 rounded text-[9px] ${
                                  v === "agree"
                                    ? "bg-[rgba(31,191,117,.15)] text-[#1fbf75]"
                                    : v === "disagree"
                                    ? "bg-[rgba(242,73,92,.15)] text-[#f2495c]"
                                    : "bg-[#1f2733] text-[#7d8ba0]"
                                }`}
                              >
                                {(layerLabel[k] || k).slice(0, 5)}:{v === "agree" ? "✓" : v === "disagree" ? "✕" : "?"}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cfg && (
            <div className="mt-2 pt-2 border-t border-[#1f2733] text-[10px] text-[#7d8ba0] font-mono flex flex-wrap gap-x-3 gap-y-1">
              <span className="flex items-center gap-1">
                <Activity size={10} className="text-[#4f8ff7]" /> gate thresholds:
              </span>
              <span>conf ≥ {cfg.minConfidence}</span>
              <span>option R:R ≥ 1:{cfg.minOptionRR}</span>
              <span>|Δ| ≥ {cfg.minAbsDelta}</span>
              <span>≤ {cfg.maxOtmSteps} OTM steps</span>
              <span>budget ₹{cfg.tradeBudget}</span>
              <span>freshness ≤ {cfg.freshnessMaxMin}min</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
