import { generateTradeRecommendation } from "@/lib/sdm-recommendation";
import type { SDMOptionStrike } from "@/types/sdm";

const ATM_STRIKE = 22900;
const SPOT = 22888.95;
const ATM_PREMIUM = 169.9;
const NIFTY_LOT = 65;

function makeChain(atmPremium: number = ATM_PREMIUM): SDMOptionStrike[] {
  const rows: SDMOptionStrike[] = [];
  for (let i = -10; i <= 10; i++) {
    const strike = ATM_STRIKE + i * 50;
    const d = Math.abs(strike - ATM_STRIKE) / 50;
    const ce = Math.max(2, atmPremium - d * 45);
    const pe = Math.max(2, atmPremium + d * 40);
    rows.push({
      strike,
      ce: { ltp: ce, bid: ce - 0.05, ask: ce + 0.05, oi: Math.max(20000, 120000 - d * 9000), oiChg: 15000, volume: 250000, iv: 13.5, delta: Math.max(0.02, Math.min(0.98, 0.55 - d * 0.05)), theta: -12, gamma: 0.0011, vega: 60 },
      pe: { ltp: pe, bid: pe - 0.05, ask: pe + 0.05, oi: Math.max(30000, 180000 - d * 12000), oiChg: 12000, volume: 230000, iv: 14.5, delta: Math.max(0.02, Math.min(0.98, 0.5 + d * 0.05)), theta: -11, gamma: 0.001, vega: 58 },
    });
  }
  return rows;
}

function makeCandles(n = 60): any[] {
  const out: any[] = [];
  let price = SPOT - 120;
  for (let i = 0; i < n; i++) {
    price += 2.2;
    out.push({ time: Date.now() - (n - i) * 300_000, open: price - 1.5, high: price + 3, low: price - 3, close: price, volume: 120_000 + (i % 7) * 9000 });
  }
  return out;
}

async function main() {
  const chain = makeChain();
  const expiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const rec = await generateTradeRecommendation(chain, SPOT, "NIFTY", expiry, { "5m": makeCandles() }, 14.7, "test", new Date().toISOString());
  console.log("direction:", rec.direction);
  console.log("strike:", rec.strike);
  console.log("entry:", rec.entry);
  console.log("sl:", rec.sl);
  console.log("positionSizing:", JSON.stringify(rec.positionSizing));
  console.log("lotSize:", rec.lotSize);
  console.log("lotSizeKnown:", rec.lotSizeKnown);
  console.log("reason:", rec.reason);
}
main();
