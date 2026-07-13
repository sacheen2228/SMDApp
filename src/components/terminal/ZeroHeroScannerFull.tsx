// DEPRECATED: duplicate of the production Zero Hero path
// (ZeroHeroTerminal.tsx -> zhCandidates -> FullZeroHero -> Trade Audit).
// Kept on disk until production consolidation is verified.

// Zero Hero Scanner — Full
// Runs the complete Zero Hero AI Engine across every near-ATM strike and
// ranks candidates by combined engine confidence.

import { useState, useEffect, Fragment } from "react";

interface ScanCandidate {
  rank: number;
  strike: number;
  type: "CE" | "PE";
  premium: number;
  greeks: any;
  gamma_theta: any;
  probability: any;
  position_size: any;
  entry_tp_sl: any;
  execution: any;
  signal: string;
  confidence: number;
  reason: string;
}

interface ScanResult {
  instrument: string;
  spot: number;
  expiry: any;
  vix: number;
  atr: number;
  iv: number;
  candidates: ScanCandidate[];
  scanned: number;
}

const fmt = (n: number, d = 2) =>
  n == null || isNaN(n) ? "0" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

function Stars({ conf }: { conf: number }) {
  const n = conf >= 80 ? 5 : conf >= 65 ? 4 : conf >= 50 ? 3 : conf >= 35 ? 2 : 1;
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < n ? "text-[#e8a33d]" : "text-[#3a4252]"}>★</span>
      ))}
    </span>
  );
}

function signalColor(s: string) {
  if (s === "BUY_CALL") return "#1fbf75";
  if (s === "BUY_PUT") return "#4f8ff7";
  return "#7d8ba0";
}

export function ZeroHeroScannerFull({ symbol }: { symbol: string }) {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function runScan() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/zero-hero?action=scan&symbol=${symbol}`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        setData(null);
      } else {
        setData(json);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  return (
    <div className="space-y-3">
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center justify-between">
          <span>🎯 Zero Hero Scanner — Full</span>
          <button
            onClick={runScan}
            disabled={loading}
            className="px-3 py-1 rounded-[7px] bg-[#e8a33d] text-[#1a1206] font-bold text-[11px] disabled:opacity-50"
          >
            {loading ? "Scanning…" : "↻ Re-Scan"}
          </button>
        </div>

        {data && (
          <div className="px-3 py-2 flex items-center gap-4 text-[11px] text-[#7d8ba0] font-mono flex-wrap">
            <span>Spot <b className="text-[#e8a33d]">{fmt(data.spot)}</b></span>
            <span>VIX <b className="text-[#e6edf6]">{fmt(data.vix)}</b></span>
            <span>IV <b className="text-[#e6edf6]">{fmt(data.iv)}</b></span>
            <span>Scanned <b className="text-[#e6edf6]">{data.scanned}</b></span>
            {data.expiry && (
              <span>Expiry <b className="text-[#4f8ff7]">{data.expiry.expiry_date}</b> ({data.expiry.expiry_type})</span>
            )}
          </div>
        )}

        {error && (
          <div className="p-4 text-center text-[#f2495c] text-[12px]">{error}</div>
        )}

        {!error && data && data.candidates.length === 0 && (
          <div className="p-4 text-center text-[#7d8ba0] text-[12px]">No candidates cleared the engine</div>
        )}

        {!error && data && data.candidates.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead>
                <tr>
                  {["#", "Strike", "Type", "Premium", "Conf", "Signal", "γ-θ", "Δ", "Γ", "Θ", "P(ITM)", "R:R", "Stars"].map((h) => (
                    <th key={h} className="text-[#7d8ba0] font-semibold py-1.5 px-1.5 text-[10px] uppercase text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <Fragment key={`${c.strike}-${c.type}`}>
                    <tr
                      onClick={() => setExpanded(expanded === c.rank ? null : c.rank)}
                      className="border-b border-[#1f2733] hover:bg-[#151b25] cursor-pointer"
                    >
                      <td className="text-right py-1.5 px-1.5 text-[#7d8ba0]">{c.rank}</td>
                      <td className="text-right py-1.5 px-1.5 font-bold text-[#e8a33d]">{fmt(c.strike, 0)}</td>
                      <td className="text-right py-1.5 px-1.5">
                        <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${c.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]"}`}>{c.type}</span>
                      </td>
                      <td className="text-right py-1.5 px-1.5 text-[#1fbf75]">₹{fmt(c.premium)}</td>
                      <td className="text-right py-1.5 px-1.5 font-bold" style={{ color: signalColor(c.signal) }}>{c.confidence}</td>
                      <td className="text-right py-1.5 px-1.5 font-bold" style={{ color: signalColor(c.signal) }}>{c.signal.replace("BUY_", "")}</td>
                      <td className="text-right py-1.5 px-1.5">{c.gamma_theta?.score}</td>
                      <td className="text-right py-1.5 px-1.5">{fmt(c.greeks?.delta || 0)}</td>
                      <td className="text-right py-1.5 px-1.5">{fmt(c.greeks?.gamma || 0, 4)}</td>
                      <td className="text-right py-1.5 px-1.5">{fmt(c.greeks?.theta || 0)}</td>
                      <td className="text-right py-1.5 px-1.5">{fmt((c.probability?.prob_itm || 0) * 100, 1)}%</td>
                      <td className="text-right py-1.5 px-1.5">{fmt(c.entry_tp_sl?.riskReward || 0)}</td>
                      <td className="text-right py-1.5 px-1.5"><Stars conf={c.confidence} /></td>
                    </tr>
                    {expanded === c.rank && (
                      <tr className="border-b border-[#1f2733] bg-[#0a1018]">
                        <td colSpan={13} className="p-3 text-[11px]">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="bg-[#10151d] rounded p-2">
                              <div className="text-[#7d8ba0] mb-1">Greeks</div>
                              <div>Δ {fmt(c.greeks?.delta)} · Γ {fmt(c.greeks?.gamma, 4)} · Θ {fmt(c.greeks?.theta)} · Vega {fmt(c.greeks?.vega)}</div>
                            </div>
                            <div className="bg-[#10151d] rounded p-2">
                              <div className="text-[#7d8ba0] mb-1">Gamma-Theta</div>
                              <div>score {c.gamma_theta?.score} · verdict {c.gamma_theta?.verdict}</div>
                            </div>
                            <div className="bg-[#10151d] rounded p-2">
                              <div className="text-[#7d8ba0] mb-1">Probability</div>
                              <div>P(ITM) {fmt((c.probability?.prob_itm || 0) * 100, 1)}% · P(Profit) {fmt((c.probability?.prob_profit || 0) * 100, 1)}% · BE {fmt(c.probability?.breakeven, 0)}</div>
                            </div>
                            <div className="bg-[#10151d] rounded p-2">
                              <div className="text-[#7d8ba0] mb-1">Position</div>
                              <div>Lots {c.position_size?.recommendedLots} · MaxLoss ₹{fmt(c.position_size?.maxLossAmount, 0)} · R:R {fmt(c.position_size?.riskRewardRatio)}</div>
                            </div>
                            <div className="bg-[#10151d] rounded p-2 col-span-2">
                              <div className="text-[#7d8ba0] mb-1">Entry / TP / SL</div>
                              <div>Entry ₹{fmt(c.entry_tp_sl?.entry)} · Target ₹{fmt(c.entry_tp_sl?.target)} · SL ₹{fmt(c.entry_tp_sl?.stopLoss)} · {c.entry_tp_sl?.strategy}</div>
                            </div>
                            <div className="bg-[#10151d] rounded p-2 col-span-2">
                              <div className="text-[#7d8ba0] mb-1">Execution</div>
                              <div>decision {c.execution?.decision} · conf {c.execution?.confidence}{c.execution?.adjustments?.length ? " · " + c.execution.adjustments.join("; ") : ""}</div>
                              <div className="text-[#7d8ba0] mt-1">{c.reason}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
