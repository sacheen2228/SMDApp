"use client";

// Pre-Market Data Science Lab — independent research dashboard.
// Read-only. Never places or authorizes trades.

import { useEffect, useState, useCallback } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "RELIANCE"];

interface LabState {
  coverage: any;
  latestScore: any;
  liveScore: any;
  studyDays: any[];
  models?: any[];
  features?: any[];
}

export default function PreMarketLab() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [data, setData] = useState<LabState | null>(null);
  const [compare, setCompare] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(async (opts: { collect?: boolean; score?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ symbol, features: "1", models: "1" });
      if (opts.collect) qs.set("collect", "1");
      if (opts.score) qs.set("score", "1");
      const res = await fetch(`/api/premarket-lab?${qs.toString()}`);
      const j = await res.json();
      if (!j.success) throw new Error(j.error || "load failed");
      setData(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  const runCompare = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/premarket-lab/compare?target=gap_continuation&model=logistic`);
      const j = await res.json();
      setCompare(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load({ score: true });
  }, [load]);

  const doCollect = async () => {
    setCollecting(true);
    await load({ collect: true });
    setCollecting(false);
  };

  const score = data?.liveScore || data?.latestScore;
  const cov = data?.coverage;

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pre-Market Data Science Lab</h1>
          <p className="text-sm text-muted-foreground">
            Research engine · CM + F&O pre-open · Not trade authorization · BUY CE/PE only under SDM gates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onValueChange={setSymbol}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SYMBOLS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => load({ score: true })} disabled={loading}>
            Refresh
          </Button>
          <Button onClick={doCollect} disabled={collecting || loading}>
            {collecting ? "Collecting…" : "Collect snapshot"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Freshness / quality / coverage */}
      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Coverage</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>CM days: <b>{cov?.cmDays ?? "—"}</b></div>
            <div>F&O days: <b>{cov?.fnoDays ?? "—"}</b></div>
            <div>Study days: <b>{cov?.studyDays ?? "—"}</b></div>
            <div className="text-xs text-muted-foreground">
              CM range: {cov?.cmRange ? cov.cmRange.join(" → ") : "none"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Data quality</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>Overall: <Badge variant={score?.quality?.overall === "OK" ? "default" : "secondary"}>
              {score?.quality?.overall || "—"}
            </Badge></div>
            <div>Quality score: <b>{score?.quality?.score ?? "—"}</b>/100</div>
            <div className="text-xs text-muted-foreground">Not a trade score</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Combined quant score</CardTitle></CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{score?.score ?? "—"}</div>
            <Badge className="mt-1" variant={
              score?.bias === "BULLISH" ? "default" :
              score?.bias === "BEARISH" ? "destructive" : "secondary"
            }>
              {score?.bias || "N/A"}
            </Badge>
            <p className="mt-2 text-xs text-muted-foreground">{score?.disclaimer}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Source scores (kept separate)</CardTitle></CardHeader>
          <CardContent className="text-sm grid grid-cols-2 gap-1">
            {(["cm", "fno", "options", "volatility", "breadth", "flow"] as const).map((k) => (
              <div key={k}>{k}: <b>{score?.sourceScores?.[k] ?? "—"}</b></div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Feature contributions */}
      <Card>
        <CardHeader>
          <CardTitle>Feature contributions</CardTitle>
          <CardDescription>Transparent weighted inputs — no black box</CardDescription>
        </CardHeader>
        <CardContent>
          {!score?.contributions?.length && <p className="text-sm text-muted-foreground">No score yet — collect a snapshot on a trading day.</p>}
          <div className="space-y-1">
            {(score?.contributions || []).map((c: any) => (
              <div key={c.key} className="flex items-center justify-between text-sm border-b py-1">
                <span>{c.label} <span className="text-xs text-muted-foreground">({c.source})</span></span>
                <span className="font-mono">
                  raw={c.raw ?? "—"} · norm={Number(c.normalized).toFixed(2)} · w={c.weight} · → {Number(c.weighted).toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Source panels */}
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">NIFTY futures pre-open</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <FutPanel data={data} sym="NIFTY" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">BANKNIFTY futures pre-open</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <FutPanel data={data} sym="BANKNIFTY" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">MIDCPNIFTY / FINNIFTY</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <FutPanel data={data} sym="MIDCPNIFTY" />
            <FutPanel data={data} sym="FINNIFTY" />
          </CardContent>
        </Card>
      </div>

      {/* Historical study days */}
      <Card>
        <CardHeader>
          <CardTitle>Historical scenario explorer</CardTitle>
          <CardDescription>Timestamped CM + F&O study days (fail-closed quality)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-72">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2">Symbol</th>
                  <th className="py-1 pr-2">CM pChange</th>
                  <th className="py-1 pr-2">F&O pChange</th>
                  <th className="py-1 pr-2">Basis %</th>
                  <th className="py-1 pr-2">Quality</th>
                  <th className="py-1">Open?</th>
                </tr>
              </thead>
              <tbody>
                {(data?.studyDays || []).map((d: any) => (
                  <tr key={`${d.tradeDate}-${d.symbol}`} className="border-t">
                    <td className="py-1 pr-2">{d.tradeDate}</td>
                    <td className="py-1 pr-2">{d.symbol}</td>
                    <td className="py-1 pr-2">{d.cmGap ?? "—"}</td>
                    <td className="py-1 pr-2">{d.fnoGap ?? "—"}</td>
                    <td className="py-1 pr-2">{d.basisPct ?? "—"}</td>
                    <td className="py-1 pr-2">{d.quality?.overall}</td>
                    <td className="py-1">{d.hasOpen ? "yes" : "pre"}</td>
                  </tr>
                ))}
                {!data?.studyDays?.length && (
                  <tr><td colSpan={7} className="py-3 text-muted-foreground">No snapshots yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Model comparison */}
      <Card>
        <CardHeader>
          <CardTitle>Model comparison (out-of-sample)</CardTitle>
          <CardDescription>CM-only · F&amp;O-only · CM+F&amp;O · full — chronological split</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={runCompare} disabled={loading}>
            Run comparison
          </Button>
          {compare && (
            <div className="text-sm">
              {!compare.sufficient ? (
                <p className="text-muted-foreground">{compare.message}</p>
              ) : (
                <table className="w-full">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1">Feature set</th>
                      <th className="py-1">nTest</th>
                      <th className="py-1">Precision</th>
                      <th className="py-1">Recall</th>
                      <th className="py-1">F1</th>
                      <th className="py-1">ROC-AUC</th>
                      <th className="py-1">Brier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(compare.comparison || []).map((c: any) => (
                      <tr key={c.featureSet} className="border-t">
                        <td className="py-1">{c.featureSet}</td>
                        <td className="py-1">{c.nTest}</td>
                        <td className="py-1">{fmt(c.metrics?.precision)}</td>
                        <td className="py-1">{fmt(c.metrics?.recall)}</td>
                        <td className="py-1">{fmt(c.metrics?.f1)}</td>
                        <td className="py-1">{fmt(c.metrics?.rocAuc)}</td>
                        <td className="py-1">{fmt(c.metrics?.brier)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {compare.walkForward?.mean && (
                <div className="mt-3 text-muted-foreground">
                  Walk-forward (CM+F&O, mean): F1={fmt(compare.walkForward.mean.f1)} ·
                  AUC={fmt(compare.walkForward.mean.rocAuc)} · Brier={fmt(compare.walkForward.mean.brier)} ·
                  folds={compare.walkForward.folds?.length}
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{compare.disclaimer}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Distributions / stats placeholders fed by study days */}
      <Card>
        <CardHeader>
          <CardTitle>Gap analytics</CardTitle>
          <CardDescription>Distribution from collected study days</CardDescription>
        </CardHeader>
        <CardContent>
          <GapStats days={data?.studyDays || []} />
        </CardContent>
      </Card>

      {/* Phase 11 — Quantitative Shadow Validation */}
      <ShadowSection symbol={symbol} />
    </div>
  );
}

function ShadowSection({ symbol }: { symbol: string }) {
  const [shadow, setShadow] = useState<any>(null);
  const [compare, setCompare] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadShadow = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/premarket-lab/shadow?action=list&symbol=${encodeURIComponent(symbol)}`);
      const j = await res.json();
      if (!j.success) throw new Error(j.error || "shadow load failed");
      setShadow(j);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [symbol]);

  const recordShadow = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/premarket-lab/shadow?action=record&symbol=${encodeURIComponent(symbol)}&sdm=1&options=1&research=1`,
      );
      const j = await res.json();
      if (!j.success) throw new Error(j.error || "record failed");
      await loadShadow();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [symbol, loadShadow]);

  const runShadowCompare = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/premarket-lab/shadow?action=compare&target=gap_continuation&model=logistic`);
      const j = await res.json();
      if (!j.success) throw new Error(j.error || "compare failed");
      setCompare(j);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    loadShadow();
  }, [loadShadow]);

  const cov = shadow?.coverage;
  const optSum = shadow?.optionSummary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shadow validation (Phase 11)</CardTitle>
        <CardDescription>
          Research-only · CM / F&amp;O / +MOAPI / full vs SDM · Wilson CIs · option sims on real bhavcopy
          · NOT VALIDATED without premium OHLC · never trade authorization
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={loadShadow} disabled={busy}>
            Refresh shadow
          </Button>
          <Button variant="outline" onClick={recordShadow} disabled={busy}>
            {busy ? "Working…" : "Record shadow session"}
          </Button>
          <Button variant="outline" onClick={runShadowCompare} disabled={busy}>
            Run OOS compare
          </Button>
        </div>
        {err && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4 text-sm">
          <div>Sessions: <b>{cov?.sessions ?? 0}</b></div>
          <div>With outcomes: <b>{cov?.withOutcomes ?? 0}</b></div>
          <div>
            Outcome status:{" "}
            <b>{cov?.pendingOutcomes ?? 0}</b> pending ·{" "}
            <b>{cov?.recordedOutcomes ?? 0}</b> recorded ·{" "}
            <b>{cov?.unavailableOutcomes ?? 0}</b> unavailable
          </div>
          <div>
            Option sim: <b>{cov?.optionSimValidated ?? 0}</b> validated ·{" "}
            <b>{cov?.optionSimNotValidated ?? 0}</b> NOT_VALIDATED
          </div>
        </div>
        {optSum && (
          <p className="text-xs text-muted-foreground">
            Option summary: {optSum.message}
            {optSum.winRate != null && ` · winRate=${(optSum.winRate * 100).toFixed(1)}% avgR=${optSum.avgR?.toFixed(3) ?? "—"}`}
          </p>
        )}

        <div className="overflow-auto max-h-64">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Symbol</th>
                <th className="py-1 pr-2">Lab score</th>
                <th className="py-1 pr-2">Bias</th>
                <th className="py-1 pr-2">SDM</th>
                <th className="py-1 pr-2">Outcome</th>
                <th className="py-1 pr-2">EOD label</th>
                <th className="py-1 pr-2">VIX</th>
                <th className="py-1">Option</th>
              </tr>
            </thead>
            <tbody>
              {(shadow?.sessions || []).map((s: any) => (
                <tr key={`${s.tradeDate}-${s.symbol}`} className="border-t">
                  <td className="py-1 pr-2">{s.tradeDate}</td>
                  <td className="py-1 pr-2">{s.symbol}</td>
                  <td className="py-1 pr-2">{s.labScore ?? "—"}</td>
                  <td className="py-1 pr-2">{s.labBias ?? "—"}</td>
                  <td className="py-1 pr-2">{s.sdm?.signal ?? "—"}</td>
                  <td className="py-1 pr-2">
                    {(s.outcomeStatus || "PENDING_OUTCOME") === "OUTCOME_RECORDED" ? "RECORDED" :
                     s.outcomeStatus === "OUTCOME_UNAVAILABLE" ? "UNAVAILABLE" : "PENDING"}
                  </td>
                  <td className="py-1 pr-2">{s.outcomes?.labelEod ?? "—"}</td>
                  <td className="py-1 pr-2">{s.research?.vix?.value ?? "—"}</td>
                  <td className="py-1">
                    {s.optionSimValidated == null ? "—" : s.optionSimValidated ? "OK" : "NOT_VALIDATED"}
                  </td>
                </tr>
              ))}
              {!shadow?.sessions?.length && (
                <tr>
                  <td colSpan={9} className="py-3 text-muted-foreground">
                    No shadow sessions yet — Record after a study day has open prints.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {compare && (
          <div className="text-sm space-y-2">
            <div className="font-medium">
              OOS compare · {compare.target} · n={compare.nLabeled}{" "}
              {!compare.sufficient && (
                <span className="text-muted-foreground">
                  (insufficient — need ≥ {compare.minN})
                </span>
              )}
            </div>
            {compare.sufficient && (
              <table className="w-full">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Feature set</th>
                    <th className="py-1">nTest</th>
                    <th className="py-1">Accuracy</th>
                    <th className="py-1">Wilson 95%</th>
                    <th className="py-1">AUC</th>
                    <th className="py-1">Signif. vs 50%</th>
                  </tr>
                </thead>
                <tbody>
                  {(compare.sources || []).map((c: any) => (
                    <tr key={c.featureSet} className="border-t">
                      <td className="py-1">{c.featureSet}</td>
                      <td className="py-1">{c.nTest}</td>
                      <td className="py-1">{fmt(c.accuracy?.accuracy)}</td>
                      <td className="py-1">
                        {c.accuracy?.ci?.lower != null
                          ? `${(c.accuracy.ci.lower * 100).toFixed(1)}–${(c.accuracy.ci.upper * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="py-1">{fmt(c.metrics?.rocAuc)}</td>
                      <td className="py-1">
                        {c.accuracy?.significantAt05 ? "yes" : c.accuracy ? "no" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {compare.sdm && (
              <p className="text-muted-foreground">
                SDM shadow: n={compare.sdm.n} ·{" "}
                {compare.sdm.accuracy?.accuracy != null
                  ? `acc=${(compare.sdm.accuracy.accuracy * 100).toFixed(1)}% · ${compare.sdm.message}`
                  : compare.sdm.note}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{compare.disclaimer}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FutPanel({ data, sym }: { data: LabState | null; sym: string }) {
  const d = data?.studyDays?.find((x) => x.symbol === sym);
  if (!d) return <p className="text-muted-foreground text-xs">No snapshot for {sym}</p>;
  return (
    <div className="space-y-1">
      <div>Gap pChange: <b>{d.cmGap ?? "—"}</b></div>
      <div>F&O pChange: <b>{d.fnoGap ?? "—"}</b></div>
      <div>Basis: <b>{d.basisPct ?? "—"}</b>%</div>
      <div>Quality: <Badge variant="outline">{d.quality?.overall}</Badge></div>
    </div>
  );
}

function GapStats({ days }: { days: any[] }) {
  const gaps = days.map((d) => d.cmGap).filter((g) => g != null && Number.isFinite(g)) as number[];
  if (gaps.length === 0) return <p className="text-sm text-muted-foreground">Collect snapshots to build distributions.</p>;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const ups = gaps.filter((g) => g > 0.05).length;
  const downs = gaps.filter((g) => g < -0.05).length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div>n = <b>{gaps.length}</b></div>
      <div>Mean gap = <b>{mean.toFixed(3)}%</b></div>
      <div>Median = <b>{median.toFixed(3)}%</b></div>
      <div>Up/Down freq = <b>{(ups / gaps.length).toFixed(2)}</b> / <b>{(downs / gaps.length).toFixed(2)}</b></div>
    </div>
  );
}

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(3);
}
