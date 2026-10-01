import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";

const ctx = await buildMarketIntelligenceContext();
console.log("stockQuotes:", ctx.stockQuotes.length);
console.log("first5:", ctx.stockQuotes.slice(0, 5).map((q: any) => `${q.symbol}:${q.price}:${q.changePercent}`).join(" "));
console.log("technicals keys:", Object.keys((ctx as any).technicals || {}).length);
console.log("fiiDii:", JSON.stringify(ctx.fiiDii)?.slice(0, 120));
try {
  const sigs = await analyzeStockFO(ctx, 20);
  console.log("signals:", sigs.length);
  console.log(sigs.slice(0, 5).map((s) => `${s.symbol}:${s.direction}:conf=${s.confidence}:prem=${s.premium}`).join("\n"));
} catch (e: any) {
  console.error("THREW:", e?.message || e);
}
process.exit(0);
