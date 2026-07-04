// NewsPanel — Market News Sentiment Dashboard
// Shows real-time news with sentiment scoring, stock-level and sector-level analysis

"use client";

import { useState, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  Newspaper,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  Clock,
  Zap,
  BarChart3,
  Brain,
} from "lucide-react";

interface NewsArticle {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: number;
  sentimentLabel: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  event: { type: string; sentimentBias: number; confidence: number };
  stockEntities: string[];
  sectorEntities: string[];
}

interface MarketSentiment {
  overall: number;
  label: string;
  topBullish: any[];
  topBearish: any[];
  sectorSentiment: Record<string, number>;
  articles: NewsArticle[];
  timestamp: string;
}

function getSentimentColor(label: string): string {
  switch (label) {
    case "BULLISH":
    case "STRONG_BULLISH":
    case "EXTREME_GREED":
    case "GREED":
      return "text-emerald-500";
    case "BEARISH":
    case "STRONG_BEARISH":
    case "EXTREME_FEAR":
    case "FEAR":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

function getSentimentBg(label: string): string {
  switch (label) {
    case "BULLISH":
    case "STRONG_BULLISH":
    case "EXTREME_GREED":
    case "GREED":
      return "bg-emerald-500/10 border-emerald-500/30";
    case "BEARISH":
    case "STRONG_BEARISH":
    case "EXTREME_FEAR":
    case "FEAR":
      return "bg-red-500/10 border-red-500/30";
    default:
      return "bg-muted/30 border-border";
  }
}

function getSentimentBadge(label: string): string {
  switch (label) {
    case "BULLISH":
    case "STRONG_BULLISH":
      return "bg-emerald-600 text-white";
    case "BEARISH":
    case "STRONG_BEARISH":
      return "bg-red-600 text-white";
    default:
      return "bg-yellow-600 text-white";
  }
}

function ArticleCard({ article }: { article: NewsArticle }) {
  const sentimentIcon =
    article.sentiment > 0.2 ? (
      <TrendingUp className="h-3 w-3 text-emerald-500" />
    ) : article.sentiment < -0.2 ? (
      <TrendingDown className="h-3 w-3 text-red-500" />
    ) : (
      <Minus className="h-3 w-3 text-muted-foreground" />
    );

  return (
    <Card className="hover:bg-muted/30 transition-colors">
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className="mt-0.5">{sentimentIcon}</div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium leading-tight line-clamp-2">
              {article.title}
            </p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <Badge className={`text-[8px] h-4 px-1 ${getSentimentBadge(article.sentimentLabel)}`}>
                {article.sentimentLabel}
              </Badge>
              <span className="text-[9px] text-muted-foreground">{article.source}</span>
              {article.stockEntities.length > 0 && (
                <span className="text-[8px] text-blue-400">
                  {article.stockEntities.slice(0, 3).join(", ")}
                </span>
              )}
              {article.event.type !== "UNKNOWN" && (
                <span className="text-[8px] text-amber-400">{article.event.type}</span>
              )}
            </div>
          </div>
          {article.url && (
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SentimentGauge({ score, label }: { score: number; label: string }) {
  return (
    <Card className={`border-2 ${getSentimentBg(label)}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-muted-foreground">Market Sentiment</span>
          <Badge className={getSentimentBadge(label)}>{label.replace("_", " ")}</Badge>
        </div>
        <div className="flex items-end gap-2">
          <span className="text-3xl font-bold tabular-nums">{score}</span>
          <span className="text-xs text-muted-foreground mb-1">/100</span>
        </div>
        <Progress value={score} className="h-2 mt-2" />
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>Extreme Fear</span>
          <span>Extreme Greed</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SectorSentimentBar({ sector, score }: { sector: string; score: number }) {
  const color =
    score >= 60 ? "bg-emerald-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-16 text-right text-muted-foreground">{sector}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${score}%` }} />
      </div>
      <span className="w-8 font-bold tabular-nums">{score}</span>
    </div>
  );
}

export const NewsPanel = memo(function NewsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading, refetch, isFetching } = useQuery<MarketSentiment>({
    queryKey: ["news"],
    queryFn: async () => {
      const res = await fetch("/api/news");
      if (!res.ok) throw new Error("News fetch failed");
      const json = await res.json();
      return json.data;
    },
    refetchInterval: 120000, // Refresh every 2 minutes
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Newspaper className="h-12 w-12 mb-4 animate-pulse text-primary" />
        <p className="text-lg font-medium">Fetching market news...</p>
        <p className="text-sm mt-1">Scanning 6 sources for Indian market news</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="h-12 w-12 mb-4 text-amber-500" />
        <p className="text-lg font-medium">No news data</p>
        <p className="text-sm mt-1">Click refresh to fetch news</p>
      </div>
    );
  }

  const sectorEntries = Object.entries(data.sectorSentiment || {})
    .sort((a, b) => b[1] - a[1]);

  // Filter articles for current symbol
  const symbolArticles = data.articles.filter(
    (a) =>
      a.stockEntities.includes(symbol) ||
      a.title.toLowerCase().includes(symbol.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
              <Newspaper className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold">Market News</h2>
              <p className="text-[10px] text-muted-foreground">
                {data.articles.length} articles from 6 sources
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] gap-1"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Sentiment Gauge */}
        <SentimentGauge score={data.overall} label={data.label} />

        {/* Top Bullish / Bearish */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="border-emerald-500/30">
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-[10px] font-bold text-emerald-500 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Top Bullish
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-1">
              {data.topBullish.length > 0 ? (
                data.topBullish.map((s) => (
                  <div key={s.symbol} className="flex justify-between text-[10px]">
                    <span className="font-bold">{s.symbol}</span>
                    <span className="text-emerald-500">{s.score}/100</span>
                  </div>
                ))
              ) : (
                <p className="text-[9px] text-muted-foreground">No strong signals</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-red-500/30">
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-[10px] font-bold text-red-500 flex items-center gap-1">
                <TrendingDown className="h-3 w-3" /> Top Bearish
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-1">
              {data.topBearish.length > 0 ? (
                data.topBearish.map((s) => (
                  <div key={s.symbol} className="flex justify-between text-[10px]">
                    <span className="font-bold">{s.symbol}</span>
                    <span className="text-red-500">{s.score}/100</span>
                  </div>
                ))
              ) : (
                <p className="text-[9px] text-muted-foreground">No strong signals</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sector Sentiment */}
        {sectorEntries.length > 0 && (
          <Card>
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-xs font-bold flex items-center gap-1">
                <BarChart3 className="h-3 w-3" /> Sector Sentiment
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-1.5">
              {sectorEntries.slice(0, 10).map(([sector, score]) => (
                <SectorSentimentBar key={sector} sector={sector} score={score} />
              ))}
            </CardContent>
          </Card>
        )}

        {/* Stock-Specific News */}
        {symbolArticles.length > 0 && (
          <Card>
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-xs font-bold flex items-center gap-1">
                <Zap className="h-3 w-3" /> {symbol} News ({symbolArticles.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-2">
              {symbolArticles.slice(0, 5).map((article) => (
                <ArticleCard key={article.id} article={article} />
              ))}
            </CardContent>
          </Card>
        )}

        {/* All News */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-muted-foreground">
            All Market News ({data.articles.length})
          </h3>
          {data.articles.slice(0, 20).map((article) => (
            <ArticleCard key={article.id} article={article} />
          ))}
        </div>

        {/* Timestamp */}
        <div className="text-center text-[9px] text-muted-foreground pb-4">
          Last updated: {new Date(data.timestamp).toLocaleString("en-IN")}
        </div>
      </div>
    </div>
  );
});
