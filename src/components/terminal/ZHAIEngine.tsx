// DEPRECATED: duplicate of the production Zero Hero path
// (ZeroHeroTerminal.tsx -> zhCandidates -> FullZeroHero -> Trade Audit).
// Kept on disk until production consolidation is verified.

// Zero Hero AI Engine panel
// Shows the standardized Expiry Engine data + full Zero Hero AI decision pipeline

import { useState, useEffect } from "react";

interface ExpiryData {
  instrument: string;
  exchange: string;
  expiry_date: string;
  expiry_type: string;
  days_to_expiry: number;
  is_expiry_today: boolean;
  is_monthly_expiry: boolean;
  is_weekly_expiry: boolean;
  is_quarterly_expiry: boolean;
  expiry_mode: string;
  option_liquidity: string;
  strategy_profile: string;
  session_type: string;
  lot_size: number;
  tick_size: number;
}

interface ZHAnalyze {
  expiry: ExpiryData | null;
  market_regime: any;
  option_chain: any;
  smart_money: any;
  volume_flow: any;
  greeks: any;
  gamma_theta: any;
  probability: any;
  position_size: any;
  entry_tp_sl: any;
  execution: any;
  summary: any;
  source?: string;
  vix?: number;
  atr?: number;
  iv?: number;
  hv?: number;
}

const fmt = (n: number, d = 2) =>
  n == null || isNaN(n) ? "0" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#0a1018] rounded p-2">
      <div className="text-[#7d8ba0] text-[10.5px]">{label}</div>
      <div className={`font-bold ${color || "text-[#e6edf6]"}`}>{value}</div>
    </div>
  );
}

function ScoreBar({ label, score, max = 100 }: { label: string; score: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const color = pct >= 70 ? "#1fbf75" : pct >= 40 ? "#e8a33d" : "#f2495c";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-[#7d8ba0]">{label}</span>
        <span className="font-mono font-bold" style={{ color }}>{score}</span>
      </div>
      <div className="h-1.5 bg-[#1f2733] rounded overflow-hidden">
        <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function ZHAIEngine({ symbol }: { symbol: string }) {
  const [expiry, setExpiry] = useState<ExpiryData | null>(null);
  const [analyze, setAnalyze] = useState<ZHAnalyze | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const exRes = await fetch(`/api/zero-hero?action=expiry&symbol=${symbol}`);
        const exJson = await exRes.json();
        if (mounted && exJson) setExpiry(exJson);
      } catch (e: any) {
        if (mounted) setError(e.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [symbol]);

  async function runAnalyze() {
    try {
      setRunning(true);
      setError(null);
      const res = await fetch(`/api/zero-hero?action=analyze&symbol=${symbol}`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setAnalyze(json);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const signalColor =
    analyze?.summary?.signal === "BUY_CALL"
      ? "#1fbf75"
      : analyze?.summary?.signal === "BUY_PUT"
      ? "#4f8ff7"
      : "#7d8ba0";

  return (
    <div className="space-y-3">
      {/* Standardized Expiry Engine data */}
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center justify-between">
          <span>Expiry Engine — {symbol}</span>
          <span className="text-[#7d8ba0] font-mono text-[11px]">Standardized Expiry Data</span>
        </div>
        {loading && <div className="p-6 text-center text-[#7d8ba0]">Loading expiry data…</div>}
        {expiry && (
          <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Stat label="Instrument" value={expiry.instrument} color="#e8a33d" />
            <Stat label="Exchange" value={expiry.exchange} />
            <Stat label="Expiry Date" value={expiry.expiry_date} color="#4f8ff7" />
            <Stat label="Expiry Type" value={expiry.expiry_type} color="#1fbf75" />
            <Stat label="Days to Expiry" value={String(expiry.days_to_expiry)} />
            <Stat label="Expiry Today" value={expiry.is_expiry_today ? "YES" : "NO"} color={expiry.is_expiry_today ? "#f2495c" : undefined} />
            <Stat label="Monthly" value={expiry.is_monthly_expiry ? "YES" : "NO"} />
            <Stat label="Weekly" value={expiry.is_weekly_expiry ? "YES" : "NO"} />
            <Stat label="Expiry Mode" value={expiry.expiry_mode} color="#e8a33d" />
            <Stat label="Liquidity" value={expiry.option_liquidity} />
            <Stat label="Strategy" value={expiry.strategy_profile} />
            <Stat label="Session" value={expiry.session_type} />
            <Stat label="Lot Size" value={String(expiry.lot_size)} />
            <Stat label="Tick Size" value={String(expiry.tick_size)} />
          </div>
        )}
      </div>

      {/* Run button */}
      <div className="flex items-center gap-3">
        <button
          onClick={runAnalyze}
          disabled={running}
          className="px-4 py-2 rounded-[8px] bg-[#1fbf75] text-[#06120c] font-bold text-[12px] disabled:opacity-50"
        >
          {running ? "Running Zero Hero AI…" : "▶ Run Zero Hero AI Engine"}
        </button>
        {analyze?.source && (
          <span className="text-[11px] text-[#7d8ba0] font-mono">
            source: {analyze.source} · VIX {fmt(analyze.vix || 0)} · IV {fmt(analyze.iv || 0)} · ATR {fmt(analyze.atr || 0)}
          </span>
        )}
      </div>

      {error && (
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-4 text-center text-[#f2495c] text-[12px]">
          {error}
        </div>
      )}

      {analyze && (
        <>
          {/* Final decision */}
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Zero Hero AI — Decision</div>
            <div className="p-4 flex items-center justify-between">
              <div>
                <div className="text-[#7d8ba0] text-[11px]">Signal</div>
                <div className="text-[22px] font-black" style={{ color: signalColor }}>{analyze.summary?.signal}</div>
                <div className="text-[#7d8ba0] text-[11px] mt-1">{analyze.summary?.reason}</div>
              </div>
              <div className="text-right">
                <div className="text-[#7d8ba0] text-[11px]">Confidence</div>
                <div className="text-[28px] font-black" style={{ color: signalColor }}>{fmt(analyze.summary?.confidence || 0, 1)}%</div>
                <div className="text-[#7d8ba0] text-[11px] mt-1">Decision: {analyze.execution?.decision}</div>
              </div>
            </div>
          </div>

          {/* Engine scores */}
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Engine Scores</div>
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              <ScoreBar label="Gamma-Theta" score={analyze.gamma_theta?.score || 0} />
              <ScoreBar label="Smart Money" score={analyze.smart_money?.confidence || 0} />
              <ScoreBar label="Option Chain (OI)" score={analyze.option_chain?.confidence || 0} />
              <ScoreBar label="Volume & Order Flow" score={analyze.volume_flow?.confidence || 0} />
              <ScoreBar label="Market Regime" score={analyze.market_regime?.confidence || 0} />
              <ScoreBar label="Greeks" score={analyze.greeks?.confidence || 0} />
            </div>
          </div>

          {/* Sub-engine details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Greeks (ATM)</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="Delta" value={fmt(analyze.greeks?.delta || 0)} />
                <Stat label="Gamma" value={fmt(analyze.greeks?.gamma || 0, 4)} />
                <Stat label="Theta" value={fmt(analyze.greeks?.theta || 0)} />
                <Stat label="Vega" value={fmt(analyze.greeks?.vega || 0)} />
              </div>
            </div>
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Option Chain</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="PCR" value={fmt(analyze.option_chain?.pcr || 0)} color="#1fbf75" />
                <Stat label="Max Pain" value={fmt(analyze.option_chain?.max_pain || 0, 0)} />
                <Stat label="Resistance" value={fmt(analyze.option_chain?.highest_oi_ce || 0, 0)} />
                <Stat label="Support" value={fmt(analyze.option_chain?.highest_oi_pe || 0, 0)} />
              </div>
            </div>
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Smart Money</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="Bias" value={analyze.smart_money?.bias || "—"} color="#e8a33d" />
                <Stat label="BOS" value={analyze.smart_money?.bos ? "YES" : "NO"} />
                <Stat label="CHoCH" value={analyze.smart_money?.choch ? "YES" : "NO"} />
                <Stat label="Liq. Sweep" value={analyze.smart_money?.liquidity_sweep ? "YES" : "NO"} />
              </div>
            </div>
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Market Regime</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="Regime" value={analyze.market_regime?.regime || "—"} color="#4f8ff7" />
                <Stat label="Vol State" value={analyze.market_regime?.volatility_state || "—"} />
                <Stat label="IV Rank" value={fmt(analyze.market_regime?.iv_rank || 0)} />
                <Stat label="Exp. Range" value={fmt(analyze.market_regime?.expected_range || 0, 0)} />
              </div>
            </div>
          </div>

          {/* Trade plan */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Probability</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="P(ITM)" value={fmt((analyze.probability?.prob_itm || 0) * 100, 1) + "%"} />
                <Stat label="P(Profit)" value={fmt((analyze.probability?.prob_profit || 0) * 100, 1) + "%"} />
                <Stat label="Breakeven" value={fmt(analyze.probability?.breakeven || 0, 0)} />
                <Stat label="Exp. Value" value={fmt(analyze.probability?.expected_value || 0)} />
              </div>
            </div>
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Position Size</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="Rec. Lots" value={String(analyze.position_size?.recommendedLots || 0)} color="#1fbf75" />
                <Stat label="Kelly Lots" value={String(analyze.position_size?.kellyLots || 0)} />
                <Stat label="Max Loss" value={"₹" + fmt(analyze.position_size?.maxLossAmount || 0, 0)} />
                <Stat label="R:R" value={fmt(analyze.position_size?.riskRewardRatio || 0)} />
              </div>
            </div>
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[12px]">Entry / TP / SL</div>
              <div className="p-3 grid grid-cols-2 gap-2 text-[11px]">
                <Stat label="Entry" value={"₹" + fmt(analyze.entry_tp_sl?.entry || 0)} />
                <Stat label="Target" value={"₹" + fmt(analyze.entry_tp_sl?.target || 0)} color="#1fbf75" />
                <Stat label="Stop Loss" value={"₹" + fmt(analyze.entry_tp_sl?.stopLoss || 0)} color="#f2495c" />
                <Stat label="Strategy" value={analyze.entry_tp_sl?.strategy || "—"} />
              </div>
            </div>
          </div>

          {analyze.execution?.adjustments?.length > 0 && (
            <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3 text-[11px] text-[#e8a33d]">
              {analyze.execution.adjustments.map((a: string, i: number) => (
                <div key={i}>• {a}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
