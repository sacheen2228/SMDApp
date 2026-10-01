"use client";

// Jarvis live signal tab — renders GET /api/jarvis (worker-cache-first
// read path shared with the chat's "Jarvis" command). The bias/action/
// strategy shown here come straight from buildSignal()'s output; NO_TRADE
// gates are always visible, never hidden. Stubbed component scores
// (oiSpurts / preopenClose / breadth / week52) render dimmed as "N/A — not
// wired" instead of a fake zero reading.

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Bot, ShieldAlert, TrendingUp, MessageSquare, LayoutDashboard } from "lucide-react";
import type { JarvisSignal, ComponentScores } from "@/lib/jarvis/types";
import { JarvisChat } from "@/components/dashboard/JarvisChat";

interface JarvisTabProps {
  symbol: string;
}

interface JarvisResponse {
  success: boolean;
  signal?: JarvisSignal;
  history?: JarvisSignal[];
  source?: "worker-cache" | "on-demand";
  error?: string;
}

const STUBBED_KEYS: (keyof ComponentScores)[] = ["oiSpurts", "preopenClose", "breadth", "week52"];

const SCORE_META: { key: keyof ComponentScores; label: string; max: number }[] = [
  { key: "optionChain", label: "Option Chain", max: 25 },
  { key: "fii", label: "FII Flows", max: 9 },
  { key: "greeks", label: "Greeks", max: 10 },
  { key: "heatmap", label: "Heatmap", max: 7 },
  { key: "oiSpurts", label: "OI Spurts", max: 10 },
  { key: "preopenClose", label: "Pre-open/Close", max: 10 },
  { key: "breadth", label: "Breadth", max: 5 },
  { key: "week52", label: "52-Week Extremes", max: 10 },
  { key: "newsSentiment", label: "News Sentiment", max: 100 },
];

const ACTION_STYLE: Record<string, string> = {
  BUY_CE: "bg-emerald-600 text-white",
  BUY_PE: "bg-red-600 text-white",
  NO_TRADE: "bg-slate-600 text-white",
};

function ageLabel(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s ago`;
}

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// Center-zero score bar: left = negative (bearish), right = positive (bullish)
function ScoreBar({ value, max, stub }: { value: number; max: number; stub: boolean }) {
  if (stub) {
    return (
      <div className="h-2 w-full rounded bg-muted/40 border border-dashed border-muted-foreground/30 relative">
        <span className="absolute inset-0 flex items-center justify-center text-[7px] text-muted-foreground/70 uppercase tracking-wide">
          not wired
        </span>
      </div>
    );
  }
  const pct = Math.min(100, (Math.abs(value) / max) * 100);
  const positive = value >= 0;
  return (
    <div className="h-2 w-full rounded bg-muted/60 relative overflow-hidden">
      <div className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/50" />
      <div
        className={`absolute inset-y-0 ${positive ? "bg-emerald-500" : "bg-red-500"}`}
        style={
          positive
            ? { left: "50%", width: `${pct / 2}%` }
            : { right: "50%", width: `${pct / 2}%` }
        }
      />
    </div>
  );
}

function BiasGauge({ bias }: { bias: number }) {
  const pct = Math.min(100, Math.abs(bias));
  const positive = bias >= 0;
  return (
    <div className="w-full">
      <div className="flex justify-between text-[8px] text-muted-foreground mb-1">
        <span>-100 bearish</span>
        <span>0</span>
        <span>bullish +100</span>
      </div>
      <div className="h-3 w-full rounded bg-muted/70 relative overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/60 z-10" />
        <div
          className={`absolute inset-y-0 ${positive ? "bg-gradient-to-r from-emerald-700 to-emerald-500" : "bg-gradient-to-l from-red-700 to-red-500"}`}
          style={positive ? { left: "50%", width: `${pct / 2}%` } : { right: "50%", width: `${pct / 2}%` }}
        />
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow z-20"
          style={{ left: `calc(${50 + (bias / 100) * 50}% - 1px)` }}
        />
      </div>
    </div>
  );
}

export function JarvisTab({ symbol }: JarvisTabProps) {
  const [data, setData] = useState<JarvisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jarvis?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const json: JarvisResponse = await res.json();
      if (!aliveRef.current) return;
      if (json.success && json.signal) {
        setData(json);
        setError(null);
      } else {
        setError(json.error || "failed to load signal");
      }
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    load();
    const fetchTimer = setInterval(load, 30_000); // cache-path read — cheap
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      aliveRef.current = false;
      clearInterval(fetchTimer);
      clearInterval(clock);
    };
  }, [load]);

  const signal = data?.signal;
  const source = data?.source;

  // Chat-first: the tab opens as a conversation; the signal dashboard
  // (gates, scores, history) stays one click away.
  const [mode, setMode] = useState<"chat" | "dashboard">("chat");

  const topBar = (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/50 shrink-0">
      <Button
        size="sm"
        variant={mode === "chat" ? "default" : "ghost"}
        className={`h-6 text-[9px] px-2 ${mode === "chat" ? "bg-sky-600 text-white" : "text-muted-foreground"}`}
        onClick={() => setMode("chat")}
      >
        <MessageSquare className="h-2.5 w-2.5 mr-1" /> Chat
      </Button>
      <Button
        size="sm"
        variant={mode === "dashboard" ? "default" : "ghost"}
        className={`h-6 text-[9px] px-2 ${mode === "dashboard" ? "bg-sky-600 text-white" : "text-muted-foreground"}`}
        onClick={() => setMode("dashboard")}
      >
        <LayoutDashboard className="h-2.5 w-2.5 mr-1" /> Dashboard
      </Button>
      {signal && mode === "dashboard" && (
        <span className="text-[9px] text-muted-foreground ml-1">
          {signal.instrument} · {signal.action === "NO_TRADE" ? "NO TRADE" : signal.action} · bias{" "}
          {signal.biasScore > 0 ? "+" : ""}
          {signal.biasScore}
        </span>
      )}
    </div>
  );

  if (mode === "chat") {
    return (
      <div className="flex h-full flex-col">
        {topBar}
        <div className="flex-1 min-h-0">
          <JarvisChat symbol={symbol} />
        </div>
      </div>
    );
  }

  if (loading && !signal) {
    return (
      <div className="flex h-full flex-col">
        {topBar}
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Bot className="h-4 w-4 mr-2 animate-pulse" /> Jarvis is reading the chain…
        </div>
      </div>
    );
  }

  if (!signal) {
    return (
      <div className="flex h-full flex-col">
        {topBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <ShieldAlert className="h-6 w-6 text-amber-500" />
          <div>Jarvis signal unavailable: {error || "unknown error"}</div>
          <Button size="sm" variant="outline" onClick={() => { setLoading(true); load(); }}>
            <RefreshCw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const isTrade = signal.action !== "NO_TRADE" && !!signal.trade;
  const bias = signal.biasScore;

  return (
    <div className="flex h-full flex-col">
      {topBar}
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5 min-h-0">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-sky-600 text-white">
          <Bot className="h-3 w-3 mr-1" /> JARVIS LIVE
        </Badge>
        <Badge variant="outline">{signal.instrument}</Badge>
        <span className="text-sm font-bold tabular-nums">₹{signal.spot.toLocaleString("en-IN")}</span>
        <Badge variant="outline" className="text-[9px]">expiry {signal.trade?.expiry || "—"}</Badge>
        <span className="text-[9px] text-muted-foreground">updated {ageLabel(signal.timestampIso)}</span>
        <span className="flex-1" />
        {source === "worker-cache" ? (
          <Badge className="bg-emerald-600/90 text-white text-[9px]">● LIVE · worker cache</Badge>
        ) : (
          <Badge className="bg-amber-600/90 text-white text-[9px]" title="Worker cache was stale (>70s) — this was recomputed on read. Check `journalctl --user -u jarvis` if it persists.">
            ⚠ RECOMPUTED · worker may be down
          </Badge>
        )}
        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={load}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {/* ── Action + bias + strategy ── */}
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2 mb-2.5">
            <Badge className={`${ACTION_STYLE[signal.action] || "bg-slate-600 text-white"} text-xs px-2.5 py-1`}>
              {signal.action === "NO_TRADE" ? "NO TRADE" : `BUY ${signal.trade?.strike} ${signal.trade?.optionType}`}
            </Badge>
            <Badge variant="outline" className={bias > 0 ? "text-emerald-500 border-emerald-500/50" : bias < 0 ? "text-red-500 border-red-500/50" : ""}>
              bias {bias > 0 ? "+" : ""}{bias}/100
            </Badge>
            <Badge variant="outline">confidence {signal.confidence}</Badge>
            {signal.strategy && (
              <Badge className="bg-violet-600/90 text-white" title={signal.strategyName || ""}>
                {signal.strategy} · {signal.strategyName}
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px]">
              {signal.groupsAgreeing}/9 groups agreeing
            </Badge>
          </div>
          <BiasGauge bias={bias} />
          <div className="mt-2 text-[9px] text-muted-foreground">
            data {signal.dataFreshnessMinutes}m old · computed {timeLabel(signal.timestampIso)} IST
          </div>
        </CardContent>
      </Card>

      {/* ── Trade plan OR gates ── */}
      {isTrade && signal.trade ? (
        <Card className="border-emerald-600/40">
          <CardHeader className="pb-1 pt-2.5">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" /> TRADE PLAN — {signal.trade.strike} {signal.trade.optionType} ({signal.trade.expiry})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
              <div><span className="text-muted-foreground">Entry</span><div className="font-bold tabular-nums">₹{signal.trade.entryZone[0]} – ₹{signal.trade.entryZone[1]}</div></div>
              <div><span className="text-muted-foreground">Stop loss</span><div className="font-bold tabular-nums text-red-500">₹{signal.trade.stopLossPremium}</div></div>
              <div><span className="text-muted-foreground">TP1</span><div className="font-bold tabular-nums text-emerald-500">₹{signal.trade.tp1Premium}</div></div>
              <div><span className="text-muted-foreground">TP2</span><div className="font-bold tabular-nums text-emerald-500">₹{signal.trade.tp2Premium}</div></div>
              <div><span className="text-muted-foreground">R:R (TP1)</span><div className="font-bold tabular-nums">{signal.trade.riskRewardTp1}</div></div>
              <div><span className="text-muted-foreground">Spot invalidation</span><div className="font-bold tabular-nums">{signal.trade.underlyingInvalidation}</div></div>
              <div><span className="text-muted-foreground">Targets (spot)</span><div className="font-bold tabular-nums">{signal.trade.underlyingTargets.join(" → ")}</div></div>
              <div><span className="text-muted-foreground">Time stop</span><div className="font-bold tabular-nums">{timeLabel(signal.trade.timeStopIso)} IST</div></div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-amber-600/50">
          <CardHeader className="pb-1 pt-2.5">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" /> NO TRADE — blocking gates
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1 space-y-1">
            {(signal.gatesFailed.length ? signal.gatesFailed : ["conditions not met"]).map((g, i) => (
              <div key={i} className="text-[11px] flex items-start gap-1.5">
                <span className="text-amber-500 mt-px">▪</span> {g}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Component scores (9 groups; stubs visibly N/A) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <Card>
          <CardHeader className="pb-1 pt-2.5">
            <CardTitle className="text-xs">Component scores</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1 space-y-1.5">
            {SCORE_META.map(({ key, label, max }) => {
              const stub = STUBBED_KEYS.includes(key);
              const v = signal.componentScores[key] ?? 0;
              return (
                <div key={key} className={`flex items-center gap-2 ${stub ? "opacity-50" : ""}`}>
                  <span className={`w-28 shrink-0 text-[10px] ${stub ? "text-muted-foreground/70" : ""}`}>{label}</span>
                  <div className="flex-1"><ScoreBar value={v} max={max} stub={stub} /></div>
                  <span className={`w-12 text-right text-[10px] tabular-nums ${stub ? "text-muted-foreground/70" : v > 0 ? "text-emerald-500" : v < 0 ? "text-red-500" : ""}`}>
                    {stub ? "N/A" : `${v > 0 ? "+" : ""}${v}`}
                  </span>
                </div>
              );
            })}
            <div className="text-[8px] text-muted-foreground/70 pt-1 border-t border-border/50">
              OI Spurts / Pre-open / Breadth / 52-Week: not yet wired to a feed — shown as N/A, scored 0 by the engine.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-2.5">
            <CardTitle className="text-xs">Greeks &amp; levels</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1">
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div><span className="text-muted-foreground">ATM IV</span><div className="font-bold tabular-nums">{signal.greeks ? `${signal.greeks.atmIv.toFixed(1)}%` : "—"}</div></div>
              <div><span className="text-muted-foreground">Skew (P−C)</span><div className="font-bold tabular-nums">{signal.greeks?.skewPutMinusCall ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Gamma flip</span><div className="font-bold tabular-nums">{signal.greeks?.gammaFlip ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Regime</span><div className="font-bold">{signal.greeks?.regime ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Exp move ±1σ</span><div className="font-bold tabular-nums">{signal.greeks?.expectedMove1Sigma ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Hours to exp</span><div className="font-bold tabular-nums">{signal.greeks?.hoursToExpiry ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Support</span><div className="font-bold tabular-nums">{signal.keyLevels.support ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Resistance</span><div className="font-bold tabular-nums">{signal.keyLevels.resistance ?? "—"}</div></div>
              <div><span className="text-muted-foreground">Max pain</span><div className="font-bold tabular-nums">{signal.keyLevels.maxPain ?? "—"}</div></div>
              <div><span className="text-muted-foreground">PCR</span><div className="font-bold tabular-nums">{signal.keyLevels.pcr ?? "—"}</div></div>
              <div className="col-span-2"><span className="text-muted-foreground">Confluence zone</span>
                <div className="font-bold tabular-nums">{signal.confluenceZone ? `${signal.confluenceZone[0]} – ${signal.confluenceZone[1]}` : "—"}</div>
              </div>
            </div>
            {signal.levelsUsed.length > 0 && (
              <div className="mt-2 text-[9px] text-muted-foreground">Levels at spot: {signal.levelsUsed.join(", ")}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Reasons ── */}
      {signal.reasons.length > 0 && (
        <Card>
          <CardHeader className="pb-1 pt-2.5">
            <CardTitle className="text-xs">Engine reasons</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1 space-y-1">
            {signal.reasons.map((r, i) => (
              <div key={i} className="text-[11px] flex items-start gap-1.5"><span className="text-sky-500 mt-px">▪</span> {r}</div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── History ── */}
      <Card>
        <CardHeader className="pb-1 pt-2.5">
          <CardTitle className="text-xs">Signal history (worker)</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-1">
          {(data.history || []).length === 0 ? (
            <div className="text-[10px] text-muted-foreground">No cached signals yet — worker writes one per cycle during market hours.</div>
          ) : (
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-muted-foreground text-left border-b border-border/50">
                  <th className="py-1 font-medium">Time</th>
                  <th className="font-medium">Action</th>
                  <th className="font-medium text-right">Bias</th>
                  <th className="font-medium">Conf</th>
                  <th className="font-medium">Strat</th>
                  <th className="font-medium text-right">Gates</th>
                </tr>
              </thead>
              <tbody>
                {(data.history || []).map((h, i) => (
                  <tr key={`${h.timestampIso}-${i}`} className="border-b border-border/30">
                    <td className="py-1 tabular-nums">{timeLabel(h.timestampIso)}</td>
                    <td>
                      <span className={h.action === "NO_TRADE" ? "text-muted-foreground" : h.action === "BUY_CE" ? "text-emerald-500" : "text-red-500"}>
                        {h.action === "NO_TRADE" ? "NO TRADE" : h.action}
                      </span>
                    </td>
                    <td className={`text-right tabular-nums ${h.biasScore > 0 ? "text-emerald-500" : h.biasScore < 0 ? "text-red-500" : ""}`}>
                      {h.biasScore > 0 ? "+" : ""}{h.biasScore}
                    </td>
                    <td>{h.confidence}</td>
                    <td>{h.strategy || "—"}</td>
                    <td className="text-right tabular-nums">{h.gatesFailed.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="text-[9px] text-muted-foreground pb-2">{signal.disclaimer}</div>
      <span className="hidden">{now}</span>
      </div>
    </div>
  );
}
