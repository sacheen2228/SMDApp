// ProResearchModal — Stage 2 deep research dossier view
// Renders the full 5-section research dossier for one shortlisted symbol
// with the BUY / WATCH / AVOID verdict from the Pro Mode engine.

"use client";

import { memo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Shield,
  Newspaper,
  Landmark,
  AlertTriangle,
  CheckCircle,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { ProResearchDossier } from "@/lib/weekly-pro-mode";

function fmtINR(n: number): string {
  if (n == null || isNaN(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function verdictBadge(verdict: string) {
  if (verdict === "BUY") return <Badge className="bg-emerald-600 text-white">BUY</Badge>;
  if (verdict === "WATCH") return <Badge className="bg-amber-600 text-white">WATCH</Badge>;
  return <Badge className="bg-red-600 text-white">AVOID</Badge>;
}

function SectionScore({ score, color }: { score: number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5 min-w-[70px]">
      <Progress value={score} className="h-1.5 w-10" indicatorClassName={color || (score >= 60 ? "bg-emerald-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500")} />
      <span className="text-[10px] font-bold tabular-nums">{score}</span>
    </div>
  );
}

function Section({ title, icon, score, children }: { title: string; icon: React.ReactNode; score: number; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-bold">
          {icon}
          {title}
        </div>
        <SectionScore score={score} />
      </div>
      {children}
    </div>
  );
}

export const ProResearchModal = memo(function ProResearchModal({
  dossier,
  open,
  onClose,
  loading,
}: {
  dossier: ProResearchDossier | null;
  open: boolean;
  onClose: () => void;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <DialogTitle className="sr-only">Deep Research in progress</DialogTitle>
            <Sparkles className="h-10 w-10 mb-3 animate-pulse text-violet-500" />
            <p className="text-sm font-medium">Running Stage 2 deep research...</p>
            <p className="text-xs mt-1">Fundamentals · news · institutional flow · risk</p>
          </div>
        ) : dossier ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center justify-between pr-6">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold">{dossier.symbol}</span>
                  <span className="text-xs text-muted-foreground">{dossier.name}</span>
                  <Badge variant="outline" className="text-[9px]">{dossier.sector}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground">Confidence {dossier.confidence}</span>
                  {verdictBadge(dossier.verdict)}
                </div>
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-3">
              {/* Verdict + why now */}
              <div className="bg-muted/30 rounded-lg p-3 text-[11px] space-y-1.5">
                <div className="flex items-start gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold text-emerald-500">Why this, why now:</span>{" "}
                    <span className="text-muted-foreground">{dossier.whyNow}</span>
                  </div>
                </div>
                <div className="flex items-start gap-1.5">
                  <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold text-red-500">Invalidates thesis:</span>{" "}
                    <span className="text-muted-foreground">{dossier.invalidates}</span>
                  </div>
                </div>
              </div>

              {/* Technical */}
              <Section title="Technical" icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />} score={dossier.technical.rvol >= 1.2 && dossier.technical.adx >= 20 ? Math.min(95, 50 + dossier.technical.rvol * 10 + dossier.technical.adx) : 45}>
                <div className="grid grid-cols-4 gap-2 text-[10px]">
                  <div className="text-center">
                    <div className="text-muted-foreground">Price</div>
                    <div className="font-bold">{fmtINR(dossier.technical.price)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">RSI</div>
                    <div className="font-bold">{dossier.technical.rsi.toFixed(0)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">RVOL</div>
                    <div className="font-bold">{dossier.technical.rvol.toFixed(1)}x</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">ADX</div>
                    <div className="font-bold">{dossier.technical.adx.toFixed(0)}</div>
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2 text-[10px] mt-2 pt-2 border-t">
                  <div className="text-center">
                    <div className="text-muted-foreground">Support</div>
                    <div className="font-bold text-emerald-500">{fmtINR(dossier.technical.support)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">Resistance</div>
                    <div className="font-bold text-red-500">{fmtINR(dossier.technical.resistance)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">Entry</div>
                    <div className="font-bold">{fmtINR(dossier.technical.entryZone.low)}–{fmtINR(dossier.technical.entryZone.high)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">SL</div>
                    <div className="font-bold text-red-500">{fmtINR(dossier.technical.stopLoss)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted-foreground">T1 / T2</div>
                    <div className="font-bold text-emerald-500">{fmtINR(dossier.technical.target1)} / {fmtINR(dossier.technical.target2)}</div>
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground mt-2">{dossier.technical.note} · R:R 1:{dossier.technical.riskReward.toFixed(1)} · Weekly {dossier.technical.weeklyTrend}</p>
              </Section>

              {/* Fundamental */}
              <Section title="Fundamental" icon={<Landmark className="h-3.5 w-3.5 text-blue-500" />} score={dossier.fundamental.score}>
                {dossier.fundamental.available ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-[10px]">
                      <div className="text-center">
                        <div className="text-muted-foreground">Revenue Growth</div>
                        <div className="font-bold">{dossier.fundamental.revenueGrowth != null ? (dossier.fundamental.revenueGrowth * 100).toFixed(1) + "%" : "—"}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-muted-foreground">Profit Margin</div>
                        <div className="font-bold">{dossier.fundamental.profitMargins != null ? (dossier.fundamental.profitMargins * 100).toFixed(1) + "%" : "—"}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-muted-foreground">P/E</div>
                        <div className="font-bold">{dossier.fundamental.trailingPE != null ? dossier.fundamental.trailingPE.toFixed(1) : "—"}</div>
                      </div>
                    </div>
                    <p className="text-[9px] text-muted-foreground mt-2">{dossier.fundamental.note}</p>
                    {dossier.fundamental.redFlags.length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {dossier.fundamental.redFlags.map((f, i) => (
                          <div key={i} className="text-[9px] text-amber-500 flex items-center gap-1">
                            <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> {f}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[10px] text-muted-foreground">{dossier.fundamental.note}</p>
                )}
              </Section>

              {/* News & sentiment */}
              <Section title="News & Sentiment" icon={<Newspaper className="h-3.5 w-3.5 text-orange-500" />} score={dossier.news.score}>
                <p className="text-[10px] text-muted-foreground mb-2">
                  <Badge className={`text-[8px] mr-1 ${dossier.news.label === "Positive" ? "bg-emerald-600" : dossier.news.label === "Negative" ? "bg-red-600" : "bg-gray-600"}`}>{dossier.news.label}</Badge>
                  {dossier.news.note}
                </p>
                {dossier.news.articles.length > 0 && (
                  <div className="space-y-1">
                    {dossier.news.articles.map((a, i) => (
                      <div key={i} className="text-[9px] flex items-start gap-1">
                        <span className={`mt-0.5 shrink-0 ${a.sentiment >= 0 ? "text-emerald-500" : "text-red-500"}`}>{a.sentiment >= 0 ? "▲" : "▼"}</span>
                        <span className="text-muted-foreground leading-relaxed">{a.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* Institutional */}
              <Section title="Institutional (FII/DII)" icon={<Landmark className="h-3.5 w-3.5 text-rose-500" />} score={dossier.institutional.score}>
                <p className="text-[10px] text-muted-foreground">{dossier.institutional.note}</p>
              </Section>

              {/* Risk */}
              <Section title="Risk Assessment" icon={<Shield className="h-3.5 w-3.5 text-amber-500" />} score={dossier.risk.score}>
                {dossier.risk.reasons.length > 0 ? (
                  <div className="space-y-0.5">
                    {dossier.risk.reasons.map((r, i) => (
                      <div key={i} className="text-[9px] text-amber-500 flex items-start gap-1">
                        <AlertTriangle className="h-2.5 w-2.5 mt-0.5 shrink-0" /> {r}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">{dossier.risk.note}</p>
                )}
              </Section>

              <Separator />
              <p className="text-[9px] text-muted-foreground leading-relaxed text-center">
                Educational/informational research only, not financial advice. Verify independently and consult a qualified advisor before trading.
                <br />
                Data: {dossier.dataSource} · {new Date(dossier.timestamp).toLocaleString("en-IN")}
              </p>
            </div>
          </>
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <DialogTitle className="sr-only">Deep Research unavailable</DialogTitle>
            No dossier data available.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
});