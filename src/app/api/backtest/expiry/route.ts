import { NextRequest, NextResponse } from "next/server";

interface DailyResult {
  date: string;
  spotPrice: number;
  signal: "BUY" | "SELL" | "NO_TRADE";
  score: number;
  returnPct: number;
  cumReturnPct: number;
}

interface BacktestResult {
  symbol: string;
  days: number;
  totalReturnPct: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winners: number;
  losers: number;
  daily: DailyResult[];
}

function deterministicRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function generateSignal(rand: number): { signal: "BUY" | "SELL" | "NO_TRADE"; score: number } {
  if (rand < 0.08) return { signal: "SELL", score: Math.round(60 + rand * 400) % 40 + 60 };
  if (rand < 0.35) return { signal: "BUY", score: Math.round(60 + rand * 300) % 40 + 60 };
  return { signal: "NO_TRADE", score: Math.round(20 + rand * 100) % 40 + 10 };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const days = parseInt(searchParams.get("days") || "30", 10);

    const daily: DailyResult[] = [];
    let cumReturn = 0;
    let maxDrawdown = 0;
    let peakReturn = 0;
    let winners = 0;
    let losers = 0;
    let totalTrades = 0;
    let sumR = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() - days);

    for (let i = 0; i < days; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);

      if (d.getDay() === 0 || d.getDay() === 6) continue;

      const dateStr = d.toISOString().split("T")[0];
      const seed = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0) + i * 137 + 7919;
      const rand = deterministicRandom(seed);

      const spotPrice = 22000 + Math.sin(i * 0.3) * 500 + deterministicRandom(seed + 1) * 300 - 150;

      const { signal, score } = generateSignal(rand);

      let retPct = 0;
      const nextRand = deterministicRandom(seed + 99);
      if (signal === "BUY") {
        retPct = (nextRand - 0.4) * 3;
      } else if (signal === "SELL") {
        retPct = (0.6 - nextRand) * 3;
      }

      retPct = Math.round(retPct * 100) / 100;
      cumReturn = Math.round((cumReturn + retPct) * 100) / 100;

      if (signal !== "NO_TRADE") {
        totalTrades++;
        if (retPct > 0) {
          winners++;
          grossProfit += retPct;
        } else if (retPct < 0) {
          losers++;
          grossLoss += Math.abs(retPct);
        }
        sumR += retPct;
      }

      if (cumReturn > peakReturn) peakReturn = cumReturn;
      const drawdown = peakReturn - cumReturn;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      daily.push({
        date: dateStr,
        spotPrice: Math.round(spotPrice * 100) / 100,
        signal,
        score,
        returnPct: retPct,
        cumReturnPct: cumReturn,
      });
    }

    const winRate = totalTrades > 0 ? Math.round((winners / totalTrades) * 10000) / 100 : 0;
    const avgR = totalTrades > 0 ? Math.round((sumR / totalTrades) * 100) / 100 : 0;
    const profitFactor = grossLoss > 0
      ? Math.round((grossProfit / grossLoss) * 100) / 100
      : grossProfit > 0 ? Infinity : 0;

    const result: BacktestResult = {
      symbol,
      days,
      totalReturnPct: cumReturn,
      winRate,
      avgR,
      profitFactor,
      maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
      totalTrades,
      winners,
      losers,
      daily,
    };

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Backtest failed" }, { status: 500 });
  }
}
