"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  type StrategyConfig,
  DEFAULT_STRATEGY_CONFIG,
  loadStrategyConfig,
  saveStrategyConfig,
  resetStrategyConfig,
  exportStrategyConfig,
  importStrategyConfig,
} from "@/lib/strategy-config";

export default function StrategyConfigPanel() {
  const [config, setConfig] = useState<StrategyConfig>(() => loadStrategyConfig());
  const [activeTab, setActiveTab] = useState("modules");
  const [saved, setSaved] = useState(false);
  const [importJson, setImportJson] = useState("");

  const update = useCallback((path: string, value: any) => {
    setConfig(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let obj: any = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return next;
    });
    setSaved(false);
  }, []);

  const handleSave = () => { saveStrategyConfig(config); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const handleReset = () => { if (confirm("Reset all strategy parameters to defaults?")) { setConfig(resetStrategyConfig()); setSaved(false); } };
  const handleExport = () => {
    const blob = new Blob([exportStrategyConfig(config)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `sdm-strategy-${new Date().toISOString().split("T")[0]}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const handleImport = () => { try { setConfig(importStrategyConfig(importJson)); setImportJson(""); setSaved(false); } catch { alert("Invalid JSON."); } };

  const tabs = [
    { id: "modules", label: "Modules" },
    { id: "confidence", label: "Confidence" },
    { id: "entry", label: "Entry" },
    { id: "greeks", label: "Greeks" },
    { id: "oi", label: "OI" },
    { id: "smartMoney", label: "Smart $" },
    { id: "risk", label: "Risk" },
    { id: "strike", label: "Strike" },
    { id: "session", label: "Session" },
    { id: "symbols", label: "Symbols" },
    { id: "import", label: "Import" },
  ];

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-primary">STRATEGY CONFIG</span>
          <span className="text-muted-foreground text-[10px]">{config.name} v{config.version}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={handleExport} className="h-6 text-[10px] bg-muted px-2 rounded">Export</button>
          <button onClick={handleReset} className="h-6 text-[10px] bg-red-500/20 text-red-400 px-2 rounded">Reset</button>
          <button onClick={handleSave} className={`h-6 text-[10px] px-3 rounded font-bold ${saved ? "bg-emerald-500/20 text-emerald-400" : "bg-primary text-primary-foreground"}`}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-2 py-1 rounded text-[10px] whitespace-nowrap ${activeTab === tab.id ? "bg-primary text-primary-foreground font-bold" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-secondary/30 rounded p-3 min-h-[300px]">
        {activeTab === "modules" && <ModulesTabContent config={config} update={update} />}
        {activeTab === "confidence" && <ConfidenceTabContent config={config} update={update} />}
        {activeTab === "entry" && <EntryTabContent config={config} update={update} />}
        {activeTab === "greeks" && <GreeksTabContent config={config} update={update} />}
        {activeTab === "oi" && <OITabContent config={config} update={update} />}
        {activeTab === "smartMoney" && <SmartMoneyTabContent config={config} update={update} />}
        {activeTab === "risk" && <RiskTabContent config={config} update={update} />}
        {activeTab === "strike" && <StrikeTabContent config={config} update={update} />}
        {activeTab === "session" && <SessionTabContent config={config} update={update} />}
        {activeTab === "symbols" && <SymbolsTabContent config={config} update={update} />}
        {activeTab === "import" && <ImportTabContent config={config} importJson={importJson} setImportJson={setImportJson} handleImport={handleImport} handleExport={handleExport} />}
      </div>
    </div>
  );
}

// ─── Shared helpers ──────────────────────────────────────────────
function Toggle({ label, value, onChange, desc }: { label: string; value: boolean; onChange: (v: boolean) => void; desc?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 bg-muted/30 rounded">
      <div>
        <div className="text-[11px] font-medium">{label}</div>
        {desc && <div className="text-[9px] text-muted-foreground">{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`w-8 h-4 rounded-full transition-colors shrink-0 ${value ? "bg-emerald-500" : "bg-muted"}`}
      >
        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, unit = "", desc }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string; desc?: string;
}) {
  return (
    <div className="py-1.5">
      <div className="flex justify-between mb-1">
        <div className="text-[11px] font-medium">{label}</div>
        <div className="text-[11px] font-mono font-bold text-primary">{value}{unit}</div>
      </div>
      <div className="relative">
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-muted rounded appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between text-[8px] text-muted-foreground mt-0.5">
          <span>{min}{unit}</span>
          <span>{max}{unit}</span>
        </div>
      </div>
      {desc && <div className="text-[9px] text-muted-foreground mt-0.5">{desc}</div>}
    </div>
  );
}

function NumInput({ label, value, onChange, min, max, step = 1, unit = "" }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 bg-muted/30 rounded">
      <div className="text-[11px] font-medium">{label}</div>
      <div className="flex items-center gap-1">
        <input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} min={min} max={max} step={step}
          className="w-16 h-6 text-[11px] text-right bg-muted border border-border/50 rounded px-1 font-mono"
        />
        {unit && <span className="text-[9px] text-muted-foreground w-6">{unit}</span>}
      </div>
    </div>
  );
}

// ─── Tab: Modules ────────────────────────────────────────────────
function ModulesTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  const modules = [
    { key: "marketStructure", label: "Market Structure", desc: "Trend, S/R, VWAP, EMAs, Pivots" },
    { key: "greeks", label: "Greeks Analysis", desc: "Delta, Gamma, Theta, Vega, IV" },
    { key: "openInterest", label: "Open Interest", desc: "OI buildup, PCR, Max Pain" },
    { key: "smartMoney", label: "Smart Money", desc: "Liquidity sweeps, fakeouts, order blocks" },
    { key: "optionFlow", label: "Option Flow", desc: "Volume, institutional orders, block trades" },
    { key: "entryConditions", label: "Entry Conditions", desc: "VWAP, trend, volume filters" },
    { key: "riskEngine", label: "Risk Engine", desc: "Position sizing, SL/TP calculation" },
    { key: "confidenceEngine", label: "Confidence Engine", desc: "0-100 scoring system" },
    { key: "zeroDte", label: "0DTE Expiry Engine", desc: "Gamma squeeze, expiry day trading" },
    { key: "alerts", label: "Live Alerts", desc: "Real-time signal notifications" },
  ];
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-bold text-muted-foreground mb-2">ENABLE / DISABLE MODULES</div>
      {modules.map(m => (
        <Toggle key={m.key} label={m.label} value={config.modules[m.key as keyof typeof config.modules]} onChange={v => update(`modules.${m.key}`, v)} desc={m.desc} />
      ))}
    </div>
  );
}

// ─── Tab: Confidence ─────────────────────────────────────────────
function ConfidenceTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  const w = config.confidence.weights;
  const totalWeight = w.trend + w.oi + w.greeks + w.liquidity + w.volume + w.priceAction + w.institutionalFlow;
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">THRESHOLDS</div>
      <Slider label="Entry Threshold" value={config.confidence.entryThreshold} onChange={v => update("confidence.entryThreshold", v)} min={50} max={100} unit="%" desc="Minimum confidence to trigger a trade" />
      <Slider label="0DTE Threshold" value={config.confidence.zeroDteThreshold} onChange={v => update("confidence.zeroDteThreshold", v)} min={70} max={100} unit="%" desc="Higher threshold for expiry day trades" />
      <Slider label="Cancel Threshold" value={config.confidence.cancelThreshold} onChange={v => update("confidence.cancelThreshold", v)} min={30} max={90} unit="%" desc="Cancel if confidence drops below" />
      <div className="text-[11px] font-bold text-muted-foreground mt-3">SCORING WEIGHTS <span className="font-mono text-primary">({totalWeight}/100)</span></div>
      <Slider label="Trend" value={w.trend} onChange={v => update("confidence.weights.trend", v)} min={0} max={40} unit="%" />
      <Slider label="OI" value={w.oi} onChange={v => update("confidence.weights.oi", v)} min={0} max={40} unit="%" />
      <Slider label="Greeks" value={w.greeks} onChange={v => update("confidence.weights.greeks", v)} min={0} max={40} unit="%" />
      <Slider label="Liquidity" value={w.liquidity} onChange={v => update("confidence.weights.liquidity", v)} min={0} max={30} unit="%" />
      <Slider label="Volume" value={w.volume} onChange={v => update("confidence.weights.volume", v)} min={0} max={20} unit="%" />
      <Slider label="Price Action" value={w.priceAction} onChange={v => update("confidence.weights.priceAction", v)} min={0} max={20} unit="%" />
      <Slider label="Institutional Flow" value={w.institutionalFlow} onChange={v => update("confidence.weights.institutionalFlow", v)} min={0} max={15} unit="%" />
    </div>
  );
}

// ─── Tab: Entry ──────────────────────────────────────────────────
function EntryTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">ENTRY CONDITIONS</div>
      <Toggle label="CALL: Above VWAP Required" value={config.entry.callRequireAboveVwap} onChange={v => update("entry.callRequireAboveVwap", v)} desc="Only enter CALL if spot above VWAP" />
      <Toggle label="PUT: Below VWAP Required" value={config.entry.putRequireBelowVwap} onChange={v => update("entry.putRequireBelowVwap", v)} desc="Only enter PUT if spot below VWAP" />
      <Toggle label="Require Institutional Flow" value={config.entry.requireInstitutionalFlow} onChange={v => update("entry.requireInstitutionalFlow", v)} desc="Block trades or large orders detected" />
      <Toggle label="Require Volume Spike" value={config.entry.requireVolumeSpike} onChange={v => update("entry.requireVolumeSpike", v)} desc="Volume must spike above average" />
      <div className="text-[11px] font-bold text-muted-foreground mt-3">THRESHOLDS</div>
      <Slider label="Min Volume Increase" value={config.entry.minVolumeIncrease} onChange={v => update("entry.minVolumeIncrease", v)} min={0} max={50} unit="%" />
      <Slider label="Max Spread" value={config.entry.maxSpreadPct} onChange={v => update("entry.maxSpreadPct", v)} min={1} max={20} unit="%" desc="Max bid-ask spread as % of premium" />
      <NumInput label="Min OI Change (Buildup)" value={config.entry.minOIChangeForBuildup} onChange={v => update("entry.minOIChangeForBuildup", v)} min={10000} max={500000} step={10000} />
      <NumInput label="Fresh Writing Threshold" value={config.entry.freshWritingThreshold} onChange={v => update("entry.freshWritingThreshold", v)} min={50000} max={500000} step={10000} />
      <NumInput label="Fresh Writing Max Premium" value={config.entry.freshWritingMaxPremium} onChange={v => update("entry.freshWritingMaxPremium", v)} min={1} max={20} unit="₹" />
    </div>
  );
}

// ─── Tab: Greeks ─────────────────────────────────────────────────
function GreeksTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">GREEKS THRESHOLDS</div>
      <Slider label="IV Expansion Threshold" value={config.greeks.ivExpansionThreshold} onChange={v => update("greeks.ivExpansionThreshold", v)} min={50} max={95} unit="%" desc="IV percentile above this = expansion" />
      <Slider label="IV Crush Threshold" value={config.greeks.ivCrushThreshold} onChange={v => update("greeks.ivCrushThreshold", v)} min={5} max={50} unit="%" desc="IV percentile below this = crush" />
      <Slider label="Rapid Theta Burn" value={config.greeks.rapidThetaBurnThreshold} onChange={v => update("greeks.rapidThetaBurnThreshold", v)} min={0.5} max={5} step={0.1} unit="₹" desc="Theta above this = rapid decay" />
      <Slider label="Delta Acceleration" value={config.greeks.deltaAccelerationThreshold} onChange={v => update("greeks.deltaAccelerationThreshold", v)} min={0.01} max={0.5} step={0.01} />
      <Slider label="Gamma Flip Sensitivity" value={config.greeks.gammaFlipSensitivity} onChange={v => update("greeks.gammaFlipSensitivity", v)} min={0.1} max={1} step={0.05} unit="%" desc="Max distance from spot to detect gamma flip" />
      <Slider label="Gamma Squeeze Max Distance" value={config.greeks.gammaSqueezeMaxDistance} onChange={v => update("greeks.gammaSqueezeMaxDistance", v)} min={0.05} max={0.5} step={0.05} unit="%" />
      <Slider label="Gamma Squeeze Min Gamma" value={config.greeks.gammaSqueezeMinGamma} onChange={v => update("greeks.gammaSqueezeMinGamma", v)} min={0.0001} max={0.005} step={0.0001} />
    </div>
  );
}

// ─── Tab: OI ─────────────────────────────────────────────────────
function OITabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">OI THRESHOLDS</div>
      <Slider label="PCR Bullish Threshold" value={config.oi.pcrBullishThreshold} onChange={v => update("oi.pcrBullishThreshold", v)} min={0.8} max={2} step={0.05} desc="PCR above this = bullish (put writing)" />
      <Slider label="PCR Bearish Threshold" value={config.oi.pcrBearishThreshold} onChange={v => update("oi.pcrBearishThreshold", v)} min={0.3} max={0.9} step={0.05} desc="PCR below this = bearish (call writing)" />
      <NumInput label="Buildup Threshold" value={config.oi.buildupThreshold} onChange={v => update("oi.buildupThreshold", v)} min={10000} max={500000} step={10000} />
      <NumInput label="Unwinding Threshold" value={config.oi.unwindingThreshold} onChange={v => update("oi.unwindingThreshold", v)} min={10000} max={500000} step={10000} />
      <NumInput label="Large Order Threshold" value={config.oi.largeOrderThreshold} onChange={v => update("oi.largeOrderThreshold", v)} min={50000} max={1000000} step={10000} />
      <Slider label="Unusual Volume" value={config.oi.unusualVolumeMultiplier} onChange={v => update("oi.unusualVolumeMultiplier", v)} min={1.5} max={10} step={0.5} unit="x" desc="Volume must be this many times average" />
    </div>
  );
}

// ─── Tab: Smart Money ────────────────────────────────────────────
function SmartMoneyTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">SMART MONEY</div>
      <Slider label="Sweep Range" value={config.smartMoney.sweepRangePercent} onChange={v => update("smartMoney.sweepRangePercent", v)} min={5} max={30} unit="%" desc="% of daily range to detect liquidity sweep" />
      <Slider label="Fakeout Expansion" value={config.smartMoney.fakeoutExpansionMultiplier} onChange={v => update("smartMoney.fakeoutExpansionMultiplier", v)} min={1.2} max={3} step={0.1} unit="x" desc="Range expansion to detect fake breakout" />
      <Slider label="Stop Hunt Sensitivity" value={config.smartMoney.stopHuntSensitivity} onChange={v => update("smartMoney.stopHuntSensitivity", v)} min={0.1} max={1} step={0.1} />
    </div>
  );
}

// ─── Tab: Risk ───────────────────────────────────────────────────
function RiskTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">RISK</div>
      <Slider label="Stop Loss %" value={config.risk.slPercent} onChange={v => update("risk.slPercent", v)} min={10} max={60} unit="%" desc="SL as % of premium" />
      <Slider label="Target 1" value={config.risk.tp1Multiplier} onChange={v => update("risk.tp1Multiplier", v)} min={1} max={3} step={0.1} unit="x" />
      <Slider label="Target 2" value={config.risk.tp2Multiplier} onChange={v => update("risk.tp2Multiplier", v)} min={1.5} max={5} step={0.1} unit="x" />
      <Slider label="Target 3" value={config.risk.tp3Multiplier} onChange={v => update("risk.tp3Multiplier", v)} min={2} max={10} step={0.1} unit="x" />
      <div className="text-[11px] font-bold text-muted-foreground mt-3">POSITION LIMITS</div>
      <Slider label="Max Risk Per Trade" value={config.risk.maxRiskPerTrade} onChange={v => update("risk.maxRiskPerTrade", v)} min={0.25} max={5} step={0.25} unit="%" desc="% of capital" />
      <NumInput label="Max Positions" value={config.risk.maxPositions} onChange={v => update("risk.maxPositions", v)} min={1} max={10} />
      <Slider label="Max Daily Loss" value={config.risk.maxDailyLoss} onChange={v => update("risk.maxDailyLoss", v)} min={1} max={10} unit="%" desc="% of capital" />
      <div className="text-[11px] font-bold text-muted-foreground mt-3">PROFIT PROTECTION</div>
      <Slider label="Move SL to Cost After" value={config.risk.moveToCostAfter} onChange={v => update("risk.moveToCostAfter", v)} min={10} max={50} unit="%" desc="Profit % to move SL to entry" />
      <Slider label="Trailing Stop Activation" value={config.risk.trailingStopActivation} onChange={v => update("risk.trailingStopActivation", v)} min={20} max={80} unit="%" />
      <Slider label="Book 25% at" value={config.risk.bookPartialAt1} onChange={v => update("risk.bookPartialAt1", v)} min={25} max={100} unit="%" />
      <Slider label="Book 25% at" value={config.risk.bookPartialAt2} onChange={v => update("risk.bookPartialAt2", v)} min={50} max={300} unit="%" />
    </div>
  );
}

// ─── Tab: Strike ─────────────────────────────────────────────────
function StrikeTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">STRIKE SELECTION</div>
      <div className="py-1">
        <div className="text-[11px] font-medium mb-1">Preferred Strike Type</div>
        <div className="flex gap-1">
          {(["AUTO", "ATM", "ITM", "OTM"] as const).map(type => (
            <button key={type} onClick={() => update("strike.preferredStrikeType", type)}
              className={`px-3 py-1.5 rounded text-[10px] font-bold ${config.strike.preferredStrikeType === type ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
              {type}
            </button>
          ))}
        </div>
        <div className="text-[9px] text-muted-foreground mt-1">AUTO: Let engine decide based on confidence</div>
      </div>
      <NumInput label="OTM for Low Confidence" value={config.strike.otmForLowConfidence} onChange={v => update("strike.otmForLowConfidence", v)} min={1} max={5} unit="strikes" />
      <NumInput label="ITM for High Confidence" value={config.strike.itmForHighConfidence} onChange={v => update("strike.itmForHighConfidence", v)} min={0} max={3} unit="strikes" />
    </div>
  );
}

// ─── Tab: Session ────────────────────────────────────────────────
function SessionTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">MARKET HOURS</div>
      <NumInput label="Avoid First N Minutes" value={config.session.avoidFirstMinutes} onChange={v => update("session.avoidFirstMinutes", v)} min={0} max={30} unit="min" />
      <NumInput label="Avoid Last N Minutes" value={config.session.avoidLastMinutes} onChange={v => update("session.avoidLastMinutes", v)} min={0} max={30} unit="min" />
      <div className="py-1">
        <div className="text-[11px] font-medium mb-1">Lunch Break</div>
        <div className="flex items-center gap-2">
          <input type="time" value={config.session.lunchStart} onChange={e => update("session.lunchStart", e.target.value)} className="h-6 text-[11px] bg-muted border rounded px-1" />
          <span className="text-[10px]">to</span>
          <input type="time" value={config.session.lunchEnd} onChange={e => update("session.lunchEnd", e.target.value)} className="h-6 text-[11px] bg-muted border rounded px-1" />
        </div>
      </div>
      <div className="text-[11px] font-bold text-muted-foreground mt-3">BEST TRADING WINDOWS</div>
      {config.session.bestWindows.map((w, i) => (
        <div key={i} className="flex items-center gap-2">
          <input type="time" value={w.start} onChange={e => { const ws = [...config.session.bestWindows]; ws[i] = { ...ws[i], start: e.target.value }; update("session.bestWindows", ws); }} className="h-6 text-[11px] bg-muted border rounded px-1" />
          <span className="text-[10px]">to</span>
          <input type="time" value={w.end} onChange={e => { const ws = [...config.session.bestWindows]; ws[i] = { ...ws[i], end: e.target.value }; update("session.bestWindows", ws); }} className="h-6 text-[11px] bg-muted border rounded px-1" />
          <button onClick={() => update("session.bestWindows", config.session.bestWindows.filter((_, j) => j !== i))} className="text-red-400 text-[10px]">✕</button>
        </div>
      ))}
      <button onClick={() => update("session.bestWindows", [...config.session.bestWindows, { start: "09:30", end: "12:30" }])} className="text-[10px] text-primary hover:underline">+ Add Window</button>
    </div>
  );
}

// ─── Tab: Symbols ────────────────────────────────────────────────
function SymbolsTabContent({ config, update }: { config: StrategyConfig; update: (path: string, v: any) => void }) {
  const symbols = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">SYMBOLS</div>
      {symbols.map(sym => {
        const override = config.symbolOverrides.find(o => o.symbol === sym) || { symbol: sym, enabled: true };
        return (
          <div key={sym} className="flex items-center justify-between p-2 bg-muted/30 rounded">
            <div className="font-bold text-[11px]">{sym}</div>
            <div className="flex items-center gap-3">
              <NumInput label="Lot" value={override.lotSize || 0} onChange={v => {
                const overrides = [...config.symbolOverrides];
                const idx = overrides.findIndex(o => o.symbol === sym);
                if (idx >= 0) overrides[idx] = { ...overrides[idx], lotSize: v };
                else overrides.push({ symbol: sym, lotSize: v, enabled: true });
                update("symbolOverrides", overrides);
              }} min={0} max={1000} />
              <Toggle label="On" value={override.enabled ?? true} onChange={v => {
                const overrides = [...config.symbolOverrides];
                const idx = overrides.findIndex(o => o.symbol === sym);
                if (idx >= 0) overrides[idx] = { ...overrides[idx], enabled: v };
                else overrides.push({ symbol: sym, enabled: v });
                update("symbolOverrides", overrides);
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tab: Import ─────────────────────────────────────────────────
function ImportTabContent({ config, importJson, setImportJson, handleImport, handleExport }: {
  config: StrategyConfig; importJson: string; setImportJson: (v: string) => void; handleImport: () => void; handleExport: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-muted-foreground">EXPORT</div>
      <button onClick={handleExport} className="h-8 text-[11px] bg-primary text-primary-foreground px-3 rounded font-bold">Download JSON</button>
      <div className="text-[11px] font-bold text-muted-foreground mt-3">IMPORT</div>
      <textarea value={importJson} onChange={e => setImportJson(e.target.value)} placeholder="Paste strategy JSON here..." className="w-full h-32 text-[10px] bg-muted border rounded p-2 font-mono" />
      <button onClick={handleImport} disabled={!importJson.trim()} className="h-8 text-[11px] bg-primary text-primary-foreground px-3 rounded font-bold disabled:opacity-50">Import</button>
      <div className="text-[11px] font-bold text-muted-foreground mt-3">CURRENT CONFIG</div>
      <pre className="text-[9px] bg-muted rounded p-2 overflow-auto max-h-40 font-mono">{JSON.stringify(config, null, 2).substring(0, 2000)}...</pre>
    </div>
  );
}
